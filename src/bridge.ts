import { readApiToken } from './services/api-token.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export async function startBridge() {
  const token=readApiToken();
  const url=new URL(process.env.WHATSAPP_MCP_URL || 'http://127.0.0.1:8787/mcp');
  if(url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Bridge requires a loopback HTTP daemon.');
  let client:Client | undefined,transport:StreamableHTTPClientTransport | undefined,connecting:Promise<Client> | undefined;
  async function remote() {
    if(client)return client;
    if(connecting)return connecting;
    connecting=(async()=>{
      const next=new Client({name:'whatsapp-stdio-bridge',version:'0.2.0'});
      const nextTransport=new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${token}`}}});
      await next.connect(nextTransport);transport=nextTransport;client=next;return next;
    })().finally(()=>{connecting=undefined;});return connecting;
  }
  async function reset(failed:Client) {
    if(client===failed){client=undefined;const old=transport;transport=undefined;await old?.terminateSession().catch(()=>{});}
    await failed.close().catch(()=>{});
  }
  const server=new Server({name:'whatsapp-shared-bridge',version:'0.2.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>{
    const c=await remote();try{return await c.listTools();}catch(e:any){
      if(e.code!==404)throw e;await reset(c);return (await remote()).listTools();
    }
  });
  server.setRequestHandler(CallToolRequestSchema,async(request)=>{
    const c=await remote();
    try{return await c.callTool(request.params,undefined,{timeout:120000});}
    catch(e:any){
      await reset(c);
      // Reinitialize on the next call. Never replay a write (or an uncertain read with effects).
      return {isError:true,content:[{type:'text',text:JSON.stringify({ok:false,error:{code:e.code===404?'SESSION_EXPIRED':'BRIDGE_REQUEST_FAILED',
        message:'The next call will reinitialize. For sends, query request_id before retrying.',retryable:false}})}]};
    }
  });
  await server.connect(new StdioServerTransport());
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;await transport?.terminateSession().catch(()=>{});await client?.close();await server.close();};
  server.onclose=()=>{void close();};
  process.once('SIGINT',()=>{void close().then(()=>process.exit(0));});
  process.once('SIGTERM',()=>{void close().then(()=>process.exit(0));});
}
