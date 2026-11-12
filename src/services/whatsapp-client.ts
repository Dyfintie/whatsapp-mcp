import * as fs from 'node:fs/promises';
import { constants, createReadStream, createWriteStream, writeFileSync, renameSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pino from 'pino';
import { HttpsProxyAgent } from 'https-proxy-agent';
import makeWASocket, { Browsers, downloadMediaMessage, generateMessageIDV2 } from '@whiskeysockets/baileys';
import { AuthStore } from './auth-store.js';
import { MessageStore, mediaMeta, stringify, type MessageQuery, type Outcome } from './message-store.js';
import { ServiceError, deadline, normalizeJid, phoneOf } from './errors.js';

export const AGENT_WATERMARK = "Message sent by 'Auto' (your assistant agent)";
export const AGENT_SIGNATURE = "~By Auto";
function withAttribution(text='', index=1) {
  if(index<=3) {
    if(text===AGENT_WATERMARK || text.startsWith(AGENT_WATERMARK+'\n\n'))return text;
    return AGENT_WATERMARK+(text?'\n\n'+text:'');
  }
  if(text===AGENT_SIGNATURE || text.endsWith('\n\n'+AGENT_SIGNATURE))return text;
  return text?text+'\n\n'+AGENT_SIGNATURE:AGENT_SIGNATURE;
}
function watermarkRequestId(requestId:string) {
  return 'auto-watermark:'+createHash('sha256').update(requestId).digest('hex');
}

export type ConnectionState = 'starting' | 'awaiting_pairing' | 'reconnecting' | 'connected' | 'logged_out' | 'failed';
export interface ConnectionStatus {
  connected: boolean; state: ConnectionState; phoneNumber?: string; qrCode?: string;
  error?: string; errorCode?: string; attemptId?: string; pairingExpiresAt?: string;
  generation: number; changedAt: string; lastDisconnectCode?: number; persistenceError?: string;
  failureDiagnostic?: { category:string; source:string; locations:string[] };
}
export type WhatsAppMessage = any;
export type WhatsAppChat = any;
export type WhatsAppMedia = NonNullable<ReturnType<typeof mediaMeta>>;
export interface ClientOptions {
  socketFactory?: (config: any) => any; reconnectBaseMs?: number; sendTimeoutMs?: number;
  download?: typeof downloadMediaMessage; transferRoot?: string;
}
const execAsync = promisify(execFile);
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_INLINE_BYTES = 4 * 1024 * 1024;

interface SendSlot { active:number; pending:number }

export class WhatsAppClient {
  private socket: any;
  private auth?: AuthStore;
  private generation = 0;
  private stopped = false;
  private connecting?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private pairingTimer?: NodeJS.Timeout;
  private pairingReady?: { generation:number; promise:Promise<void>; resolve:()=>void };
  private attempts = 0;
  private pairing?: { phone: string; promise: Promise<string>; expires: number };
  private callbacks: Array<(status: ConnectionStatus)=>void> = [];
  private inFlight = new Set<Promise<any>>();
  private sendSlots = new Set<SendSlot>();
  private transfers = 0;
  private events: Array<{at:string;state:ConnectionState;code?:number}> = [];
  private _status: ConnectionStatus = { connected:false,state:'starting',generation:0,changedAt:new Date().toISOString() };
  readonly transferRoot: string;
  // Sanitize protocol logs: never emit message envelopes, keys, credentials, or bodies.
  private logger = pino({ level:'warn' }, new Writable({ write(chunk, _enc, cb) {
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      try { const row=JSON.parse(line); process.stderr.write(JSON.stringify({level:row.level,time:row.time,msg:row.msg})+'\n'); }
      catch { process.stderr.write('[whatsapp] unstructured protocol diagnostic omitted\n'); }
    }
    cb();
  }}));
  constructor(readonly authDir: string, readonly store: MessageStore, private options: ClientOptions = {}) {
    this.transferRoot = options.transferRoot || process.env.WHATSAPP_TRANSFER_DIR || path.join('/dev/shm',`whatsapp-mcp-${process.getuid?.()}`);
  }
  get status() { return {...this._status}; }
  get isConnected() { return this._status.connected && !!this.socket; }
  diagnostics() { return { ...this.status, qrCode:undefined, events:this.events, engine:'baileys', protocolVersion:'bundled', source:'sqlite',
    unmatchedProtocolEvents:Number(this.store.db.prepare("SELECT COUNT(*) AS n FROM wa_receipts WHERE state='unmatched'").get()?.n || 0) }; }
  onConnection(cb: (status: ConnectionStatus)=>void) { this.callbacks.push(cb); }
  private notify(state: ConnectionState, extra: Partial<ConnectionStatus>={}) {
    this._status={state,connected:state==='connected',generation:this.generation,changedAt:new Date().toISOString(),
      persistenceError:this._status.persistenceError,...extra};
    this.events.push({at:this._status.changedAt,state,code:extra.lastDisconnectCode});
    if(this.events.length>100) this.events.shift();
    console.error(JSON.stringify({event:'connection',state,generation:this.generation,code:extra.lastDisconnectCode}));
    this.callbacks.forEach(cb=>cb(this.status));
  }
  connect(): Promise<void> {
    if(this.connecting) return this.connecting;
    if(this.socket || this.stopped) return Promise.resolve();
    this.connecting=this.openSocket().catch(e=>{
      this.notify('failed',{error:'Connection setup failed.',errorCode:e instanceof ServiceError?e.code:'CONNECTION_FAILED'});
      throw e;
    }).finally(()=>{this.connecting=undefined;});
    return this.connecting;
  }
  private async openSocket() {
    this.auth ||= new AuthStore(this.authDir);
    if(this.auth.terminalReason) {
      this.notify(this.auth.terminalReason==='LOGGED_OUT'?'logged_out':'failed',{errorCode:this.auth.terminalReason,error:'Explicit relinking is required.'});
      return;
    }
    await this.auth.flush();
    if(this.stopped) return;
    const gen=++this.generation;
    let ready!:()=>void;
    const readyPromise=new Promise<void>(resolve=>{ready=resolve;});
    this.pairingReady={generation:gen,promise:readyPromise,resolve:ready};
    const auth=this.auth;
    const current=()=>gen===this.generation && !this.stopped;
    const proxy=process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
    const agent=proxy?new HttpsProxyAgent(proxy):undefined;
    const sock=(this.options.socketFactory || makeWASocket)({
      browser:Browsers.macOS('Chrome'), auth:{creds:auth.state.creds,keys:{
        get:(type:any,ids:any)=>{if(!current()) throw new ServiceError('STALE_SOCKET','Socket superseded'); return auth.state.keys.get(type,ids);},
        set:(data:any)=>{if(!current()) throw new ServiceError('STALE_SOCKET','Socket superseded');
          try { return auth.state.keys.set(data); } catch(e) { this.persistenceFailure(e); throw e; }
        },
      }}, logger:this.logger, ...(agent?{agent,fetchAgent:agent}:{}),
      printQRInTerminal:false,generateHighQualityLinkPreview:false,syncFullHistory:false,
      connectTimeoutMs:30000,defaultQueryTimeoutMs:30000,markOnlineOnConnect:false,
      getMessage:async(key:any)=>{try{return this.store.raw(key.remoteJid,key.id).message;}catch{return undefined;}},
    });
    this.socket=sock;
    this.notify(auth.state.creds.registered?'reconnecting':'starting');
    const on=(event:string,fn:(value:any)=>void)=>sock.ev.on(event,(value:any)=>{
      if(!current()) return;
      try { fn(value); } catch(e) {
        // Never persist raw message events in plaintext diagnostics.
        this.persistenceFailure(e,event);
      }
    });
    on('creds.update',()=>auth.saveCreds());
    on('connection.update',(u:any)=>{
      if(u.qr && this.pairingReady?.generation===gen)this.pairingReady.resolve();
      if(u.connection==='close') {
        const code=u.lastDisconnect?.error?.output?.statusCode;
        this.socket=undefined;
        ++this.generation; // all subsequent events from this socket are stale
        this.clearTimers(); this.pairing=undefined;
        if(code===401) { auth.setTerminal('LOGGED_OUT'); this.notify('logged_out',{errorCode:'LOGGED_OUT',lastDisconnectCode:code,error:'WhatsApp removed the device. Relink explicitly.'}); return; }
        if(code===440) { auth.setTerminal('CONNECTION_REPLACED'); this.notify('failed',{errorCode:'CONNECTION_REPLACED',lastDisconnectCode:code,error:'Another connection replaced this socket. Automatic reconnect is stopped.'}); return; }
        // An unpaired socket timing out must not create an endless series of pairing attempts.
        if((!auth.state.creds.registered && code!==515) || ++this.attempts>8) {
          this.notify('failed',{errorCode:'RECONNECT_EXHAUSTED',lastDisconnectCode:code,error:'Connection attempts stopped. Inspect diagnostics and relink if needed.'}); return;
        }
        this.notify('reconnecting',{lastDisconnectCode:code});
        const delay=code===515 ? (this.options.reconnectBaseMs || 500) : Math.min(30000,(this.options.reconnectBaseMs || 1000)*2**(this.attempts-1));
        this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=undefined; void this.connect().catch(()=>{});},delay);
        return;
      }
      if(u.connection==='open') {
        this.clearTimers(); this.pairing=undefined;
        const jid=(sock.user?.id || '').replace(/:\d+@/,'@');
        this.notify('connected',{phoneNumber:phoneOf(jid) || undefined});
        this.stableTimer=setTimeout(()=>{if(current())this.attempts=0;},30000);
      } else if(u.qr && !this.pairing && !this.isConnected) {
        this.notify('awaiting_pairing',{qrCode:u.qr,attemptId:`socket-${gen}`,pairingExpiresAt:new Date(Date.now()+60000).toISOString()});
        clearTimeout(this.pairingTimer);
        this.pairingTimer=setTimeout(()=>{
          if(current() && !this.pairing && !this.isConnected) this.notify('awaiting_pairing',{attemptId:`socket-${gen}`});
        },60000);
      }
    });
    on('messages.upsert',({messages}:any)=>{ for(const m of messages) this.store.ingest(m); });
    on('messaging-history.set',({messages=[],contacts=[],chats=[]}:any)=>{
      for(const c of contacts)this.store.contact(c);
      for(const c of chats)if(c.id)this.store.chat(c.id,c.name);
      for(const m of messages)this.store.ingest(m);
    });
    on('contacts.upsert',(contacts:any[])=>contacts.forEach(c=>this.store.contact(c)));
    on('contacts.update',(contacts:any[])=>contacts.forEach(c=>this.store.contact(c)));
    on('chats.upsert',(chats:any[])=>chats.forEach(c=>this.store.chat(c.id,c.name)));
    on('chats.update',(chats:any[])=>chats.forEach(c=>this.store.chat(c.id,c.name)));
    on('groups.update',(groups:any[])=>groups.forEach(c=>this.store.chat(c.id,c.subject)));
    on('lid-mapping.update',({lid,pn}:any)=>this.store.mapping(lid,pn,'protocol'));
    on('messages.update',(updates:any[])=>updates.forEach(u=>this.store.update(u.key,u.update)));
    on('messages.delete',(u:any)=>{
      if(u.keys)u.keys.forEach((key:any)=>this.store.update(key,{message:null}));
      // Chat-wide history clearing is not a remote message revocation; retain the archive.
    });
    on('message-receipt.update',(updates:any[])=>updates.forEach(u=>this.store.receipt(u.key,u.receipt)));
  }
  private persistenceFailure(error:unknown,source='auth.keys') {
    const e=error as any;
    const category=typeof e?.code==='string' && /^[A-Z0-9_]{1,64}$/.test(e.code)?e.code:e instanceof TypeError?'TYPE_ERROR':'PERSISTENCE_FAILED';
    const locations=String(e?.stack || '').split('\n').slice(1,7).map(line=>line.match(/\/(?:dist|src)\/[^\s)]+:\d+:\d+/)?.[0]).filter((v):v is string=>Boolean(v));
    const failureDiagnostic={category,source,locations};
    this._status.persistenceError='PERSISTENCE_FAILED';
    console.error(JSON.stringify({event:'persistence_error',code:category,source,location:locations[0]}));
    const sock=this.socket; this.socket=undefined; ++this.generation;this.clearTimers();
    sock?.end(new Error('Persistence unavailable'));
    this.notify('failed',{errorCode:'PERSISTENCE_FAILED',error:'Persistence failed; sending and reconnect are stopped.',failureDiagnostic});
  }
  private clearTimers() {
    clearTimeout(this.reconnectTimer);clearTimeout(this.stableTimer);clearTimeout(this.pairingTimer);
    this.reconnectTimer=this.stableTimer=this.pairingTimer=undefined;
  }
  async requestPairingCode(phone: string): Promise<string> {
    if(!/^[1-9]\d{6,14}$/.test(phone))throw new ServiceError('INVALID_PHONE','Use country code and digits only.');
    if(this.isConnected || this.auth?.state.creds.registered)throw new ServiceError('ALREADY_LINKED','Use explicit relink to replace the current session.');
    if(this.pairing) {
      if(this.pairing.phone!==phone)throw new ServiceError('PAIRING_IN_PROGRESS','Another phone owns the current pairing attempt.');
      if(Date.now()>this.pairing.expires)throw new ServiceError('PAIRING_EXPIRED','The attempt expired. Relink explicitly to start another.');
      return this.pairing.promise;
    }
    const sock=this.socket,gen=this.generation;
    if(!sock)throw new ServiceError('SOCKET_NOT_READY','Check connection status before requesting a code.',true);
    const expires=Date.now()+180000;
    const promise=(async()=>{
      await deadline(sock.waitForSocketOpen(),30000);
      const ready=this.pairingReady;
      if(ready?.generation!==gen)throw new ServiceError('PAIRING_SUPERSEDED','The pairing socket closed.');
      // WebSocket open precedes WhatsApp authentication/QR handshake readiness.
      await deadline(ready.promise,30000,'PAIRING_NOT_READY');
      if(gen!==this.generation)throw new ServiceError('PAIRING_SUPERSEDED','The pairing socket closed.');
      const code=await deadline<string>(sock.requestPairingCode(phone),30000);
      if(gen!==this.generation)throw new ServiceError('PAIRING_SUPERSEDED','The pairing socket closed.');
      return code;
    })();
    this.pairing={phone,promise,expires};
    this.notify('awaiting_pairing',{attemptId:`phone-${gen}`,pairingExpiresAt:new Date(expires).toISOString()});
    clearTimeout(this.pairingTimer);
    this.pairingTimer=setTimeout(()=>{
      if(gen===this.generation && !this.isConnected)this.notify('awaiting_pairing',{errorCode:'PAIRING_EXPIRED',attemptId:`phone-${gen}`});
    },180000);
    return promise;
  }
  async relink(phone?:string) {
    if(this.inFlight.size)throw new ServiceError('OPERATIONS_PENDING','Wait for pending operations before relinking.');
    await this.disconnect(false);
    this.auth ||= new AuthStore(this.authDir);
    const backup=await this.auth.reset();
    this.stopped=false; this.attempts=0; this.pairing=undefined;
    await this.connect();
    const code=phone?await this.requestPairingCode(phone):undefined;
    return {backup,code,...this.status};
  }
  async disconnect(closeAuth=true) {
    this.stopped=true;this.clearTimers();this.pairing=undefined;
    const sock=this.socket;this.socket=undefined;++this.generation;
    sock?.end(new Error('Orderly shutdown')); // never logout on shutdown
    await this.connecting;
    await Promise.allSettled([...this.inFlight]);
    if(closeAuth) { await this.auth?.close(); this.auth=undefined; } else await this.auth?.flush();
    this.notify('failed',{errorCode:'STOPPED'});
  }
  private ensureConnected() {
    if(this._status.persistenceError)throw new ServiceError('PERSISTENCE_FAILED','Database persistence must recover before sending.');
    if(!this.isConnected)throw new ServiceError('NOT_CONNECTED','WhatsApp is not connected. Check status or relink.',false);
    return this.socket;
  }
  private async recipient(input:string):Promise<string> {
    const jid=this.store.canonical(normalizeJid(input));
    const sock=this.ensureConnected();
    if(jid.endsWith('@g.us')) { await deadline(sock.groupMetadata(jid),15000); return jid; }
    if(jid.endsWith('@lid')) {
      if(!this.store.db.prepare('SELECT 1 FROM wa_contacts WHERE jid=?').get(jid) && !this.store.db.prepare('SELECT 1 FROM chats WHERE chat_jid=?').get(jid))
        throw new ServiceError('UNVERIFIED_RECIPIENT','This LID is not known. Use a verified contact identifier.');
      return jid;
    }
    const matches=await deadline<any[]>(sock.onWhatsApp(jid),15000);
    const valid=matches?.filter(r=>r.exists);
    if(!valid?.length)throw new ServiceError('INVALID_RECIPIENT','WhatsApp did not verify this phone number.');
    if(valid.length!==1 || normalizeJid(valid[0].jid)!==jid)throw new ServiceError('AMBIGUOUS_RECIPIENT','WhatsApp returned a different or ambiguous recipient.');
    return jid;
  }
  private operationResult(op:any) {
    return {request_id:op.request_id,id:op.wa_id,timestamp:Date.parse(op.created_at)/1000,state:op.state,
      errorCode:op.error_code || undefined,deliveryConfirmed:['delivered','read'].includes(op.state),
      receiptScope:op.jid.endsWith('@g.us')?'at_least_one_recipient':'direct',retryable:false,
      ...(['audio','voice'].includes(op.kind) && this.store.operation(watermarkRequestId(op.request_id))
        ? {watermark_request_id:watermarkRequestId(op.request_id)} : {})};
  }
  private async send(chatId:string, fingerprint:string, kind:string, render:(index:number)=>{content:any;placeholder:any;prelude?:string}, requestId:string=randomUUID(), reservedAttributionIndex?:number, sharedSlot?:SendSlot) {
    if(!/^[\w.:-]{1,128}$/.test(requestId))throw new ServiceError('INVALID_REQUEST_ID','Use 1-128 letters, digits, dots, colons, underscores or hyphens.');
    const old=this.store.operation(requestId);
    if(old) {
      if(old.fingerprint!==fingerprint)throw new ServiceError('REQUEST_ID_CONFLICT','This request_id has different content.');
      return this.operationResult(old);
    }
    if(!sharedSlot && this.sendSlots.size>=4)throw new ServiceError('BUSY','Too many sends are in progress.',true);
    const slot=sharedSlot || {active:0,pending:0};
    this.sendSlots.add(slot);++slot.active;
    const release=()=>{if(!slot.active && !slot.pending)this.sendSlots.delete(slot);};
    try {
      const jid=await this.recipient(chatId),sock=this.ensureConnected(),waId=generateMessageIDV2(sock.user?.id);
      const key={remoteJid:jid,id:waId,fromMe:true},timestamp=Math.floor(Date.now()/1000);
      let raced:any,attributionIndex=reservedAttributionIndex;
      this.store.transaction(()=>{
        if(attributionIndex===undefined) {
          const reservation=this.store.reserveAttributedOperation(requestId,fingerprint,jid,waId,kind);
          raced=reservation.created?undefined:reservation.operation;
          attributionIndex=reservation.attributionIndex;
        } else raced=this.store.beginOperation(requestId,fingerprint,jid,waId,kind);
      });
      if(raced)return this.operationResult(raced);
      const rendered=render(attributionIndex!);
      const {content,placeholder,prelude}=rendered;
      if(prelude!==undefined) {
        // Audio/voice players do not reliably render captions. Attribute them in
        // a preceding text, with a durable child ID so retries never duplicate it.
        try {
          const intro=await this.sendMessage(jid,prelude,watermarkRequestId(requestId),attributionIndex,slot);
          if(['unknown','failed'].includes(intro.state))throw new ServiceError('WATERMARK_NOT_SUBMITTED','The attribution text could not be submitted.');
        } catch {
          this.store.operationState(requestId,'failed','WATERMARK_NOT_SUBMITTED');
          return this.operationResult(this.store.operation(requestId));
        }
      }
      try {this.store.ingest({key,message:placeholder,messageTimestamp:timestamp},'submitted');}
      catch(e){this.store.operationState(requestId,'failed','PERSISTENCE_FAILED');throw e;}
      // Register before dispatch; a timeout does not authorize another send. The promise
      // retains its slot and reconciles a late result. No background resend exists.
      const pending=Promise.resolve().then(()=>sock.sendMessage(jid,content,{messageId:waId,mediaUploadTimeoutMs:45000})).then((result:any)=>{
        if(!result?.key?.id || result.key.id!==waId) {
          this.store.operationState(requestId,'unknown','SEND_RESULT_MISSING');return;
        }
        this.store.ingest(result,'submitted');
      }).catch((_e:unknown)=>{this.store.operationState(requestId,'unknown','SEND_OUTCOME_UNKNOWN');});
      ++slot.pending;
      this.inFlight.add(pending);pending.finally(()=>{this.inFlight.delete(pending);--slot.pending;release();});
      try { await deadline(pending,this.options.sendTimeoutMs || 60000); }
      catch {this.store.operationState(requestId,'unknown','SEND_TIMEOUT');}
      return this.operationResult(this.store.operation(requestId));
    } finally {--slot.active;release();}
  }
  async sendMessage(chatId:string,text:string,requestId?:string,reservedAttributionIndex?:number,sharedSlot?:SendSlot) {
    if(!text || text.length>4096)throw new ServiceError('INVALID_TEXT','Text must contain 1-4096 characters.');
    const jid=normalizeJid(chatId);
    const fingerprint=createHash('sha256').update(JSON.stringify({jid,kind:'text',text})).digest('hex');
    return this.send(jid,fingerprint,'text',index=>{
      const outgoing=withAttribution(text,index);
      return {content:{text:outgoing},placeholder:{conversation:outgoing}};
    },requestId,reservedAttributionIndex,sharedSlot);
  }
  private async transfer<T>(work:()=>Promise<T>) {
    if(this.transfers>=2)throw new ServiceError('TRANSFER_BUSY','Two transfers are already active.',true);
    ++this.transfers;try{return await work();}finally{--this.transfers;}
  }
  async sendSynthesizedVoice(chatId:string,text:string,voice:'ryan'|'lessac',createAudio:()=>Promise<string>,requestId?:string) {
    const jid=normalizeJid(chatId);
    if(requestId!==undefined && !/^[\w.:-]{1,128}$/.test(requestId))throw new ServiceError('INVALID_REQUEST_ID','Invalid request_id.');
    const fingerprint=createHash('sha256').update(JSON.stringify({jid,kind:'synthesized-voice',text,voice})).digest('hex');
    const old=requestId?this.store.operation(requestId):undefined;
    if(old) {
      if(old.fingerprint!==fingerprint)throw new ServiceError('REQUEST_ID_CONFLICT','This request_id has different content.');
      return this.operationResult(old);
    }
    await this.recipient(jid);
    const file=await createAudio();
    return this.sendFileInternal(jid,file,{kind:'voice',request_id:requestId,fileName:'voice-note.wav',mimetype:'audio/wav'},fingerprint);
  }
  async sendFile(chatId:string,filePath:string,opts:{kind?:'document'|'image'|'video'|'audio'|'voice';caption?:string;mimetype?:string;fileName?:string;request_id?:string;gifPlayback?:boolean}={}) {
    return this.sendFileInternal(chatId,filePath,opts);
  }
  private async sendFileInternal(chatId:string,filePath:string,opts:{kind?:'document'|'image'|'video'|'audio'|'voice';caption?:string;mimetype?:string;fileName?:string;request_id?:string;gifPlayback?:boolean},semanticFingerprint?:string) {
    return this.transfer(async()=>{
      const jid=normalizeJid(chatId),kind=opts.kind || 'document';
      const source=await fs.realpath(filePath.startsWith('~/')?path.join(os.homedir(),filePath.slice(2)):path.resolve(filePath));
      const uploads=await fs.realpath(path.join(this.transferRoot,'uploads'));
      if(!source.startsWith(uploads+path.sep))throw new ServiceError('PATH_FORBIDDEN','Stage attachments inside the uploads directory.');
      const stat=await fs.stat(source);
      if(stat.nlink!==1)throw new ServiceError('PATH_FORBIDDEN','Hard-linked attachments are not allowed.');
      if(!stat.isFile() || stat.size>MAX_FILE_BYTES)throw new ServiceError('FILE_LIMIT','Send a regular file no larger than 50 MiB.');
      await fs.mkdir(this.transferRoot,{recursive:true,mode:0o700});
      const dir=await fs.mkdtemp(path.join(this.transferRoot,'send-'));
      let keepForPending=false;
      try {
        const snapshot=path.join(dir,'input');
        const hash=createHash('sha256');let bytes=0;
        const handle=await fs.open(source,constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened=await fs.realpath(`/proc/self/fd/${handle.fd}`);
          const openedStat=await handle.stat();
          if(!opened.startsWith(uploads+path.sep) || !openedStat.isFile() || openedStat.nlink!==1)
            throw new ServiceError('PATH_FORBIDDEN','Attachment changed outside uploads.');
        await pipeline(handle.createReadStream({autoClose:false}),new Transform({transform(chunk,_enc,cb){bytes+=chunk.length;
          if(bytes>MAX_FILE_BYTES){cb(new ServiceError('FILE_LIMIT','File exceeds 50 MiB.'));return;}hash.update(chunk);cb(null,chunk);}}),createWriteStream(snapshot,{flags:'wx',mode:0o600}));
        } finally {await handle.close();}
        const name=opts.fileName || path.basename(source);
        const mime=opts.mimetype || ({'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.gif':'image/gif','.txt':'text/plain','.ogg':'audio/ogg','.mp3':'audio/mpeg','.mp4':'video/mp4'} as Record<string,string>)[path.extname(source).toLowerCase()] || 'application/octet-stream';
        const fingerprint=semanticFingerprint || createHash('sha256').update(JSON.stringify({jid,kind,caption:opts.caption || '',mimetype:mime,fileName:name,sha256:hash.digest('hex'),...(opts.gifPlayback?{gifPlayback:true}:{})})).digest('hex');
        let audio=snapshot;
        if(kind==='voice') {
          audio=path.join(dir,'voice.ogg');
          await execAsync('ffmpeg',['-nostdin','-v','error','-i',snapshot,'-vn','-c:a','libopus','-b:a','64k','-n',audio],{timeout:60000,maxBuffer:100000});
          const {stdout}=await execAsync('ffprobe',['-v','error','-show_entries','stream=codec_name','-of','json',audio],{timeout:10000});
          if(JSON.parse(stdout).streams?.[0]?.codec_name!=='opus')throw new ServiceError('VOICE_CODEC','Converted audio is not Opus.');
        }
        const mediaBytes=kind==='voice'?(await fs.stat(audio)).size:bytes;
        const audioOnly=kind==='audio' || kind==='voice';
        const field=kind==='voice'?'audio':kind;
        const result=await this.send(jid,fingerprint,kind,index=>{
          const caption=audioOnly?undefined:withAttribution(opts.caption,index);
          const content:any=kind==='voice'?{audio:{url:audio},ptt:true,mimetype:'audio/ogg; codecs=opus'}:
            kind==='audio'?{audio:{url:snapshot},mimetype:mime,ptt:false}:
            {[kind]:{url:snapshot},mimetype:mime,fileName:name,caption,...(opts.gifPlayback?{gifPlayback:true}:{})};
          const placeholder={[`${field}Message`]:{mimetype:kind==='voice'?'audio/ogg; codecs=opus':mime,fileName:kind==='voice'?'voice-note.ogg':name,caption,fileLength:mediaBytes,ptt:kind==='voice',...(opts.gifPlayback?{gifPlayback:true}:{})}};
          return {content,placeholder,prelude:audioOnly?withAttribution(opts.caption || '',index):undefined};
        },opts.request_id);
        // An uncertain in-flight upload can still be reading its snapshot.
        if(this.inFlight.size) {keepForPending=true;void Promise.allSettled([...this.inFlight]).then(()=>fs.rm(dir,{recursive:true,force:true}));}
        return result;
      } finally {if(!keepForPending)await fs.rm(dir,{recursive:true,force:true});}
    });
  }
  async downloadMedia(chatId:string,messageId:string,outputDir?:string,maxBytes=MAX_FILE_BYTES) {
    return this.transfer(async()=>{
      const raw=this.store.raw(normalizeJid(chatId),messageId);
      const meta=mediaMeta(raw.message)!;
      if(meta.fileLength && meta.fileLength>maxBytes)throw new ServiceError('MEDIA_TOO_LARGE',`Media exceeds ${maxBytes} bytes. Use the download tool for larger files.`);
      const base=path.join(this.transferRoot,'downloads');
      await fs.mkdir(base,{recursive:true,mode:0o700});
      const realBase=await fs.realpath(base);
      const requested=outputDir?.startsWith('~/')?path.join(os.homedir(),outputDir.slice(2)):outputDir;
      const dir=requested?await fs.realpath(requested):realBase;
      if(dir!==realBase && !dir.startsWith(realBase+path.sep))throw new ServiceError('PATH_FORBIDDEN','output_dir must be inside the dedicated downloads directory.');
      const ext=({'application/pdf':'pdf','image/jpeg':'jpg','image/png':'png','audio/ogg':'ogg','video/mp4':'mp4'} as Record<string,string>)[meta.mimetype || ''] || 'bin';
      const name=(meta.fileName || `media.${ext}`).replace(/[^a-zA-Z0-9._-]/g,'_').slice(-120);
      const dest=path.join(dir,`${randomUUID()}-${name}`);let size=0;
      try {
        const sock=this.socket;
        const stream=await deadline((this.options.download || downloadMediaMessage)(raw,'stream', {options:{signal:AbortSignal.timeout(60000)}}, {
          logger:this.logger as any,reuploadRequest:async(m:any)=>{
            if(!this.isConnected || !sock)throw new ServiceError('NOT_CONNECTED','Media reupload requires a linked connection.');
            const updated=await sock.updateMediaMessage(m);this.store.ingest(updated);return updated;
          },
        }),45000);
        await pipeline(stream,new Transform({transform(chunk,_enc,cb){size+=chunk.length;
          if(size>maxBytes)cb(new ServiceError('MEDIA_TOO_LARGE',`Media exceeds ${maxBytes} bytes.`));else cb(null,chunk);}}),createWriteStream(dest,{flags:'wx',mode:0o600}),{signal:AbortSignal.timeout(60000)});
        return {path:dest,media:{...meta,fileName:name,fileLength:size}};
      } catch(e) {await fs.rm(dest,{force:true});if(e instanceof ServiceError)throw e;throw new ServiceError('MEDIA_UNAVAILABLE','Media download failed or expired. The stored envelope cannot guarantee remote availability.');}
    });
  }
  async getMedia(chatId:string,messageId:string,format:'base64'|'data_url'='base64') {
    const result=await this.downloadMedia(chatId,messageId,undefined,MAX_INLINE_BYTES);
    try {const base64=(await fs.readFile(result.path)).toString('base64');return {base64,media:result.media,
      ...(format==='data_url'?{data_url:`data:${result.media.mimetype || 'application/octet-stream'};base64,${base64}`}:{})};}
    finally {await fs.rm(result.path,{force:true});}
  }
  async getChats(limit=20,offset=0,query='') {return this.store.chats(limit,offset,query);}
  async listMessages(chatId?:string,limit=20,opts:MessageQuery={}) {return this.store.list({...opts,chat_id:chatId,limit});}
  async searchMessages(query:string,chatId?:string,limit=20,opts:MessageQuery={}) {return this.store.list({...opts,query,chat_id:chatId,limit});}
  async getContactName(jid:string) {return (this.store.chats(1,0,normalizeJid(jid))[0] as any)?.name || jid;}
  async getGroupInfo(groupId:string) {
    const id=normalizeJid(groupId);
    if(!id.endsWith('@g.us'))throw new ServiceError('INVALID_GROUP','Use a group JID.');
    const m=await deadline<any>(this.ensureConnected().groupMetadata(id),15000);
    return {id:m.id,subject:m.subject,description:m.desc || '',participants:m.participants.map((p:any)=>({id:p.id,admin:['admin','superadmin'].includes(p.admin)})),creation:m.creation || 0};
  }
  formatTimestamp(timestamp:number) {return new Date(timestamp*1000).toISOString();}
}
