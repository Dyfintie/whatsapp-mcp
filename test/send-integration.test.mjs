import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { MessageStore } from '../dist/services/message-store.js';
import { WhatsAppClient } from '../dist/services/whatsapp-client.js';

const secrets=await fs.mkdtemp(path.join(os.tmpdir(),'wa-send-test-keys-'));
process.env.WHATSAPP_DB_KEY_FILE=path.join(secrets,'db.key');
await fs.writeFile(process.env.WHATSAPP_DB_KEY_FILE,randomBytes(32).toString('hex'),{mode:0o600});
after(()=>fs.rm(secrets,{recursive:true,force:true}));

const jid='919222222222@s.whatsapp.net';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wa-send-integration-'));
  const store=await MessageStore.open(path.join(root,'messages.db'));
  const sent=[];
  const result=(target,content,options)=>({key:{remoteJid:target,id:options.messageId,fromMe:true},message:content.text?{conversation:content.text}:{audioMessage:{ptt:content.ptt}},messageTimestamp:100});
  const socket={ev:new EventEmitter(),user:{id:'919111111111:1@s.whatsapp.net'},end(){},onWhatsApp:async target=>[{exists:true,jid:target}],sendMessage:async(target,content,options)=>{sent.push(content);return result(target,content,options);}};
  const client=new WhatsAppClient(path.join(root,'auth'),store,{socketFactory:()=>socket,transferRoot:path.join(root,'transfers'),sendTimeoutMs:25});
  await fs.mkdir(path.join(client.transferRoot,'uploads'),{recursive:true,mode:0o700});
  await client.connect();socket.ev.emit('connection.update',{connection:'open'});
  t.after(async()=>{await client.disconnect();store.close();await fs.rm(root,{recursive:true,force:true});});
  return {client,socket,store,root,sent,result};
}

test('send admission reserves four slots before recipient verification',async t=>{
  const f=await fixture(t),gate=deferred();let lookups=0;
  f.socket.onWhatsApp=async target=>{++lookups;await gate.promise;return [{exists:true,jid:target}];};
  t.after(()=>gate.resolve());
  const sends=Array.from({length:8},(_,i)=>f.client.sendMessage(jid,'parallel','admission-'+i).then(value=>({value}),error=>({error})));
  await turn();assert.equal(lookups,4);gate.resolve();
  const results=await Promise.all(sends);
  assert.equal(results.filter(r=>r.error?.code==='BUSY').length,4);assert.equal(f.sent.length,4);
  assert.equal((await f.client.sendMessage(jid,'released','after-admission')).state,'submitted');
});

test('recipient failures release reserved capacity',async t=>{
  const f=await fixture(t);
  f.socket.onWhatsApp=async()=>{throw new Error('lookup failed');};
  await Promise.all(Array.from({length:4},(_,i)=>assert.rejects(f.client.sendMessage(jid,'failure','lookup-'+i))));
  f.socket.onWhatsApp=async target=>[{exists:true,jid:target}];
  assert.equal(f.sent.length,0);
  assert.equal((await f.client.sendMessage(jid,'valid','after-errors')).state,'submitted');
});

test('deduplication races release losing reservations and pending timeouts keep their slot',async t=>{
  const f=await fixture(t),gate=deferred();t.after(()=>gate.resolve());
  f.socket.sendMessage=async(...args)=>{f.sent.push(args[1]);await gate.promise;return f.result(...args);};
  const duplicates=await Promise.all(Array.from({length:4},()=>f.client.sendMessage(jid,'same','raced')));
  assert.equal(f.sent.length,1);assert.equal(duplicates.filter(r=>r.state==='unknown').length,1);
  const others=await Promise.all(Array.from({length:3},(_,i)=>f.client.sendMessage(jid,'held','held-'+i)));
  assert.ok(others.every(r=>r.state==='unknown'));
  await assert.rejects(f.client.sendMessage(jid,'too many','fifth'),e=>e.code==='BUSY');
  assert.equal((await f.client.sendMessage(jid,'same','raced')).id,duplicates[0].id);
  gate.resolve();await turn();
  assert.equal((await f.client.sendMessage(jid,'released','after-timeout')).state,'submitted');
});

test('voice attribution shares the fourth parent slot without blocking media',async t=>{
  const f=await fixture(t),gate=deferred();t.after(()=>gate.resolve());
  f.socket.sendMessage=async(...args)=>{f.sent.push(args[1]);if(args[1].text?.includes('occupy'))await gate.promise;return f.result(...args);};
  await Promise.all(Array.from({length:3},(_,i)=>f.client.sendMessage(jid,'occupy','occupy-'+i)));
  // A tiny valid PCM WAV; conversion never plays audio or contacts WhatsApp.
  const wav=Buffer.alloc(204);wav.write('RIFF');wav.writeUInt32LE(196,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(160,40);
  const file=path.join(f.client.transferRoot,'uploads','voice.wav');await fs.writeFile(file,wav);
  const voice=await f.client.sendFile(jid,file,{kind:'voice',request_id:'fourth-voice'});
  assert.equal(voice.state,'submitted');assert.ok(voice.watermark_request_id);assert.ok(f.sent.some(c=>c.audio&&c.ptt));
  assert.equal((await f.client.sendMessage(jid,'slot freed','after-voice')).state,'submitted');
  gate.resolve();await turn();
});

test('a timed-out attribution retains the parent slot until its network promise settles',async t=>{
  const f=await fixture(t),gate=deferred();t.after(()=>gate.resolve());
  f.socket.sendMessage=async(...args)=>{f.sent.push(args[1]);await gate.promise;return f.result(...args);};
  await Promise.all(Array.from({length:3},(_,i)=>f.client.sendMessage(jid,'held','prelude-held-'+i)));
  const file=path.join(f.client.transferRoot,'uploads','audio.mp3');await fs.writeFile(file,'mock audio');
  const audio=await f.client.sendFile(jid,file,{kind:'audio',request_id:'prelude-timeout'});
  assert.equal(audio.state,'failed');assert.equal(f.sent.length,4);assert.ok(f.sent.every(c=>!c.audio));
  await assert.rejects(f.client.sendMessage(jid,'blocked','during-prelude'),e=>e.code==='BUSY');
  gate.resolve();await turn();
  assert.equal((await f.client.sendMessage(jid,'released','after-prelude')).state,'submitted');
});

test('GIF playback changes conflict while false and omitted preserve legacy fingerprints',async t=>{
  const f=await fixture(t),file=path.join(f.client.transferRoot,'uploads','video.mp4');await fs.writeFile(file,'video fixture');
  const opts={kind:'video',request_id:'gif-false'};
  const first=await f.client.sendFile(jid,file,opts);
  const legacy=createHash('sha256').update(JSON.stringify({jid,kind:'video',caption:'',mimetype:'video/mp4',fileName:'video.mp4',sha256:createHash('sha256').update('video fixture').digest('hex')})).digest('hex');
  assert.equal(f.store.operation(opts.request_id).fingerprint,legacy);
  assert.equal((await f.client.sendFile(jid,file,{...opts,gifPlayback:false})).id,first.id);
  await assert.rejects(f.client.sendFile(jid,file,{...opts,gifPlayback:true}),e=>e.code==='REQUEST_ID_CONFLICT');
  await f.client.sendFile(jid,file,{...opts,request_id:'gif-true',gifPlayback:true});
  await assert.rejects(f.client.sendFile(jid,file,{...opts,request_id:'gif-true'}),e=>e.code==='REQUEST_ID_CONFLICT');
  assert.equal(f.sent.length,2);assert.equal(f.sent[1].gifPlayback,true);
});
