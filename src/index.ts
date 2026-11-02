#!/usr/bin/env node
import { mkdir, chmod, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireProcessLock } from './services/process-lock.js';
import { MessageStore } from './services/message-store.js';
import { WhatsAppClient } from './services/whatsapp-client.js';
import { startHttpServer } from './http-server.js';
import { startBridge } from './bridge.js';
import { installConsoleGuard } from './services/console-guard.js';

async function main() {
  process.umask(0o077);
  const mode=(process.env.WHATSAPP_MCP_TRANSPORT || 'stdio').toLowerCase();
  if(mode==='stdio') {await startBridge();return;}
  installConsoleGuard();
  if(!['http','streamable-http','streamable_http','streamablehttp'].includes(mode))throw new Error('Invalid transport');
  const root=process.env.WHATSAPP_STATE_DIR || path.join(os.homedir(),'.whatsapp-mcp');
  const unlock=acquireProcessLock(path.join(root,'daemon-lock.sqlite'));
  let store:MessageStore | undefined,client:WhatsAppClient | undefined,http:Awaited<ReturnType<typeof startHttpServer>> | undefined;
  let closing=false;
  async function shutdown() {
    if(closing)return;closing=true;
    try {await http?.close();await client?.disconnect();store?.close();}finally{unlock();}
  }
  try {
    store=await MessageStore.open(process.env.WHATSAPP_CLEAN_DB_PATH || path.join(root,'messages.sqlite'));
    client=new WhatsAppClient(process.env.WHATSAPP_AUTH_DIR || path.join(root,'auth'),store);
    if(process.platform!=='linux')throw new Error('This release supports Linux only.');
    await mkdir(client.transferRoot,{recursive:true,mode:0o700});
    if((await stat(client.transferRoot)).uid!==process.getuid!())throw new Error('Transfer directory has a different owner.');
    await chmod(client.transferRoot,0o700);
    if((await statfs(client.transferRoot)).type!==0x01021994)throw new Error('Transfer directory must use tmpfs; configure encrypted swap.');
    http=await startHttpServer(client);
    for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{
      void shutdown().then(()=>process.exit(0),()=>process.exit(1));
    });
    console.error(JSON.stringify({event:'listening',port:http.port,pid:process.pid,node:process.version}));
    if(process.env.WHATSAPP_OFFLINE==='true')console.error('WhatsApp network disabled for isolated validation.');
    else void client.connect().catch(()=>{});
  }catch(e){await shutdown();throw e;}
}
main().catch(error=>{console.error(JSON.stringify({event:'fatal',code:error.code || 'STARTUP_FAILED',message:error.message}));process.exit(1);});
