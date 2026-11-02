import Native from 'better-sqlite3-multiple-ciphers';
import {readFileSync,existsSync,writeFileSync,mkdtempSync,rmSync,copyFileSync,constants,statfsSync} from 'node:fs';
import {createDecipheriv} from 'node:crypto';
import path from 'node:path';
import {databaseKey} from '../dist/services/encrypted-db.js';
process.umask(0o077);
const [source,target]=process.argv.slice(2);
if(!source || !target || existsSync(target))throw new Error('Provide a backup and a NEW destination database path.');
if(process.platform!=='linux' || statfsSync('/dev/shm').type!==0x01021994)throw new Error('Restore requires Linux tmpfs at /dev/shm.');
const bytes=readFileSync(source);
if(bytes.subarray(0,8).toString()!=='WAMCPBK1')throw new Error('Unknown backup format');
const key=databaseKey();
const decipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),bytes.subarray(8,20));
decipher.setAuthTag(bytes.subarray(20,36));
let plain;
try {plain=Buffer.concat([decipher.update(bytes.subarray(36)),decipher.final()]);}
catch {throw new Error('Backup authentication failed. Check key and file integrity.');}
const dir=mkdtempSync('/dev/shm/wa-restore-');let db;
try {
  plain[18]=1;plain[19]=1;
  const temporary=path.join(dir,'restore.sqlite');
  writeFileSync(temporary,plain,{flag:'wx',mode:0o600});plain.fill(0);
  db=new Native(temporary);db.pragma("cipher='sqlcipher'");db.pragma('legacy=4');db.pragma(`rekey='${key}'`);
  db.close();db=undefined;
  copyFileSync(temporary,target,constants.COPYFILE_EXCL);
} catch {throw new Error('Restore failed; check available tmpfs space and destination permissions.');}
finally {db?.close();plain.fill(0);rmSync(dir,{recursive:true,force:true});}
console.log('Restored encrypted database. Stop the daemon before replacing its database.');
