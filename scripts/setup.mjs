import {mkdir,writeFile,chmod,stat,readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
process.umask(0o077);
if(process.platform!=='linux')throw new Error('This release supports Linux; use a Linux VM on other systems.');
const root=path.resolve(process.env.WHATSAPP_STATE_DIR || path.join(os.homedir(),'.whatsapp-mcp-public'));
await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);
const databaseFile=path.resolve(process.env.WHATSAPP_DB_KEY_FILE || path.join(root,'database.key'));
const tokenFile=path.resolve(process.env.WHATSAPP_API_TOKEN_FILE || path.join(root,'api-token'));
if(databaseFile===tokenFile)throw new Error('Choose separate database key and API token files.');
for(const file of [databaseFile,tokenFile]) {
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});
  try {await writeFile(file,randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});}
  catch(e){
    if(e.code!=='EEXIST')throw e;
    const info=await stat(file);
    if(!info.isFile() || info.uid!==process.getuid() || info.mode & 0o077)throw new Error('Existing secret must be an owner-only regular file.');
    if(info.size>256 || !/^[a-f0-9]{64}$/.test((await readFile(file,'utf8')).trim()))throw new Error('Existing secret must contain 64 lowercase hex characters.');
  }
}
const transfers=process.env.WHATSAPP_TRANSFER_DIR || path.join('/dev/shm',`whatsapp-mcp-${process.getuid()}`);
await mkdir(path.join(transfers,'uploads'),{recursive:true,mode:0o700});
console.log('Initialized private state in '+root+'\nBack up the database key separately. Losing it makes encrypted data unrecoverable.');
