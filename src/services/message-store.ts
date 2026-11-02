import { DatabaseSync, backup } from "./encrypted-db.js";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { BufferJSON, normalizeMessageContent, getContentType } from "@whiskeysockets/baileys";
import { ServiceError, normalizeJid, phoneOf } from "./errors.js";

export type Outcome = "submitted" | "acknowledged" | "delivered" | "read" | "failed" | "unknown";
export interface MessageQuery { chat_id?: string; limit?: number; offset?: number; before?: string; after?: string; query?: string }
const ranks: Record<string, number> = { unknown: 0, failed: 0, submitted: 1, acknowledged: 2, delivered: 3, read: 4 };
export const stringify = (value: unknown) => JSON.stringify(value, BufferJSON.replacer);
export const parse = (value: unknown) => value ? JSON.parse(String(value), BufferJSON.reviver) : undefined;
export const seconds = (value: any) => Number(value?.toNumber?.() ?? value) || Math.floor(Date.now() / 1000);
export function mediaMeta(message: any) {
  const content: any = normalizeMessageContent(message);
  const type = getContentType(content || {});
  if (!type || !["imageMessage", "videoMessage", "documentMessage", "audioMessage", "stickerMessage"].includes(type)) return undefined;
  const m = content[type];
  return { kind: type.replace(/Message$/, ""), mimetype: m.mimetype, fileName: m.fileName,
    fileLength: m.fileLength == null ? undefined : Number(m.fileLength), seconds: m.seconds,
    isVoiceNote: Boolean(m.ptt), caption: m.caption };
}
export function messageText(message: any): { text: string; type: string } {
  const m: any = normalizeMessageContent(message) || {};
  const type = getContentType(m) || "unknown";
  return { text: m.conversation ?? m.extendedTextMessage?.text ?? m[type]?.caption ?? m[type]?.fileName ?? "",
    type: ["conversation", "extendedTextMessage"].includes(type) ? "text" : type.replace(/Message$/, "") };
}

