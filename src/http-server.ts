import { readApiToken, authorized } from './services/api-token.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './tools/register.js';
import { WhatsAppClient, MAX_FILE_BYTES } from './services/whatsapp-client.js';
import { ServiceError } from './services/errors.js';

function json(res:ServerResponse,status:number,data:unknown) {res.writeHead(status,{'content-type':'application/json','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));}
function allowedHeader(req:IncomingMessage,port:number) {
  const hosts=[`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`];
  const host=req.headers.host,origin=req.headers.origin;
  return typeof host==='string' && hosts.includes(host) && (origin===undefined || typeof origin==='string' && hosts.map(h=>`http://${h}`).includes(origin));
}
async function readJson(req:IncomingMessage) {
  const chunks:Buffer[]=[];let n=0;
  if(!req.headers['content-type']?.startsWith('application/json'))throw new ServiceError('CONTENT_TYPE','Use application/json.');
  for await(const chunk of req) {n+=chunk.length;if(n>1_000_000)throw new ServiceError('REQUEST_TOO_LARGE','MCP requests are limited to 1 MB.');chunks.push(chunk);}
  let value:any;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ServiceError('INVALID_JSON','Malformed JSON.');}
  const queue:Array<[any,number]>=[[value,0]];
  while(queue.length) {const [v,depth]=queue.pop()!;if(depth>30)throw new ServiceError('REQUEST_TOO_DEEP','JSON nesting exceeds 30 levels.');
    if(v && typeof v==='object')for(const child of Object.values(v))queue.push([child,depth+1]);}
  return value;
}
export async function startHttpServer(client:WhatsAppClient,options:{port?:number;host?:string;sessionTtlMs?:number}={}) {
  const apiToken=readApiToken();
  const host=options.host || process.env.WHATSAPP_HTTP_HOST || '127.0.0.1';
  if(!['127.0.0.1','::1','localhost'].includes(host))throw new Error('WhatsApp MCP accepts only loopback binding.');
  const requestedPort=options.port ?? Number(process.env.WHATSAPP_HTTP_PORT || 8787);
  if(!Number.isInteger(requestedPort) || requestedPort<0 || requestedPort>65535)throw new Error('Invalid HTTP port');
  const mcpPath=process.env.WHATSAPP_HTTP_PATH || '/mcp';
  const uploadDir=path.join(client.transferRoot,'uploads'),downloadDir=path.join(client.transferRoot,'downloads');
  for(const dir of [client.transferRoot,uploadDir,downloadDir]) {await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.chmod(dir,0o700);}
  const roots=await Promise.all([uploadDir,downloadDir].map(d=>fs.realpath(d)));
  const sessions=new Map<string,{server:ReturnType<typeof createMcpServer>;transport:StreamableHTTPServerTransport;touched:number;born:number;active:number}>();
  const ttl=options.sessionTtlMs || 15*60*1000;
  let transfers=0,pendingInitializations=0,activeRequests=0;
  const closeSession=async(id:string)=>{const s=sessions.get(id);sessions.delete(id);if(s)await s.server.close();};
  async function upload(req:IncomingMessage,res:ServerResponse) {
    let dest:string | undefined,job:Promise<void> | undefined,failed=false;
    const parser=Busboy({headers:req.headers,limits:{files:1,fields:0,parts:1,fileSize:MAX_FILE_BYTES,headerPairs:100}});
    let name='upload',size=0;
    parser.on('file',(_field,stream,info)=>{
      name=path.basename(info.filename || 'upload').replace(/[^a-zA-Z0-9._-]/g,'_').slice(-120) || 'upload';
      dest=path.join(uploadDir,`${randomUUID()}-${name}`);
      stream.on('limit',()=>{failed=true;});
      job=pipeline(stream,new Transform({transform(chunk,_enc,cb){size+=chunk.length;cb(null,chunk);}}),createWriteStream(dest,{flags:'wx',mode:0o600}));
      job.catch(()=>{failed=true;});
    });
    parser.on('filesLimit',()=>{failed=true;});parser.on('fieldsLimit',()=>{failed=true;});
    try {
      let wireBytes=0;
      await pipeline(req,new Transform({transform(chunk,_enc,cb){wireBytes+=chunk.length;
        if(wireBytes>MAX_FILE_BYTES+65536)cb(new ServiceError('TRANSFER_LIMIT','Upload exceeds 50 MiB.'));else cb(null,chunk);}}),parser,{signal:AbortSignal.timeout(60000)});
      await job;
      if(failed || !dest)throw new ServiceError('TRANSFER_LIMIT','Exactly one file of at most 50 MiB is required.');
      json(res,200,{path:dest,size,name});
    } catch(e) {await job?.catch(()=>{});if(dest)await fs.rm(dest,{force:true});throw e;}
  }
  async function download(req:IncomingMessage,res:ServerResponse,url:URL) {
    const raw=url.searchParams.get('path');if(!raw)throw new ServiceError('INVALID_PATH','Missing path.');
    const real=await fs.realpath(raw);
    const inRoots=(p:string)=>roots.some(r=>p.startsWith(r+path.sep));
    if(!inRoots(real))throw new ServiceError('PATH_FORBIDDEN','Only dedicated transfer files can be downloaded.');
    const file=await fs.open(real,constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      // Verify the opened inode as well, closing a path/ancestor replacement race.
      const opened=await fs.realpath(`/proc/self/fd/${file.fd}`);
      const stat=await file.stat();
      if(!inRoots(opened) || !stat.isFile())throw new ServiceError('PATH_FORBIDDEN','Not an allowed regular transfer file.');
      if(stat.size>MAX_FILE_BYTES)throw new ServiceError('TRANSFER_LIMIT','Download exceeds 50 MiB.');
      res.writeHead(200,{'content-type':'application/octet-stream','content-length':stat.size,'x-content-type-options':'nosniff',
        'content-disposition':`attachment; filename="${path.basename(real).replace(/[^a-zA-Z0-9._-]/g,'_')}"`});
      await pipeline(file.createReadStream({autoClose:false}),res,{signal:AbortSignal.timeout(60000)});
    } finally {await file.close();}
  }
  let port=requestedPort;
  const http=createServer((req,res)=>{void (async()=>{
    if(!allowedHeader(req,port)) {json(res,403,{error:{code:'UNTRUSTED_HOST_OR_ORIGIN'}});return;}
    if(!authorized(req.headers.authorization,apiToken)) {json(res,401,{error:{code:'UNAUTHORIZED'}});return;}
    if(activeRequests>=64){json(res,429,{error:{code:'REQUEST_LIMIT'}});return;}
    ++activeRequests;let released=false;const release=()=>{if(!released){released=true;--activeRequests;}};
    res.once('close',release);res.once('finish',release);
    try {
      const url=new URL(req.url || '/',`http://127.0.0.1:${port}`);
      if(url.pathname==='/healthz' && req.method==='GET') {json(res,200,{healthy:true,pid:process.pid});return;}
      if(url.pathname==='/readyz' && req.method==='GET') {json(res,client.isConnected && !client.status.persistenceError?200:503,{ready:client.isConnected && !client.status.persistenceError,state:client.status.state});return;}
      if((url.pathname==='/upload' && req.method==='POST') || (url.pathname==='/download' && req.method==='GET')) {
        if(transfers>=2){json(res,429,{error:{code:'TRANSFER_BUSY'}});return;}
        ++transfers;try {if(url.pathname==='/upload')await upload(req,res);else await download(req,res,url);}finally{--transfers;}return;
      }
      if(url.pathname!==mcpPath){json(res,404,{error:{code:'NOT_FOUND'}});return;}
      if(!['POST','GET','DELETE'].includes(req.method || '')){json(res,405,{error:{code:'METHOD_NOT_ALLOWED'}});return;}
      const id=req.headers['mcp-session-id'];
      if(Array.isArray(id)){json(res,400,{error:{code:'INVALID_SESSION'}});return;}
      let entry=id?sessions.get(id):undefined;
      if(entry && !entry.active && (Date.now()-entry.touched>ttl || Date.now()-entry.born>3600000)) {await closeSession(id!);entry=undefined;}
      if(id && !entry){json(res,404,{jsonrpc:'2.0',id:null,error:{code:-32001,message:'Session expired. Reinitialize; do not replay writes without checking request_id.'}});return;}
      if(Number(req.headers['content-length'])>1_000_000){json(res,413,{error:{code:'REQUEST_TOO_LARGE'}});return;}
      const body=req.method==='POST'?await readJson(req):undefined;
      if(!entry) {
        if(req.method!=='POST' || !isInitializeRequest(body)){json(res,400,{error:{code:'INITIALIZE_REQUIRED'}});return;}
        if(sessions.size+pendingInitializations>=32){json(res,429,{error:{code:'SESSION_LIMIT'}});return;}
        ++pendingInitializations;
        try {
          const server=createMcpServer(client);
          const transport=new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID,enableJsonResponse:true,
            onsessioninitialized:newId=>{sessions.set(newId,created);},onsessionclosed:closedId=>{void closeSession(closedId);}});
          const created={server,transport,touched:Date.now(),born:Date.now(),active:0};
          await server.connect(transport);entry=created;
          transport.onclose=()=>{for(const [k,v]of sessions)if(v===created)sessions.delete(k);};
        } finally {--pendingInitializations;}
      }
      // An idle SSE GET must not keep a session alive forever. Only POST work
      // prevents expiry while it is being processed.
      entry.touched=Date.now();
      const busy=req.method==='POST';if(busy)++entry.active;
      try {await entry.transport.handleRequest(req,res,body);}finally {if(busy){--entry.active;entry.touched=Date.now();}}
    } catch(e) {
      if(res.headersSent){res.destroy();return;}
      const err=e instanceof ServiceError?e:new ServiceError('REQUEST_FAILED','The request could not be completed.');
      json(res,err.code==='PATH_FORBIDDEN'?403:err.code.includes('LIMIT') || err.code==='REQUEST_TOO_LARGE'?413:400,{error:{code:err.code,message:err.message}});
    }
  })().catch(()=>{if(!res.headersSent)json(res,500,{error:{code:'INTERNAL_ERROR'}});else res.destroy();});});
  http.requestTimeout=70000;http.headersTimeout=10000;http.keepAliveTimeout=5000;
  await new Promise<void>((resolve,reject)=>{http.once('error',reject);http.listen(requestedPort,host,()=>resolve());});
  port=(http.address() as any).port;
  const timer=setInterval(()=>{
    for(const [id,s]of sessions)if(!s.active && (Date.now()-s.touched>ttl || Date.now()-s.born>3600000))void closeSession(id).catch(()=>{});
  },Math.min(ttl,60000));timer.unref();
  const cleanup=setInterval(()=>{void (async()=>{
    for(const root of roots)for(const name of await fs.readdir(root)) {
      const file=path.join(root,name),stat=await fs.lstat(file);
      if(stat.isFile() && Date.now()-stat.mtimeMs>3600000)await fs.unlink(file);
    }
  })().catch(()=>{});},600000);cleanup.unref();
  return {port,http,sessions,close:async()=>{clearInterval(timer);clearInterval(cleanup);await Promise.all([...sessions.keys()].map(closeSession));
    await new Promise<void>(resolve=>{http.close(()=>resolve());http.closeAllConnections();});}};
}
