import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { DatabaseSync } from '../dist/services/encrypted-db.js';
import { DatabaseSync as PlainDB } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { AuthStore } from '../dist/services/auth-store.js';
import { MessageStore, stringify } from '../dist/services/message-store.js';
import { WhatsAppClient, AGENT_WATERMARK } from '../dist/services/whatsapp-client.js';
import { createHash } from 'node:crypto';
import { acquireProcessLock } from '../dist/services/process-lock.js';
import { normalizeJid, phoneOf } from '../dist/services/errors.js';
import { createMcpServer } from '../dist/tools/register.js';
import { startHttpServer } from '../dist/http-server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initAuthCreds } from '@whiskeysockets/baileys';
const secrets=await fs.mkdtemp(path.join(os.tmpdir(),'wa-test-keys-'));
process.env.WHATSAPP_DB_KEY_FILE=path.join(secrets,'db.key');
process.env.WHATSAPP_API_TOKEN_FILE=path.join(secrets,'api.key');
const apiToken=randomBytes(32).toString('hex');
await fs.writeFile(process.env.WHATSAPP_DB_KEY_FILE,randomBytes(32).toString('hex'),{mode:0o600});
await fs.writeFile(process.env.WHATSAPP_API_TOKEN_FILE,apiToken,{mode:0o600});
const authOptions={requestInit:{headers:{Authorization:`Bearer ${apiToken}`}}};
const nativeFetch=globalThis.fetch;
const fetch=(url,opts={})=>nativeFetch(url,{...opts,headers:{Authorization:`Bearer ${apiToken}`,...opts.headers}});
process.on('exit',()=>{execFileSync('rm',['-rf',secrets]);});
const pn='15555550100@s.whatsapp.net';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const rawStatus=(url,headers)=>new Promise((resolve,reject)=>{const req=request(url,{headers},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
async function fixture(t,options={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-repair-test-'));
  const store=await MessageStore.open(path.join(dir,'messages.db'));
  const sockets=[];
  const factory=config=>{
    const sock={ev:new EventEmitter(),config,user:{id:'15555550100:1@s.whatsapp.net'},
      onWhatsApp:async jid=>[{jid,exists:true}], groupMetadata:async jid=>({id:jid,subject:'fixture',participants:[]}),
      sendMessage:async(jid,content,opts)=>({key:{remoteJid:jid,id:opts.messageId,fromMe:true},message:{conversation:content.text},messageTimestamp:100}),
      end(){this.ended=true;},waitForSocketOpen:async()=>{},requestPairingCode:async()=>{sock.codes=(sock.codes||0)+1;return 'TESTCODE';}};
    sockets.push(sock);if(!options.manualPairingReady)setTimeout(()=>sock.ev.emit('connection.update',{qr:'fixture-qr'}),0);return sock;
  };
  const client=new WhatsAppClient(path.join(dir,'auth'),store,{socketFactory:factory,reconnectBaseMs:5,transferRoot:path.join(dir,'transfers'),...options});
  t.after(async()=>{await client.disconnect();store.close();await fs.rm(dir,{recursive:true,force:true});});
  await fs.mkdir(path.join(client.transferRoot,'uploads'),{recursive:true,mode:0o700});
  await client.connect();
  return {dir,store,client,sockets,sock:sockets[0]};
}
const message=(id='one',extra={})=>({key:{id,remoteJid:pn,fromMe:false},messageTimestamp:100,message:{conversation:'unique searchable fixture'},pushName:'Fixture',...extra});
function close(sock,code) {sock.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:code}}}});}
function open(sock) {sock.ev.emit('connection.update',{connection:'open'});}