export class MessageStore {
  private constructor(readonly db: DatabaseSync, readonly file: string, readonly migrationBackup?: string) {}
  static async open(file: string): Promise<MessageStore> {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    const hasMigrations = db.prepare("SELECT 1 FROM sqlite_master WHERE name='wa_migrations'").get();
    const migrated = hasMigrations && db.prepare("SELECT 1 FROM wa_migrations WHERE version IN (2,4) GROUP BY 1 HAVING COUNT(*)=2").get();
    let dest: string | undefined;
    if (!migrated && db.prepare("SELECT 1 FROM sqlite_master WHERE name='messages'").get()) {
      dest = `${file}.pre-robustness-${Date.now()}.bak`;
      await backup(db, dest); chmodSync(dest, 0o600);
    }
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    const store = new MessageStore(db, file, dest);
    store.migrate();
    // A previous daemon may have died after dispatch. Never replay these writes.
    db.prepare("UPDATE wa_operations SET state='unknown', error_code='PROCESS_RESTART', updated_at=? WHERE state='submitted'").run(new Date().toISOString());
    return store;
  }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  private migrate() {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS chats (chat_id INTEGER PRIMARY KEY, chat_type TEXT NOT NULL, chat_jid TEXT NOT NULL,
          chat_name TEXT, target_phone TEXT, member_count INTEGER DEFAULT 0, created_at TEXT, last_activity TEXT,
          total_messages INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS messages (message_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(chat_id),
          chat_name TEXT, is_from_me INTEGER NOT NULL, sender_phone TEXT, sender_name TEXT, message_type TEXT NOT NULL,
          text_content TEXT, timestamp_utc TEXT, timestamp_local TEXT, status TEXT, is_starred INTEGER DEFAULT 0,
          reply_to_id INTEGER, reply_snippet TEXT);
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text_content, sender_name, chat_name,
          content='messages', content_rowid='message_id', tokenize='unicode61');
        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid,text_content,sender_name,chat_name) VALUES(new.message_id,new.text_content,new.sender_name,new.chat_name); END;
        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts,rowid,text_content,sender_name,chat_name) VALUES('delete',old.message_id,old.text_content,old.sender_name,old.chat_name); END;
        CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts,rowid,text_content,sender_name,chat_name) VALUES('delete',old.message_id,old.text_content,old.sender_name,old.chat_name);
          INSERT INTO messages_fts(rowid,text_content,sender_name,chat_name) VALUES(new.message_id,new.text_content,new.sender_name,new.chat_name); END;
        CREATE INDEX IF NOT EXISTS wa_message_time ON messages(timestamp_utc DESC,message_id DESC);
        CREATE INDEX IF NOT EXISTS wa_chat_time ON messages(chat_id,timestamp_utc DESC,message_id DESC);
        CREATE INDEX IF NOT EXISTS wa_chat_jid ON chats(chat_jid);
        CREATE TABLE IF NOT EXISTS wa_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wa_protocol (
          message_id INTEGER PRIMARY KEY REFERENCES messages(message_id), jid TEXT NOT NULL, wa_id TEXT NOT NULL,
          from_me INTEGER NOT NULL, participant TEXT NOT NULL DEFAULT '', raw TEXT, media TEXT, sender_jid TEXT,
          receipt_state TEXT NOT NULL, deleted_at TEXT, edited_at TEXT,
          UNIQUE(jid,wa_id,from_me,participant));
        CREATE INDEX IF NOT EXISTS wa_protocol_id ON wa_protocol(jid,wa_id);
        CREATE TABLE IF NOT EXISTS wa_contacts(jid TEXT PRIMARY KEY, name TEXT, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wa_lid_mappings(lid TEXT PRIMARY KEY, pn TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wa_receipts(jid TEXT NOT NULL, wa_id TEXT NOT NULL, recipient TEXT NOT NULL,
          state TEXT NOT NULL, evidence TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(jid,wa_id,recipient));
        CREATE TABLE IF NOT EXISTS wa_operations(request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, jid TEXT NOT NULL,
          wa_id TEXT NOT NULL, state TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error_code TEXT,
          attribution_index INTEGER);
        CREATE INDEX IF NOT EXISTS wa_operation_message ON wa_operations(jid,wa_id);
        CREATE TABLE IF NOT EXISTS wa_attribution_counts(jid TEXT PRIMARY KEY, count INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS wa_meta(name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS wa_counter_insert AFTER INSERT ON messages BEGIN
          UPDATE chats SET total_messages=total_messages+1,
            last_activity=CASE WHEN last_activity IS NULL OR new.timestamp_local>last_activity THEN new.timestamp_local ELSE last_activity END
            WHERE chat_id=new.chat_id; END;
        CREATE TRIGGER IF NOT EXISTS wa_counter_delete AFTER DELETE ON messages BEGIN
          UPDATE chats SET total_messages=(SELECT COUNT(*) FROM messages WHERE chat_id=old.chat_id),
            last_activity=(SELECT MAX(timestamp_local) FROM messages WHERE chat_id=old.chat_id) WHERE chat_id=old.chat_id; END;
      `);
      if (!this.db.prepare("SELECT 1 FROM wa_migrations WHERE version=1").get()) {
        this.db.exec(`UPDATE chats SET total_messages=(SELECT COUNT(*) FROM messages m WHERE m.chat_id=chats.chat_id),
          last_activity=(SELECT MAX(timestamp_local) FROM messages m WHERE m.chat_id=chats.chat_id);
          UPDATE chats SET target_phone=NULL WHERE chat_jid LIKE '%@lid';`);
        this.db.prepare("INSERT INTO wa_migrations VALUES(1,?)").run(new Date().toISOString());
      }
      if (!this.db.prepare("SELECT 1 FROM wa_migrations WHERE version=2").get()) {
        let repaired = false;
        try { this.db.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)"); }
        catch {
          // An external-content FTS index can answer queries while omitting rows.
          // Rebuild only the derived index; never change the historical messages.
          this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
          this.db.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)");
          repaired = true;
        }
        this.db.prepare("INSERT OR REPLACE INTO wa_meta VALUES('fts_rebuilt',?)").run(String(repaired));
        this.db.prepare("INSERT INTO wa_migrations VALUES(2,?)").run(new Date().toISOString());
      }
      const operationColumns = this.db.prepare("PRAGMA table_info(wa_operations)").all().map((r:any)=>String(r.name));
      if (!operationColumns.includes("attribution_index")) this.db.exec("ALTER TABLE wa_operations ADD COLUMN attribution_index INTEGER");
      if (!this.db.prepare("SELECT 1 FROM wa_migrations WHERE version=3").get())
        this.db.prepare("INSERT INTO wa_migrations VALUES(3,?)").run(new Date().toISOString());
      if (!this.db.prepare("SELECT 1 FROM wa_migrations WHERE version=4").get()) {
        // Additive enforcement preserves historical row IDs, FTS, and nullable legacy fields.
        this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS wa_chat_jid_unique ON chats(chat_jid);
          CREATE TRIGGER wa_counter_update AFTER UPDATE OF chat_id,timestamp_local ON messages BEGIN
            UPDATE chats SET total_messages=(SELECT COUNT(*) FROM messages WHERE chat_id=chats.chat_id),
              last_activity=(SELECT MAX(timestamp_local) FROM messages WHERE chat_id=chats.chat_id)
              WHERE chat_id IN (old.chat_id,new.chat_id); END;`);
        const guards: Record<string,string> = {
          chats: "new.is_archived NOT IN (0,1) OR new.member_count< -1 OR new.total_messages<0",
          messages: "new.is_from_me NOT IN (0,1) OR new.is_starred NOT IN (0,1)",
          wa_contacts: "new.jid IS NULL",
          wa_lid_mappings: "new.lid IS NULL",
          wa_meta: "new.name IS NULL",
          wa_attribution_counts: "new.jid IS NULL OR new.count<0",
          wa_operations: "new.request_id IS NULL OR new.attribution_index<1 OR new.state NOT IN ('submitted','acknowledged','delivered','read','failed','unknown')",
          wa_protocol: "new.from_me NOT IN (0,1) OR (new.raw IS NOT NULL AND NOT json_valid(new.raw)) OR (new.media IS NOT NULL AND NOT json_valid(new.media))",
          wa_receipts: "NOT json_valid(new.evidence)",
        };
        for (const [table,invalid] of Object.entries(guards)) {
          // Existing data is audited without silently rewriting historical records.
          const predicate = invalid.replaceAll("new.", "");
          if (this.db.prepare(`SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1`).get())
            throw new Error(`Integrity migration requires repair of invalid rows in ${table}`);
          for (const action of ["INSERT","UPDATE"]) this.db.exec(`
            CREATE TRIGGER wa_guard_${table}_${action} BEFORE ${action} ON ${table}
            WHEN ${invalid} BEGIN SELECT RAISE(ABORT,'Invalid ${table} values'); END;`);
        }
        this.db.prepare("INSERT INTO wa_migrations VALUES(4,?)").run(new Date().toISOString());
      }
    });
  }
  canonical(jid: string) {
    if (!jid.endsWith("@lid")) return jid;
    return String(this.db.prepare("SELECT pn FROM wa_lid_mappings WHERE lid=?").get(jid)?.pn || jid);
  }
  mapping(lid: string, pn: string, source: string) {
    if (!/^\d+@lid$/.test(lid) || !phoneOf(pn)) return;
    this.db.prepare("INSERT OR REPLACE INTO wa_lid_mappings VALUES(?,?,?,?)").run(lid,pn,source,new Date().toISOString());
  }
  private aliases(jid: string) {
    const pn = this.canonical(jid);
    return [...new Set([jid,pn,...this.db.prepare("SELECT lid FROM wa_lid_mappings WHERE pn=?").all(pn).map((r:any) => String(r.lid))])];
  }
  contact(c: any) {
    if (!c.id) return;
    const name = c.name || c.notify || c.verifiedName;
    if (name) {
      this.db.prepare("INSERT OR REPLACE INTO wa_contacts VALUES(?,?,?)").run(c.id,name,new Date().toISOString());
      this.db.prepare("UPDATE chats SET chat_name=? WHERE chat_jid=?").run(name,c.id);
    }
    const lid = c.lid || (c.id.endsWith("@lid") ? c.id : undefined);
    const pn = c.phoneNumber || (phoneOf(c.id) ? c.id : undefined);
    if (lid && pn) this.mapping(lid,pn,"contact");
  }
  chat(jid: string, name?: string): any {
    let row = this.db.prepare("SELECT * FROM chats WHERE chat_jid=? ORDER BY chat_id LIMIT 1").get(jid);
    if (!row) {
      const storedName = name || this.db.prepare("SELECT name FROM wa_contacts WHERE jid=?").get(jid)?.name || jid;
      const r = this.db.prepare("INSERT INTO chats(chat_type,chat_jid,chat_name,target_phone,created_at,total_messages) VALUES(?,?,?,?,?,0)")
        .run(jid.endsWith("@g.us")?"group":"direct",jid,String(storedName),phoneOf(jid),new Date().toISOString());
      row = this.db.prepare("SELECT * FROM chats WHERE chat_id=?").get(r.lastInsertRowid);
    } else if (name) {
      this.db.prepare("UPDATE chats SET chat_name=? WHERE chat_id=?").run(name,row.chat_id);
      row.chat_name = name;
    }
    return row;
  }
  private findProtocol(key: any): any {
    if (!key.remoteJid || !key.id) return undefined;
    const aliases = this.aliases(key.remoteJid);
    let sql = `SELECT * FROM wa_protocol WHERE jid IN (${aliases.map(()=>"?")}) AND wa_id=?`;
    const args: any[] = [...aliases,key.id];
    if (key.fromMe != null) { sql += " AND from_me=?"; args.push(Number(Boolean(key.fromMe))); }
    if (key.participant && key.remoteJid.endsWith("@g.us") && !key.fromMe) {
      const peers = this.aliases(key.participant);
      sql += ` AND participant IN (${peers.map(()=>"?")})`; args.push(...peers);
    }
    const rows = this.db.prepare(sql).all(...args);
    if (rows.length > 1) throw new ServiceError("AMBIGUOUS_MESSAGE", "More than one message matches this protocol identity.");
    return rows[0];
  }
  ingest(msg: any, explicitState?: Outcome): number | undefined {
    const key = msg.key || {};
    if (!key.remoteJid || !key.id || key.remoteJid === "status@broadcast") return;
    // Only use mappings actually supplied by the protocol, never LID digit guesses.
    for (const [a,b] of [[key.remoteJid,key.remoteJidAlt],[key.participant,key.participantAlt]]) {
      if (a?.endsWith("@lid") && b) this.mapping(a,b,"message-key");
      else if (b?.endsWith("@lid") && a) this.mapping(b,a,"message-key");
    }
    const content: any = normalizeMessageContent(msg.message);
    const protocol = content?.protocolMessage;
    if (protocol?.key && (protocol.type === 0 || protocol.editedMessage)) {
      this.update(protocol.key, protocol.editedMessage ? { message: protocol.editedMessage } : { message: null });
      return;
    }
    return this.transaction(() => {
      const existing = this.findProtocol(key);
      const raw = stringify(msg);
      const media = mediaMeta(msg.message);
      const state = explicitState || (key.fromMe ? this.stateFromStatus(msg.status) || "submitted" : "received");
      let id: number;
      if (existing) {
        id = Number(existing.message_id);
        // A late echo fills a placeholder, but must not resurrect a deleted/edited message.
        if (msg.message && !existing.deleted_at && !existing.edited_at) {
          this.db.prepare("UPDATE wa_protocol SET raw=?,media=? WHERE message_id=?").run(raw,media ? stringify(media):null,id);
          const {text,type} = messageText(msg.message);
          this.db.prepare("UPDATE messages SET text_content=?,message_type=? WHERE message_id=?").run(text,type,id);
        }
      } else {
        const jid = this.canonical(key.remoteJid);
        const sender = key.fromMe ? "me" : (key.participant || key.remoteJid);
        const chat = this.chat(jid, !key.fromMe && !jid.endsWith("@g.us") ? msg.pushName : undefined);
        const {text,type} = messageText(msg.message);
        const dt = new Date(seconds(msg.messageTimestamp)*1000);
        const utc = dt.toISOString().slice(0,19).replace("T"," ");
        const pad=(n:number)=>String(n).padStart(2,"0");
        const local = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
        const r = this.db.prepare(`INSERT INTO messages(chat_id,chat_name,is_from_me,sender_phone,sender_name,message_type,text_content,timestamp_utc,timestamp_local,status)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(chat.chat_id,chat.chat_name,Number(Boolean(key.fromMe)),key.fromMe ? "me" : phoneOf(this.canonical(sender)),
            key.fromMe?"Me":msg.pushName || sender,type,text,utc,local,state);
        id=Number(r.lastInsertRowid);
        this.db.prepare("INSERT INTO wa_protocol(message_id,jid,wa_id,from_me,participant,raw,media,sender_jid,receipt_state) VALUES(?,?,?,?,?,?,?,?,?)")
          .run(id,jid,key.id,Number(Boolean(key.fromMe)),jid.endsWith("@g.us") && !key.fromMe ? this.canonical(key.participant || ""):"",raw,media?stringify(media):null,sender,state);
      }
      if (key.fromMe) this.advance(key,state);
      return id;
    });
  }
  stateFromStatus(status: number): Outcome | undefined {
    return ({0:"failed",1:"submitted",2:"acknowledged",3:"delivered",4:"read",5:"read"} as Record<number,Outcome>)[status];
  }
  private advance(key: any, state: string) {
    const row = this.findProtocol(key);
    if (row && ((ranks[state] ?? -1) > (ranks[row.receipt_state] ?? -1) || state === "failed" && row.receipt_state === "submitted")) {
      this.db.prepare("UPDATE wa_protocol SET receipt_state=? WHERE message_id=?").run(state,row.message_id);
      this.db.prepare("UPDATE messages SET status=? WHERE message_id=?").run(state,row.message_id);
    }
    // Incoming and outgoing messages can share a peer-supplied ID. Their
    // receipt states must never cross the direction boundary.
    if(key.fromMe===false)return;
    for (const jid of this.aliases(key.remoteJid)) {
      const ops = this.db.prepare("SELECT * FROM wa_operations WHERE jid=? AND wa_id=?").all(jid,key.id);
      for (const op of ops) {
        if ((ranks[state] ?? -1) > (ranks[String(op.state)] ?? -1) || state === "failed" && op.state === "submitted") this.operationState(String(op.request_id),state as Outcome);
      }
    }
  }
  private completeKey(key: any, kind:string, payload:unknown): any | undefined {
    if(key?.remoteJid && key?.id)return key;
    if(key?.id && !key.remoteJid) {
      const direction=key.fromMe == null ? '' : ' AND from_me=?';
      const args:any[]=[key.id];if(key.fromMe != null)args.push(Number(Boolean(key.fromMe)));
      const rows=this.db.prepare(`SELECT DISTINCT jid,from_me,participant FROM wa_protocol WHERE wa_id=?${direction}`).all(...args);
      if(rows.length===1)return {...key,remoteJid:rows[0].jid,fromMe:Boolean(rows[0].from_me),participant:key.participant || rows[0].participant || undefined};
    }
    // A partial receipt is not a database failure. Retain it privately without
    // inventing a recipient or claiming delivery for an ambiguous message.
    this.db.prepare(`INSERT INTO wa_receipts VALUES(?,?,?,?,?,?)
      ON CONFLICT(jid,wa_id,recipient) DO UPDATE SET evidence=excluded.evidence,updated_at=excluded.updated_at`)
      .run('',String(key?.id || ''),`unresolved:${kind}`,'unmatched',stringify(payload),new Date().toISOString());
    return undefined;
  }
  update(key: any, update: any) {
    key=this.completeKey(key,'message-update',{key,update});if(!key)return;

    this.transaction(() => {
      const row = this.findProtocol(key);
      if (row && "message" in update) {
        const raw = parse(row.raw) || { key };
        raw.message = update.message;
        const deleted = update.message == null;
        const {text,type} = messageText(update.message);
        this.db.prepare("UPDATE messages SET text_content=?,message_type=? WHERE message_id=?").run(deleted?"":text,deleted?"deleted":type,row.message_id);
        this.db.prepare("UPDATE wa_protocol SET raw=?,media=?,deleted_at=?,edited_at=? WHERE message_id=?")
          .run(stringify(raw),deleted?null:stringify(mediaMeta(update.message)) || null,deleted?new Date().toISOString():null,new Date().toISOString(),row.message_id);
      }
      const state=this.stateFromStatus(update.status);
      if (state) this.advance(key,state);
    });
  }
  receipt(key: any, receipt: any) {
    key=this.completeKey(key,'receipt',{key,receipt});if(!key)return;
    const state = receipt.readTimestamp || receipt.playedTimestamp ? "read" : receipt.receiptTimestamp ? "delivered" : undefined;
    if (!state) return;
    this.transaction(() => {
      const jid=this.canonical(key.remoteJid), peer=receipt.userJid || "unknown";
      const prev=this.db.prepare("SELECT state FROM wa_receipts WHERE jid=? AND wa_id=? AND recipient=?").get(jid,key.id,peer);
      if (!prev || ranks[state]>ranks[String(prev.state)]) this.db.prepare("INSERT OR REPLACE INTO wa_receipts VALUES(?,?,?,?,?,?)")
        .run(jid,key.id,peer,state,stringify(receipt),new Date().toISOString());
      // For groups these states mean evidence from at least one recipient, never all members.
      this.advance(key,state);
    });
  }
  list(q: MessageQuery = {}): any[] {
    const args:any[]=[]; const where:string[]=[];
    if (q.chat_id) { const aliases=this.aliases(normalizeJid(q.chat_id)); where.push(`c.chat_jid IN (${aliases.map(()=>"?")})`); args.push(...aliases); }
    if (q.before) { where.push("m.timestamp_utc < ?"); args.push(new Date(q.before).toISOString().slice(0,19).replace("T"," ")); }
    if (q.after) { where.push("m.timestamp_utc >= ?"); args.push(new Date(q.after).toISOString().slice(0,19).replace("T"," ")); }
    if(q.query) { where.push("m.message_id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)"); args.push(q.query); }
    const rows=this.db.prepare(`SELECT m.*,c.chat_jid,p.wa_id,p.sender_jid,p.media,p.receipt_state,p.deleted_at,p.edited_at FROM messages m
      JOIN chats c ON m.chat_id=c.chat_id LEFT JOIN wa_protocol p ON p.message_id=m.message_id
      ${where.length ? "WHERE "+where.join(" AND "):""} ORDER BY m.timestamp_utc DESC,m.message_id DESC LIMIT ? OFFSET ?`)
      .all(...args,Math.min(100,Math.max(1,q.limit || 20)),Math.max(0,q.offset || 0));
    return rows.map((r:any)=>this.present(r));
  }
  private present(r:any) {
    return { id:r.wa_id || `db:${r.message_id}`, databaseId:r.message_id, chatId:r.chat_jid,chatName:r.chat_name,
      sender:r.sender_jid || r.sender_phone, senderName:r.sender_name,timestamp:Date.parse(r.timestamp_utc+"Z")/1000,
      text:r.text_content || "",isFromMe:Boolean(r.is_from_me),isGroup:r.chat_jid.endsWith("@g.us"),type:r.message_type,
      media:parse(r.media),state:r.receipt_state || "historical_unverified",historicalStatus:r.receipt_state?undefined:r.status,
      deletedAt:r.deleted_at,editedAt:r.edited_at };
  }
  getMessage(jid: string, id: string) {
    const key={remoteJid:normalizeJid(jid),id};
    const row=id.startsWith("db:") ? { message_id:Number(id.slice(3)) } : this.findProtocol(key);
    const r=row && this.db.prepare(`SELECT m.*,c.chat_jid,p.wa_id,p.sender_jid,p.media,p.receipt_state,p.deleted_at,p.edited_at
      FROM messages m JOIN chats c ON c.chat_id=m.chat_id LEFT JOIN wa_protocol p ON p.message_id=m.message_id WHERE m.message_id=?`).get(row.message_id);
    if (!r || !this.aliases(key.remoteJid).includes(String(r.chat_jid))) throw new ServiceError("MESSAGE_NOT_FOUND","No stored message matches this chat and ID.");
    const aliases=this.aliases(key.remoteJid);
    return {...this.present(r), receipts:this.db.prepare(`SELECT recipient,state,updated_at FROM wa_receipts WHERE jid IN (${aliases.map(()=>"?")}) AND wa_id=?`).all(...aliases,id),
      receiptScope:String(r.chat_jid).endsWith("@g.us")?"at_least_one_recipient":"direct"};
  }
  raw(jid: string, id: string) {
    const row=this.findProtocol({remoteJid:jid,id});
    if (row?.deleted_at) throw new ServiceError("MEDIA_UNAVAILABLE","The stored message was deleted.");
    const raw=parse(row?.raw);
    if (!raw?.message || !mediaMeta(raw.message)) throw new ServiceError("MEDIA_UNAVAILABLE","No persisted media envelope is available. Historical exports cannot reconstruct media keys.");
    return raw;
  }
  chats(limit=20,offset=0,query="") {
    return this.db.prepare(`SELECT chat_jid AS id,chat_name AS name,chat_type,total_messages,last_activity,target_phone
      FROM chats WHERE chat_name LIKE ? OR chat_jid LIKE ? ORDER BY last_activity DESC,chat_id DESC LIMIT ? OFFSET ?`)
      .all(`%${query}%`,`%${query}%`,limit,offset).map((r:any)=>({...r,isGroup:r.chat_type==="group",unreadCount:null}));
  }
  contacts(query: string, limit=20,offset=0) {
    return this.db.prepare(`SELECT c.jid,c.name,l.pn AS verifiedPhoneJid FROM wa_contacts c LEFT JOIN wa_lid_mappings l ON l.lid=c.jid
      WHERE c.jid LIKE ? OR c.name LIKE ? UNION SELECT chat_jid,chat_name,NULL FROM chats
      WHERE chat_type='direct' AND (chat_jid LIKE ? OR chat_name LIKE ?) ORDER BY name LIMIT ? OFFSET ?`)
      .all(...Array(4).fill(`%${query}%`),limit,offset);
  }
  operation(id: string): any { return this.db.prepare("SELECT * FROM wa_operations WHERE request_id=?").get(id); }
  beginOperation(id: string, fingerprint: string, jid: string, waId: string, kind: string) {
    const old=this.operation(id);
    if(old) {
      if(old.fingerprint!==fingerprint) throw new ServiceError("REQUEST_ID_CONFLICT","This request_id was already used with different content.");
      return old;
    }
    const now=new Date().toISOString();
    this.db.prepare("INSERT INTO wa_operations(request_id,fingerprint,jid,wa_id,state,kind,created_at,updated_at,error_code) VALUES(?,?,?,?,?,?,?,?,NULL)").run(id,fingerprint,jid,waId,"submitted",kind,now,now);
    return undefined;
  }
  reserveAttributedOperation(id: string, fingerprint: string, jid: string, waId: string, kind: string) {
    const old=this.operation(id);
    if(old) {
      if(old.fingerprint!==fingerprint) throw new ServiceError("REQUEST_ID_CONFLICT","This request_id was already used with different content.");
      return {operation:old, attributionIndex:Number(old.attribution_index || 4), created:false};
    }
    const aliases=this.aliases(jid);
    const placeholders=aliases.map(()=>"?").join(",");
    const prefix="Message sent by 'Auto' (your assistant agent)";
    this.db.prepare(`INSERT OR IGNORE INTO wa_attribution_counts(jid,count)
      SELECT ?,COUNT(*) FROM messages m JOIN chats c ON c.chat_id=m.chat_id
      WHERE c.chat_jid IN (${placeholders}) AND m.is_from_me=1 AND m.text_content LIKE ? || '%'`).run(jid,...aliases,prefix);
    const row=this.db.prepare("SELECT count FROM wa_attribution_counts WHERE jid=?").get(jid);
    const attributionIndex=Number(row?.count || 0)+1;
    this.db.prepare("INSERT INTO wa_attribution_counts(jid,count) VALUES(?,?) ON CONFLICT(jid) DO UPDATE SET count=excluded.count").run(jid,attributionIndex);
    const now=new Date().toISOString();
    this.db.prepare("INSERT INTO wa_operations(request_id,fingerprint,jid,wa_id,state,kind,created_at,updated_at,error_code,attribution_index) VALUES(?,?,?,?,?,?,?,?,NULL,?)")
      .run(id,fingerprint,jid,waId,"submitted",kind,now,now,attributionIndex);
    return {operation:this.operation(id),attributionIndex,created:true};
  }
  operationState(id: string,state: Outcome,error?: string) {
    const op=this.operation(id);
    // Late network failures cannot erase positive receipts.
    if (op && ranks[String(op.state)]>=2 && ranks[state]<ranks[String(op.state)]) return;
    this.db.prepare("UPDATE wa_operations SET state=?,error_code=?,updated_at=? WHERE request_id=?").run(state,error||null,new Date().toISOString(),id);
  }
  close() { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); this.db.close(); }
}
