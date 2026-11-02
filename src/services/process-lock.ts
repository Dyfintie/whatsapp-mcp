import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { ServiceError } from "./errors.js";

// A kernel-managed SQLite lock is released on crash. Never unlink this file:
// unlinking a locked inode would let a second daemon take a different lock.
export function acquireProcessLock(file: string): () => void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
  } catch {
    db.close();
    throw new ServiceError("DAEMON_ALREADY_RUNNING", "Another daemon owns the shared WhatsApp connection. Use the HTTP endpoint or stdio bridge.");
  }
  return () => { db.exec("ROLLBACK"); db.close(); };
}