test('strict recipients reject names, malformed domains, punctuation and invented LID phones',()=>{
  for(const value of ['Contact123','+1 5555550100','123@evil','123','123@s.whatsapp.net','status@broadcast','15555550100:1@s.whatsapp.net'])assert.throws(()=>normalizeJid(value));
  assert.equal(normalizeJid('+15555550100'),pn);assert.equal(phoneOf('25585673842711@lid'),null);
});
test('process ownership is exclusive across processes and released on crash',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-lock-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'lock.sqlite');
  const child=spawn(process.execPath,['--input-type=module','-e',`import {acquireProcessLock} from './dist/services/process-lock.js';acquireProcessLock(${JSON.stringify(file)});console.log('locked');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe']});
  await new Promise(r=>child.stdout.once('data',r));assert.throws(()=>acquireProcessLock(file),/Another daemon/);
  child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));const release=acquireProcessLock(file);release();
});
test('encrypted auth buffers and key batches survive restart',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-auth-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const a=new AuthStore(dir);await a.state.keys.set({session:{'test:1':Buffer.from([1,2,3])},'pre-key':{'1':{public:Buffer.from([4]),private:Buffer.from([5])}}});
  a.state.creds.registered=true;a.saveCreds();await a.close();
  const b=new AuthStore(dir);assert.equal(b.state.creds.registered,true);assert.deepEqual((await b.state.keys.get('session',['test:1']))['test:1'],Buffer.from([1,2,3]));
  assert.equal((await fs.stat(path.join(dir,'auth.sqlite'))).mode & 0o777,0o600);
  const backed=await b.reset();assert.ok((await fs.stat(backed)).size>0);assert.equal(b.state.creds.registered,false);await b.close();
});
test('serialized connect, 515 restart, stale events and terminal 401',async t=>{
  const {client,sock,sockets,store}=await fixture(t);
  await Promise.all([client.connect(),client.connect()]);assert.equal(sockets.length,1);
  sock.config.auth.creds.registered=true;close(sock,515);assert.equal(client.status.connected,false);assert.equal(client.status.qrCode,undefined);
  await sleep(30);assert.equal(sockets.length,2);open(sockets[1]);assert.equal(client.status.state,'connected');
  open(sock);sock.ev.emit('messages.upsert',{messages:[message('stale')]});assert.equal(store.list().length,0);
  close(sockets[1],401);await sleep(25);assert.equal(sockets.length,2);assert.equal(client.status.state,'logged_out');
  await client.connect();assert.equal(sockets.length,2);
});
test('440 stops reconnect; ordinary shutdown does not logout',async t=>{
  const {client,sock,sockets}=await fixture(t);let logouts=0;sock.logout=()=>{++logouts;};
  open(sock);close(sock,440);await sleep(30);assert.equal(sockets.length,1);assert.equal(client.status.state,'failed');
  await client.disconnect();assert.equal(logouts,0);
});
test('transient disconnect reconnects with credentials and ignores stale keys',async t=>{
  const {client,sock,sockets}=await fixture(t);sock.config.auth.creds.registered=true;open(sock);close(sock,428);
  await sleep(30);assert.equal(sockets.length,2);assert.equal(sockets[1].config.auth.creds.registered,true);
  assert.throws(()=>sock.config.auth.keys.set({session:{bad:Buffer.from([1])}}),/superseded/);
});
test('concurrent phone codes share one attempt and reject competing phones',async t=>{
  const {client,sock}=await fixture(t);
  assert.deepEqual(await Promise.all([client.requestPairingCode('15555550100'),client.requestPairingCode('15555550100')]),['TESTCODE','TESTCODE']);
  assert.equal(sock.codes,1);await assert.rejects(client.requestPairingCode('919999999999'),e=>e.code==='PAIRING_IN_PROGRESS');
  close(sock,401);assert.equal(client.status.qrCode,undefined);assert.equal(client.status.pairingExpiresAt,undefined);
});
test('duplicate replay, history, edits, deletion and counters are transactional',async t=>{
  const {store,sock}=await fixture(t);
  sock.ev.emit('messages.upsert',{messages:[message(),message()]});
  sock.ev.emit('messaging-history.set',{messages:[message()]});
  assert.equal(store.list().length,1);assert.equal(store.chats()[0].total_messages,1);
  sock.ev.emit('messages.update',[{key:message().key,update:{message:{conversation:'edited fixture'}}}]);
  assert.equal(store.list({query:'edited'})[0].text,'edited fixture');assert.equal(store.list({query:'unique'}).length,0);
  sock.ev.emit('messages.delete',{keys:[message().key]});store.ingest(message());assert.equal(store.getMessage(pn,'one').type,'deleted');
  assert.equal(store.chats()[0].total_messages,1);
});
test('offline queries paginate and filter dates; unverified historical delivery is labeled',async t=>{
  const {store}=await fixture(t);store.ingest(message('early'));store.ingest({...message('late'),messageTimestamp:200});
  assert.equal(store.list({limit:1})[0].id,'late');assert.equal(store.list({limit:1,offset:1})[0].id,'early');
  assert.equal(store.list({before:'1970-01-01T00:02:30Z'}).length,1);assert.equal(store.getMessage(pn,'early').id,'early');
});
test('LID mappings from protocol reconcile later phone echoes without fabricated phone',async t=>{
  const {store}=await fixture(t);const lid='25585673842711@lid';
  store.ingest(message('lid',{key:{remoteJid:lid,id:'lid',fromMe:false}}));
  assert.equal(store.chats()[0].target_phone,null);
  store.mapping(lid,pn,'test-protocol');store.ingest(message('lid'));assert.equal(store.list().length,1);
});
test('missing send result is unknown, ledger survives restart, and no ID is invented as success',async t=>{
  const {client,sock,store,dir}=await fixture(t);open(sock);let calls=0;sock.sendMessage=async()=>{++calls;return undefined;};
  const result=await client.sendMessage(pn,'test','missing');assert.equal(result.state,'unknown');assert.notEqual(result.id,'unknown');assert.equal(result.deliveryConfirmed,false);
  const again=await client.sendMessage(pn,'test','missing');assert.equal(again.id,result.id);assert.equal(calls,1);
  await assert.rejects(client.sendMessage(pn,'different','missing'),e=>e.code==='REQUEST_ID_CONFLICT');
  const reopened=await MessageStore.open(path.join(dir,'messages.db'));assert.equal(reopened.operation('missing').state,'unknown');reopened.close();
});
test('concurrent identical send IDs dispatch once and outgoing echoes deduplicate',async t=>{
  const {client,sock,store}=await fixture(t);open(sock);let calls=0;
  sock.sendMessage=async(jid,c,o)=>{++calls;await sleep(10);return message(o.messageId,{key:{remoteJid:jid,id:o.messageId,fromMe:true},message:{conversation:c.text}});};
  const results=await Promise.all([client.sendMessage(pn,'concurrent','same'),client.sendMessage(pn,'concurrent','same')]);
  assert.equal(calls,1);assert.equal(results[0].id,results[1].id);assert.equal(store.list().length,1);assert.equal(store.chats()[0].total_messages,1);
  assert.equal(results[0].state,'submitted');assert.equal(results[0].deliveryConfirmed,false);
});
test('timeout never resends and a late receipt reconciles the durable operation',async t=>{
  const {client,sock,store}=await fixture(t,{sendTimeoutMs:5});open(sock);let resolve;
  sock.sendMessage=(_j,c,o)=>new Promise(r=>{resolve=()=>r(message(o.messageId,{key:{remoteJid:pn,id:o.messageId,fromMe:true},message:{conversation:c.text}}));});
  const result=await client.sendMessage(pn,'delayed','timeout');assert.equal(result.state,'unknown');
  const key={remoteJid:pn,id:result.id,fromMe:true};sock.ev.emit('message-receipt.update',[{key,receipt:{userJid:pn,readTimestamp:200}}]);
  resolve();await sleep(5);assert.equal(store.operation('timeout').state,'read');assert.equal(store.getMessage(pn,result.id).state,'read');
});
test('raw media survives reopen with complete base64 and PDF resource block',async t=>{
  const bytes=Buffer.from('%PDF-1.4\n'+'x'.repeat(2000));
  const {client,store,dir}=await fixture(t,{download:async(raw)=>{assert.deepEqual(raw.message.documentMessage.mediaKey,Buffer.from([1,2]));return Readable.from([bytes]);}});
  store.ingest(message('pdf',{message:{documentMessage:{mimetype:'application/pdf',fileName:'fixture.pdf',fileLength:bytes.length,mediaKey:Buffer.from([1,2]),directPath:'/fixture'}}}));
  const reopened=await MessageStore.open(path.join(dir,'messages.db'));assert.deepEqual(reopened.raw(pn,'pdf').message.documentMessage.mediaKey,Buffer.from([1,2]));reopened.close();
  const result=await client.getMedia(pn,'pdf');assert.deepEqual(Buffer.from(result.base64,'base64'),bytes);
  const server=createMcpServer(client);const sdk=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await sdk.connect(b);
  const tool=await sdk.callTool({name:'whatsapp_get_media',arguments:{chat_id:pn,message_id:'pdf',format:'data_url'}});
  assert.equal(tool.content[1].type,'resource');assert.equal(tool.content[1].resource.mimeType,'application/pdf');assert.equal(tool.content[1].resource.blob,result.base64);
  await sdk.close();await server.close();
});
test('media streaming limits remove partial files and unavailable historical media errors clearly',async t=>{
  const {client,store}=await fixture(t,{download:async()=>Readable.from([Buffer.alloc(2000)])});
  store.ingest(message('image',{message:{imageMessage:{mimetype:'image/png',directPath:'/fixture'}}}));
  await assert.rejects(client.downloadMedia(pn,'image',undefined,1000),e=>e.code==='MEDIA_TOO_LARGE');
  assert.equal((await fs.readdir(path.join(client.transferRoot,'downloads'))).length,0);
  await assert.rejects(client.getMedia(pn,'missing'),e=>e.code==='MEDIA_UNAVAILABLE');
});
test('voice conversion preserves neighboring file and verifies Opus for an OGG input too',async t=>{
  const {client,sock,dir}=await fixture(t);open(sock);
  const input=path.join(client.transferRoot,'uploads','voice.wav'),neighbor=path.join(dir,'voice.ogg');
  execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.05',input]);
  await fs.writeFile(neighbor,'KEEP');let codec;
  const dispatched=[];
  sock.sendMessage=async(jid,c,o)=>{dispatched.push(c);if(c.text)return message(o.messageId,{key:{remoteJid:jid,id:o.messageId,fromMe:true},message:{conversation:c.text}});codec=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name','-of','json',c.audio.url],{encoding:'utf8'})).streams[0].codec_name;
    return message(o.messageId,{key:{remoteJid:jid,id:o.messageId,fromMe:true},message:{audioMessage:{ptt:true,mimetype:c.mimetype}}});};
  await client.sendFile(pn,input,{kind:'voice',request_id:'voice'});assert.equal(codec,'opus');assert.equal(dispatched[0].text,AGENT_WATERMARK);assert.equal(dispatched[1].ptt,true);assert.equal(await fs.readFile(neighbor,'utf8'),'KEEP');assert.ok((await fs.stat(input)).size>0);
});
test('HTTP headers, simultaneous sessions, malformed inputs, transfer path and symlink restrictions',async t=>{
  const {client,dir}=await fixture(t);const http=await startHttpServer(client,{port:0,sessionTtlMs:500});t.after(()=>http.close());
  const base=`http://127.0.0.1:${http.port}`;
  for(const route of ['/mcp','/upload','/download','/healthz','/readyz']) {
    assert.equal(await rawStatus(base+route,{Host:'evil.example'}),403);
    assert.equal((await fetch(base+route,{headers:{Origin:'https://evil.example'}})).status,403);
  }
  assert.equal((await nativeFetch(base+'/healthz')).status,401);assert.equal((await fetch(base+'/healthz')).status,200);assert.equal((await fetch(base+'/readyz')).status,503);
  const a=new Client({name:'codex-fixture',version:'1'}),b=new Client({name:'antigravity-fixture',version:'1'});
  const ta=new StreamableHTTPClientTransport(new URL(base+'/mcp'),authOptions),tb=new StreamableHTTPClientTransport(new URL(base+'/mcp'),authOptions);
  await Promise.all([a.connect(ta),b.connect(tb)]);assert.notEqual(ta.sessionId,tb.sessionId);
  const results=await Promise.all([a.callTool({name:'whatsapp_list_messages',arguments:{}}),b.callTool({name:'whatsapp_get_status',arguments:{}})]);
  assert.equal(results[0].structuredContent.source,'sqlite');assert.equal(results[1].structuredContent.data.connected,false);
  assert.equal((await a.callTool({name:'whatsapp_list_messages',arguments:{limit:-1}})).isError,true);
  assert.equal((await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'{'})).status,400);
  const outside=path.join(dir,'secret');await fs.writeFile(outside,'SECRET');
  const link=path.join(client.transferRoot,'downloads','escape');await fs.symlink(outside,link);
  assert.equal((await fetch(base+'/download?path='+encodeURIComponent(link))).status,403);
  assert.equal((await fetch(base+'/download?path='+encodeURIComponent(outside))).status,403);
  const form=new FormData();form.set('file',new Blob(['test attachment']), 'test.txt');
  const upload=await fetch(base+'/upload',{method:'POST',body:form});assert.equal(upload.status,200);const info=await upload.json();
  assert.equal(await (await fetch(base+'/download?path='+encodeURIComponent(info.path))).text(),'test attachment');
  const old=ta.sessionId;await sleep(600);
  assert.equal((await fetch(base+'/mcp',{headers:{'mcp-session-id':old,accept:'text/event-stream'}})).status,404);
  await Promise.all([a.close(),b.close()]);
});

