import Native from 'better-sqlite3-multiple-ciphers';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createCipheriv, randomBytes } from 'node:crypto';

export function databaseKey(): string {
  const file=process.env.WHATSAPP_DB_KEY_FILE;
  if(!file) throw new Error('WHATSAPP_DB_KEY_FILE is required; plaintext database storage is disabled.');
  const st=statSync(file);
  if(!st.isFile() || (st.mode & 0o077)) throw new Error('Database key file must be private (0600).');
  const key=readFileSync(file,'utf8').trim();
  if(!/^[a-f0-9]{64}$/.test(key))throw new Error('Database key must contain 32 random bytes encoded as hex.');
  return key;
}
export class DatabaseSync {
  private db: Native.Database;
  constructor(file:string) {
    this.db=new Native(file);
    try {
      this.db.pragma("cipher='sqlcipher'");
      this.db.pragma('legacy=4');
      this.db.pragma(`key='${databaseKey()}'`);
      this.db.pragma('temp_store=MEMORY');
      this.db.prepare('SELECT count(*) FROM sqlite_master').get();
    } catch {this.db.close();throw new Error('Cannot unlock database; check key and encrypted database format.');}
  }
  prepare(sql:string): any {return this.db.prepare(sql);}
  exec(sql:string): void {this.db.exec(sql);}
  close(): void {this.db.close();}
  // Serialize only in process memory; never create a plaintext backup on disk.
  encryptedBackup(file:string): void {
    const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',Buffer.from(databaseKey(),'hex'),iv);
    const plain=this.db.serialize();
    try {
      const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
      writeFileSync(file,Buffer.concat([Buffer.from('WAMCPBK1'),iv,cipher.getAuthTag(),ciphertext]),{flag:'wx',mode:0o600});
    } finally {plain.fill(0);}
  }
}
export async function backup(db:DatabaseSync,file:string):Promise<void> {db.encryptedBackup(file);}
