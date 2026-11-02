import { DatabaseSync, backup } from "./encrypted-db.js";
import { mkdirSync, chmodSync, existsSync, readdirSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { BufferJSON, initAuthCreds, proto, type AuthenticationState } from "@whiskeysockets/baileys";

export class AuthStore {
  readonly db: DatabaseSync;
  readonly state: AuthenticationState;
  private closed = false;
  private file: string;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.file = join(dir, "auth.sqlite");
    this.db = new DatabaseSync(this.file);
    chmodSync(this.file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS auth (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    for (const table of ["auth", "meta"]) {
      for (const action of ["INSERT", "UPDATE"]) this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS guard_${table}_${action} BEFORE ${action} ON ${table}
        WHEN new.name IS NULL BEGIN SELECT RAISE(ABORT,'Authentication key cannot be null'); END;`);
    }
    if (!this.db.prepare("SELECT 1 FROM meta WHERE name='initialized'").get()) {
      if(readdirSync(dir).some(f=>f.endsWith('.json'))) {
        this.db.close();throw new Error('Legacy plaintext auth import is disabled. Link using a fresh private state directory.');
      }
      this.db.prepare("INSERT INTO meta VALUES ('initialized','1')").run();
    }
    const creds = this.get("creds.json") || initAuthCreds();
    this.state = {
      creds,
      keys: {
        get: (type, ids) => {
          this.assertOpen();
          const result: any = {};
          for (const id of ids) {
            let value = this.get(this.key(type, id));
            if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            result[id] = value;
          }
          return result;
        },
        set: data => {
          this.transaction(() => {
            for (const [type, entries] of Object.entries(data)) {
              for (const [id, value] of Object.entries(entries || {})) {
                if (value == null) this.db.prepare("DELETE FROM auth WHERE name=?").run(this.key(type, id));
                else this.put(this.key(type, id), value);
              }
            }
            // Each Signal key batch and the current credential snapshot commit together.
            this.put("creds.json", this.state.creds);
          });
        },
      },
    };
    this.saveCreds();
  }
  private assertOpen() { if (this.closed) throw new Error("Auth store closed"); }
  private key(type: string, id: string) { return `${type}-${id}.json`.replace(/\//g, "__").replace(/:/g, "-"); }
  private get(name: string) {
    const r = this.db.prepare("SELECT value FROM auth WHERE name=?").get(name);
    return r ? JSON.parse(String(r.value), BufferJSON.reviver) : null;
  }
  private put(name: string, value: unknown) {
    this.db.prepare("INSERT OR REPLACE INTO auth VALUES (?,?)").run(name, JSON.stringify(value, BufferJSON.replacer));
  }
  private transaction(work: () => void) {
    this.assertOpen(); this.db.exec("BEGIN IMMEDIATE");
    try { work(); this.db.exec("COMMIT"); } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  saveCreds = () => { this.transaction(() => this.put("creds.json", this.state.creds)); };
  // Writes are synchronous FULL transactions, so there is no pending async write queue.
  async flush() { this.assertOpen(); this.db.exec("PRAGMA wal_checkpoint(FULL)"); }
  get terminalReason(): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE name='terminal'").get();
    return row ? String(row.value) : undefined;
  }
  setTerminal(reason: string) { this.db.prepare("INSERT OR REPLACE INTO meta VALUES ('terminal',?)").run(reason); }
  async reset(): Promise<string> {
    await this.flush();
    const dest = `${this.file}.backup-${Date.now()}`;
    await backup(this.db, dest); chmodSync(dest, 0o600);
    this.transaction(() => {
      this.db.exec("DELETE FROM auth; DELETE FROM meta WHERE name='terminal'");
      this.state.creds = initAuthCreds(); this.put("creds.json", this.state.creds);
    });
    return dest;
  }
  async close() { if (!this.closed) { await this.flush(); this.closed = true; this.db.close(); } }
}