test('database contention is reported and ingestion rolls back without partial messages',async t=>{
  const {client,sock,store,dir}=await fixture(t);
  const other=new DatabaseSync(path.join(dir,'messages.db'));
  store.db.exec('PRAGMA busy_timeout=20');other.exec('BEGIN IMMEDIATE');
  sock.ev.emit('messages.upsert',{messages:[message('blocked')]});
  assert.equal(client.status.errorCode,'PERSISTENCE_FAILED');
  other.exec('ROLLBACK');other.close();assert.equal(store.list().length,0);assert.equal(store.chats().length,0);
});
test('historical row IDs and contents survive migration and FTS missing rows are repaired',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wa-migration-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'history.db');let s=await MessageStore.open(file);
  s.ingest(message('historical'));const row=s.db.prepare('SELECT * FROM messages').get();
  // Reproduce an external-content index that has lost entries without changing messages.
  s.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('delete-all'); DELETE FROM wa_migrations WHERE version=2");s.close();
  s=await MessageStore.open(file);assert.deepEqual(s.db.prepare('SELECT * FROM messages').get(),row);
  assert.equal(s.list({query:'searchable'}).length,1);assert.equal(s.db.prepare("SELECT value FROM wa_meta WHERE name='fts_rebuilt'").get().value,'true');
  assert.ok(s.migrationBackup);s.close();
});


