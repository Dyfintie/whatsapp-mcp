import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WhatsAppClient } from '../services/whatsapp-client.js';
import { ServiceError } from '../services/errors.js';
import { callService } from '../services/call-service.js';
import * as S from '../schemas/index.js';

const page={limit:z.number().int().min(1).max(100).default(20),offset:z.number().int().min(0).max(10000000).default(0)};
const dates={before:z.string().datetime({offset:true}).optional(),after:z.string().datetime({offset:true}).optional()};
export function success(client:WhatsAppClient,data:any,source='sqlite') {
  const result={ok:true,connection:client.status.state,source,data};
  return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};
}
export function failure(client:WhatsAppClient,e:unknown) {
  const error=e instanceof ServiceError?e:new ServiceError('INTERNAL_ERROR','Operation failed. Check sanitized service diagnostics.');
  const result={ok:false,connection:client.status.state,source:'service',error:{code:error.code,message:error.message,retryable:error.retryable,...error.details}};
  return {isError:true,content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};
}
export function createMcpServer(client:WhatsAppClient) {
  const server=new McpServer({name:'whatsapp-mcp-server',version:'0.2.0'});
  const tool=(name:string,description:string,schema:any,readOnly:boolean,fn:(params:any)=>Promise<any>,source='sqlite')=>{
    server.registerTool(name,{description,inputSchema:schema,
      outputSchema:z.object({ok:z.boolean(),connection:z.string(),source:z.string(),data:z.any().optional(),error:z.any().optional()}),
      annotations:{readOnlyHint:readOnly,destructiveHint:false,idempotentHint:readOnly,openWorldHint:source==='whatsapp'}},async(params:any)=>{
        try {
          const data=await fn(params);
          if(data?.ok===false)throw new ServiceError('CALL_BACKEND_FAILED',String(data.error || 'Calling backend reported failure.'),false,{state:data.state});
          if(data?.state==='unknown' && name.startsWith('whatsapp_send_'))throw new ServiceError(data.errorCode || 'SEND_OUTCOME_UNKNOWN','Dispatch outcome is uncertain. Query this request_id; do not resend.',false,data);
          if(data?.state==='failed' && name.startsWith('whatsapp_send_'))throw new ServiceError(data.errorCode || 'SEND_FAILED','Send failed. Inspect the operation and any watermark_request_id before retrying.',false,data);
          return success(client,data,source);
        }catch(e){return failure(client,e);}
      });
  };
  tool('whatsapp_get_status','Current connection and pairing state. QR data is returned only while valid.',S.GetStatusInputSchema,true,async()=>client.status,'service');
  tool('whatsapp_get_diagnostics','Sanitized connection timeline and engine details; no credentials or message bodies.',z.object({}).strict(),true,async()=>client.diagnostics(),'service');
  tool('whatsapp_request_pairing_code','Request a phone linking code after the user authorizes linking. Concurrent calls for the same phone share one attempt.',z.object({phone_number:z.string().regex(/^[1-9]\d{6,14}$/)}).strict(),false,
    async p=>({code:await client.requestPairingCode(p.phone_number),...client.status}),'whatsapp');
  tool('whatsapp_relink','Explicitly replace local credentials with a fresh attempt, retaining a protected backup. Use only when relinking is authorized. This does not revoke other devices.',
    z.object({confirm:z.literal(true),phone_number:z.string().regex(/^[1-9]\d{6,14}$/).optional()}).strict(),false,p=>client.relink(p.phone_number),'whatsapp');
  tool('whatsapp_list_chats','List stored chats even while offline. unreadCount is unknown; no fabricated unread counts.',S.ListChatsInputSchema,true,p=>client.getChats(p.limit,p.offset,p.query));
  tool('whatsapp_list_messages','Paginated SQLite history, newest first. Filters use UTC ISO timestamps. Historical status values are unverified. IDs beginning db: refer to historical database rows.',S.ListMessagesInputSchema,true,
    p=>client.listMessages(p.chat_id,p.limit,p));
  tool('whatsapp_search_messages','Search stored messages using SQLite FTS5 syntax, optionally filtered by chat/date.',z.object({query:z.string().min(1).max(1000),chat_id:z.string().optional(),...page,...dates}).strict(),true,
    p=>client.searchMessages(p.query,p.chat_id,p.limit,p));
  tool('whatsapp_get_message','Retrieve one stored message and available receipt evidence. Group receipts establish at least one recipient, not all group members.',z.object({chat_id:z.string().min(1),message_id:z.string().min(1)}).strict(),true,
    async p=>client.store.getMessage(p.chat_id,p.message_id));
  tool('whatsapp_lookup_contact','Search stored contacts by name or exact identifier. LIDs are not phone numbers; only protocol-verified mappings are returned.',z.object({query:z.string().max(200),...page}).strict(),true,
    async p=>client.store.contacts(p.query,p.limit,p.offset));
  tool('whatsapp_get_operation','Read a durable send operation by request_id. Unknown/submitted does not authorize resending. Delivery requires receipt evidence.',z.object({request_id:z.string().min(1).max(128)}).strict(),true,async p=>{
    const op=client.store.operation(p.request_id);if(!op)throw new ServiceError('OPERATION_NOT_FOUND','No operation has this request_id.');return op;
  });
  tool('whatsapp_send_message','Send real text to the user-approved recipient. The daemon adds the full Auto attribution for the first three outgoing messages to each recipient, then signs later messages ~By Auto. Do not add attribution yourself. Supply a stable request_id to deduplicate retries; different content with the same ID is rejected. Submitted is not delivery.',S.SendMessageInputSchema,false,
    p=>client.sendMessage(p.chat_id,p.text,p.request_id),'whatsapp');
  tool('whatsapp_send_file','Send a real attachment to the user-approved recipient. The daemon applies the recipient-specific Auto attribution policy to captions; audio/voice sends a preceding attributed text. kind=voice converts a private snapshot to verified Opus. Max 50 MiB. request_id prevents replay.',S.SendFileInputSchema,false,
    p=>client.sendFile(p.chat_id,p.path,p),'whatsapp');
  tool('whatsapp_get_group_info','Fetch current group metadata from WhatsApp.',S.GetGroupInfoInputSchema,true,p=>client.getGroupInfo(p.group_id),'whatsapp');
  tool('whatsapp_download_media','Stream media from its persisted envelope, including after restart. Historical exports without envelopes cannot be downloaded. Max 50 MiB; output_dir must be in the dedicated downloads directory.',S.DownloadMediaInputSchema,false,
    p=>client.downloadMedia(p.chat_id,p.message_id,p.output_dir),'whatsapp');
  tool('whatsapp_call_dial','Call only the user-approved recipient. Do not automatically retry a timed-out dial; inspect call status first. Initiate a WhatsApp voice call to a phone number or contact name using WhatsApp Web calling daemon. Optionally synthesizes speech via Piper TTS and speaks into the call upon answering.',S.CallDialInputSchema,false,
    p=>callService.dial(p.recipient,{speakOnConnect:p.speak_on_connect,voice:p.voice,maxWaitSeconds:p.max_wait_seconds}),'whatsapp');
  tool('whatsapp_call_hangup','End the currently active WhatsApp voice call.',S.CallHangupInputSchema,false,
    ()=>callService.hangup(),'whatsapp');
  tool('whatsapp_call_status','Check whether a WhatsApp call is currently active, ringing, connected, or ended, along with elapsed duration.',S.CallStatusInputSchema,true,
    ()=>callService.getStatus(),'service');
  tool('whatsapp_call_speak','Synthesize speech using the local low-latency Piper TTS engine and stream it directly into the active WhatsApp call microphone.',S.CallSpeakInputSchema,false,
    p=>callService.speak(p.text,p.voice),'whatsapp');
  tool('whatsapp_send_voice_note','Send a Piper voice note only to the user-approved recipient. Supply a stable request_id to deduplicate retries; changed text or voice with the same ID is rejected. Submitted is not delivery. The daemon sends an attributed text prelude.',S.SendVoiceNoteInputSchema,false,
    p=>callService.sendVoiceNote(client,p.chat_id,p.text,{voice:p.voice,request_id:p.request_id}),'whatsapp');
  server.registerTool('whatsapp_get_media',{description:'Return complete Base64 or data_url, up to 4 MiB decoded. Images use image blocks only for supported image MIME types; documents use resource blocks. Larger files require whatsapp_download_media.',
    inputSchema:S.GetMediaInputSchema,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},async(p:any)=>{
      try {
        const data=await client.getMedia(p.chat_id,p.message_id,p.format);
        const result=success(client,data,'whatsapp');
        if(p.format==='data_url') {
          const mime=data.media.mimetype || 'application/octet-stream';
          const block:any=/^image\/(png|jpeg|webp|gif)$/.test(mime)?{type:'image',data:data.base64,mimeType:mime}:
            {type:'resource',resource:{uri:`whatsapp-media://${encodeURIComponent(p.chat_id)}/${encodeURIComponent(p.message_id)}`,mimeType:mime,blob:data.base64}};
          return {...result,content:[{type:'text' as const,text:JSON.stringify({ok:true,connection:client.status.state,source:'whatsapp',media:data.media})},block]};
        }
        return result;
      } catch(e) {return failure(client,e);}
    });
  return server;
}
