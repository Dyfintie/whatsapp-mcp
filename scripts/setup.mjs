import {mkdir,writeFile,chmod,stat} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
process.umask(0o077);
if(process.platform!=='linux')throw new Error('This release supports Linux; use a Linux VM on other systems.');
const root=path.resolve(process.env.WHATSAPP_STATE_DIR || path.join(os.homedir(),'.whatsapp-mcp-public'));
await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);
for(const name of ['database.key','api-token']) {
  try {await writeFile(path.join(root,name),randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600});}
  catch(e){if(e.code!=='EEXIST')throw e;if((await stat(path.join(root,name))).mode & 0o077)throw new Error('Existing key has unsafe permissions');}
}
await mkdir(path.join('/dev/shm',`whatsapp-mcp-${process.getuid()}`,'uploads'),{recursive:true,mode:0o700});
console.log('Initialized private state: '+root+'\nBack up database.key separately. Losing it makes encrypted data unrecoverable.');