test('phone code waits for WhatsApp handshake rather than only WebSocket open',async t=>{
  const {client,sock}=await fixture(t,{manualPairingReady:true});
  const pending=client.requestPairingCode('15555550100');
  await sleep(20);assert.equal(sock.codes,undefined);
  sock.ev.emit('connection.update',{qr:'ready-qr'});
  assert.equal(await pending,'TESTCODE');assert.equal(sock.codes,1);
});


test('dependency console cannot serialize Signal session secrets or private message bodies',async()=>{
  const {installConsoleGuard}=await import('../dist/services/console-guard.js');
  const lines=[];const restore=installConsoleGuard(line=>lines.push(line));
  try {
    console.info('Closing session:',{privateKey:'TEST-SECRET'});
    console.error('Session error: TEST-SECRET');
    console.error(JSON.stringify({event:'connection',state:'connected',privateKey:'TEST-SECRET'}));
  }finally{restore();}
  assert.equal(lines.length,3);assert.ok(!lines.join('').includes('TEST-SECRET'));
  assert.equal(JSON.parse(lines[2]).state,'connected');
});
test('contentless decryption stubs retain their complete raw envelope',async t=>{
  const {store}=await fixture(t);const msg=message('stub',{message:undefined,messageStubType:2,messageStubParameters:['No session found']});
  const id=store.ingest(msg);const row=store.db.prepare('SELECT raw FROM wa_protocol WHERE message_id=?').get(id);
  assert.equal(JSON.parse(row.raw).messageStubParameters[0],'No session found');
});


test('explicit MCP session termination releases capacity without waiting for TTL',async t=>{
  const {client}=await fixture(t);const http=await startHttpServer(client,{port:0});t.after(()=>http.close());
  const sdk=new Client({name:'termination-test',version:'1'});
  const transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`),authOptions);
  await sdk.connect(transport);assert.equal(http.sessions.size,1);
  await transport.terminateSession();assert.equal(http.sessions.size,0);await sdk.close();
});


test('a contentless duplicate cannot erase a previously decrypted message',async t=>{
  const {store}=await fixture(t);store.ingest(message('decrypted'));
  store.ingest(message('decrypted',{message:undefined,messageStubType:2}));
  assert.equal(store.getMessage(pn,'decrypted').text,'unique searchable fixture');
  const row=store.db.prepare("SELECT raw FROM wa_protocol WHERE wa_id='decrypted'").get();
  assert.equal(JSON.parse(row.raw).message.conversation,'unique searchable fixture');
});


test('failed events leave no plaintext reproducer and expose only safe diagnostics',async t=>{
  const {client,sock,store,dir}=await fixture(t);
  store.ingest=()=>{const error=new TypeError('private body TEST-SECRET');throw error;};
  sock.ev.emit('messages.upsert',{messages:[message('failed')]});
  assert.equal(client.status.failureDiagnostic.category,'TYPE_ERROR');
  assert.equal(client.status.failureDiagnostic.source,'messages.upsert');
  assert.ok(!JSON.stringify(client.status).includes('TEST-SECRET'));
  const file=path.join(dir,'auth','failed-event.json');
  await assert.rejects(fs.stat(file),e=>e.code==='ENOENT');
});


test('receipt updates missing a chat resolve only a unique stored identity',async t=>{
  const {client,sock,store}=await fixture(t);open(sock);
  const sent=await client.sendMessage(pn,'partial receipt','partial-receipt');
  sock.ev.emit('messages.update',[{key:{id:sent.id,fromMe:true},update:{status:3}}]);
  assert.equal(client.isConnected,true);assert.equal(store.operation('partial-receipt').state,'delivered');
});
test('unknown or ambiguous partial receipts are retained without stopping ingestion or fabricating delivery',async t=>{
  const {client,sock,store}=await fixture(t);open(sock);
  store.ingest(message('shared',{key:{id:'shared',remoteJid:pn,fromMe:true}}));
  store.ingest(message('shared',{key:{id:'shared',remoteJid:'919999999999@s.whatsapp.net',fromMe:true}}));
  sock.ev.emit('messages.update',[{key:{id:'shared',fromMe:true},update:{status:3}}]);
  sock.ev.emit('message-receipt.update',[{key:{id:'unknown'},receipt:{readTimestamp:100}}]);
  assert.equal(client.isConnected,true);assert.equal(client.diagnostics().unmatchedProtocolEvents,2);
  assert.equal(store.getMessage(pn,'shared').state,'submitted');
  assert.equal(store.getMessage('919999999999@s.whatsapp.net','shared').state,'submitted');
});


test('an incoming message reusing an outgoing ID cannot advance the outgoing operation',async t=>{
  const {client,sock,store}=await fixture(t);open(sock);
  const sent=await client.sendMessage(pn,'direction test','direction-test');
  store.ingest(message(sent.id));
  store.update({remoteJid:pn,id:sent.id,fromMe:false},{status:3});
  assert.equal(store.operation('direction-test').state,'submitted');
});


test('all text sends carry the exact attribution once, persist it, and deduplicate retries',async t=>{
  const {client,sock,store}=await fixture(t);open(sock);const sent=[];
  sock.sendMessage=async(jid,c,o)=>{sent.push(c);return message(o.messageId,{key:{remoteJid:jid,id:o.messageId,fromMe:true},message:{conversation:c.text}});};
  const result=await client.sendMessage(pn,'Hello','watermark-text');
  assert.equal(sent[0].text,"Message sent by 'Auto' (your assistant agent)\n\nHello");
  assert.equal(store.getMessage(pn,result.id).text,sent[0].text);
  await client.sendMessage(pn,'Hello','watermark-text');assert.equal(sent.length,1);
  await client.sendMessage(pn,AGENT_WATERMARK+'\n\nAlready attributed','watermark-preformatted');
  assert.equal(sent[1].text,AGENT_WATERMARK+'\n\nAlready attributed');
});
test('attribution changes after the first three agent sends per recipient and survives daemon restart',async t=>{
  const {client,sock,store,dir}=await fixture(t);open(sock);const sent=[];
  sock.sendMessage=async(jid,c,o)=>{sent.push(c);return message(o.messageId,{key:{remoteJid:jid,id:o.messageId,fromMe:true},message:{conversation:c.text}});};
  for(let i=1;i<=4;i++) await client.sendMessage(pn,`message ${i}`,`three-prefix-${i}`);
  assert.deepEqual(sent.map(x=>x.text),[
    `${AGENT_WATERMARK}\n\nmessage 1`,`${AGENT_WATERMARK}\n\nmessage 2`,`${AGENT_WATERMARK}\n\nmessage 3`,
    'message 4\n\n~By Auto'
  ]);
  const reopened=await MessageStore.open(store.file);
  // The durable per-recipient counter advances across process restarts.
  const reserved=reopened.reserveAttributedOperation('after-restart','fingerprint',pn,'wa-after-restart','text');
  assert.equal(reserved.attributionIndex,5);
  reopened.close();
});
test('document, image and video sends prepend attribution even without a caption',async t=>{
  const {client,sock,dir,store}=await fixture(t);open(sock);const source=path.join(client.transferRoot,'uploads','attachment.txt');await fs.writeFile(source,'fixture');
  const sent=[];sock.sendMessage=async(jid,c,o)=>{sent.push(c);const kind=['document','image','video'].find(k=>c[k]);
    return message(o.messageId,{key:{remoteJid:jid,id:o.messageId,fromMe:true},message:{[kind+'Message']:{caption:c.caption,mimetype:'text/plain'}}});};
  for(const kind of ['document','image','video']) {
    const result=await client.sendFile(pn,source,{kind,caption:'Attachment',request_id:'watermark-'+kind});
    assert.equal(sent.at(-1).caption,AGENT_WATERMARK+'\n\nAttachment');
    assert.equal(store.getMessage(pn,result.id).text,sent.at(-1).caption);
  }
  await client.sendFile(pn,source,{kind:'document',request_id:'watermark-no-caption'});
  assert.equal(sent.at(-1).caption,'~By Auto');
});
test('audio gets one durable attribution prelude before media, including its optional caption',async t=>{
  const {client,sock,dir,store}=await fixture(t);open(sock);const source=path.join(client.transferRoot,'uploads','audio.mp3');await fs.writeFile(source,'fixture');
  const sent=[];sock.sendMessage=async(jid,c,o)=>{sent.push(c);return message(o.messageId,{key:{remoteJid:jid,id:o.messageId,fromMe:true},message:c.text?{conversation:c.text}:{audioMessage:{mimetype:c.mimetype}}});};
  const opts={kind:'audio',caption:'Audio caption',request_id:'watermark-audio'};
  const result=await client.sendFile(pn,source,opts);
  assert.equal(sent.length,2);assert.equal(sent[0].text,AGENT_WATERMARK+'\n\nAudio caption');assert.ok(sent[1].audio);
  assert.ok(result.watermark_request_id);assert.equal(store.operation(result.watermark_request_id).kind,'text');
  await client.sendFile(pn,source,opts);assert.equal(sent.length,2);
});
test('uncertain attribution stops audio dispatch and returns a structured MCP failure',async t=>{
  const {client,sock,dir}=await fixture(t);open(sock);const source=path.join(client.transferRoot,'uploads','audio.mp3');await fs.writeFile(source,'fixture');
  const sent=[];sock.sendMessage=async(_jid,c)=>{sent.push(c);return undefined;};
  const server=createMcpServer(client),sdk=new Client({name:'watermark-failure-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await sdk.connect(b);
  try {
    const args={chat_id:pn,path:source,kind:'audio',request_id:'watermark-uncertain'};
    const result=await sdk.callTool({name:'whatsapp_send_file',arguments:args});
    assert.equal(result.isError,true);assert.equal(result.structuredContent.error.code,'WATERMARK_NOT_SUBMITTED');
    assert.ok(result.structuredContent.error.watermark_request_id);assert.equal(sent.length,1);assert.equal(sent[0].text,AGENT_WATERMARK);
    await sdk.callTool({name:'whatsapp_send_file',arguments:args});assert.equal(sent.length,1);
  }finally{await sdk.close();await server.close();}
});
test('pre-watermark operation IDs remain lookup-only on retry, with unchanged fingerprints',async t=>{
  const {client,sock,store}=await fixture(t);open(sock);let calls=0;sock.sendMessage=async()=>{++calls;};
  const fingerprint=createHash('sha256').update(JSON.stringify({jid:pn,kind:'text',text:'Historical'})).digest('hex');
  store.beginOperation('old-operation',fingerprint,pn,'original-id','text');store.operationState('old-operation','acknowledged');
  const result=await client.sendMessage(pn,'Historical','old-operation');
  assert.equal(result.id,'original-id');assert.equal(result.state,'acknowledged');assert.equal(calls,0);
});

test('schema guards reject invalid writes and message moves maintain aggregates',async t=>{
  const {store}=await fixture(t);
  const a=store.chat(pn), b=store.chat('919876543210@s.whatsapp.net');
  store.db.prepare("INSERT INTO messages(message_id,chat_id,is_from_me,message_type,timestamp_local) VALUES(999,?,0,'text','2026-01-01')").run(a.chat_id);
  store.db.prepare("UPDATE messages SET chat_id=?,timestamp_local='2026-02-01' WHERE message_id=999").run(b.chat_id);
  assert.equal(store.db.prepare('SELECT total_messages FROM chats WHERE chat_id=?').get(a.chat_id).total_messages,0);
  const row=store.db.prepare('SELECT total_messages,last_activity FROM chats WHERE chat_id=?').get(b.chat_id);
  assert.equal(row.total_messages,1);assert.equal(row.last_activity,'2026-02-01');
  assert.throws(()=>store.db.exec("UPDATE messages SET is_from_me=7 WHERE message_id=999"));
  assert.throws(()=>store.db.exec("INSERT INTO wa_contacts VALUES(NULL,'test','now')"));
  assert.throws(()=>store.db.prepare("INSERT INTO chats(chat_type,chat_jid) VALUES('direct',?)").run(pn));
  assert.throws(()=>store.db.exec("INSERT INTO wa_attribution_counts VALUES('test',-1)"));
  store.db.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)");
});

test('encrypted database, WAL and backup hide plaintext and reject a wrong key',async t=>{
  const {store,dir}=await fixture(t);
  const secret='PRIVATE-MESSAGE-CANARY-abcdef987654';
  store.ingest(message('encryption',{message:{conversation:secret}}));
  for(const file of [store.file,store.file+'-wal']) {
    const bytes=await fs.readFile(file);assert.equal(bytes.includes(Buffer.from(secret)),false);
    assert.notEqual(bytes.subarray(0,16).toString(),'SQLite format 3\0');
  }
  const plain=new PlainDB(store.file);assert.throws(()=>plain.prepare('SELECT * FROM messages').all());plain.close();
  const original=process.env.WHATSAPP_DB_KEY_FILE;
  const wrong=path.join(dir,'wrong.key');await fs.writeFile(wrong,'b'.repeat(64),{mode:0o600});
  process.env.WHATSAPP_DB_KEY_FILE=wrong;
  try{assert.throws(()=>new DatabaseSync(store.file));}finally{process.env.WHATSAPP_DB_KEY_FILE=original;}
  const backup=path.join(dir,'secure.bak');store.db.encryptedBackup(backup);
  const bytes=await fs.readFile(backup);assert.equal(bytes.subarray(0,8).toString(),'WAMCPBK1');assert.equal(bytes.includes(Buffer.from(secret)),false);
});

test('attachment sends reject files and symlinks outside uploads',async t=>{
  const {client,sock,dir}=await fixture(t);open(sock);
  const secret=path.join(dir,'private.key');await fs.writeFile(secret,'SECRET');
  await assert.rejects(client.sendFile(pn,secret),e=>e.code==='PATH_FORBIDDEN');
  const link=path.join(client.transferRoot,'uploads','escape');await fs.symlink(secret,link);
  await assert.rejects(client.sendFile(pn,link),e=>e.code==='PATH_FORBIDDEN');
});

test('encrypted backup restores without exposing a plaintext database',async t=>{
  const {store,dir}=await fixture(t);store.ingest(message('restore'));
  const backup=path.join(dir,'backup.bak'),target=path.join(dir,'restored.sqlite');
  store.db.encryptedBackup(backup);
  execFileSync(process.execPath,['scripts/restore-backup.mjs',backup,target]);
  const restored=new DatabaseSync(target);
  try {assert.equal(restored.prepare('SELECT count(*) n FROM messages').get().n,1);}finally{restored.close();}
  const plain=new PlainDB(target);try{assert.throws(()=>plain.prepare('SELECT * FROM messages').all());}finally{plain.close();}
});

test('documented setup, daemon and stdio bridge expose tools offline',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wa-quickstart-'));
  const transfers=await fs.mkdtemp('/dev/shm/wa-quickstart-');
  const env={...process.env,WHATSAPP_STATE_DIR:root,WHATSAPP_TRANSFER_DIR:transfers,WHATSAPP_HTTP_PORT:'0',WHATSAPP_OFFLINE:'true'};
  delete env.WHATSAPP_DB_KEY_FILE;delete env.WHATSAPP_API_TOKEN_FILE;
  execFileSync(process.execPath,['scripts/setup.mjs'],{env});
  const daemon=spawn(process.execPath,['scripts/run.mjs','--daemon'],{env,stdio:['ignore','ignore','pipe']});
  t.after(async()=>{if(daemon.exitCode===null && daemon.signalCode===null){const exited=new Promise(r=>daemon.once('exit',r));daemon.kill('SIGTERM');await exited;}await fs.rm(root,{recursive:true,force:true});await fs.rm(transfers,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Daemon startup timeout')),15000);let output='';
    daemon.once('exit',()=>{clearTimeout(timer);reject(new Error('Daemon exited during startup'));});
    daemon.stderr.on('data',chunk=>{output+=chunk;for(const line of output.split('\n')){try{const v=JSON.parse(line);if(v.event==='listening'){clearTimeout(timer);resolve(v.port);}}catch{}}});
  });
  const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport=new StdioClientTransport({command:process.execPath,args:['scripts/run.mjs'],env:{...env,WHATSAPP_MCP_URL:`http://127.0.0.1:${port}/mcp`},stderr:'pipe'});
  const client=new Client({name:'quickstart-test',version:'1'});
  try {await client.connect(transport);assert.equal((await client.listTools()).tools.length,15);}finally{await client.close();}
});
