import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const now = () => new Date().toISOString();
export class Store {
  db: DatabaseSync;
  private depth = 0;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, 'creative.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,project_id TEXT,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS entities_project ON entities(kind,project_id);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,project_id TEXT NOT NULL,status TEXT NOT NULL,lease_owner TEXT,lease_until INTEGER,next_run INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status,next_run,lease_until);
      CREATE TABLE IF NOT EXISTS idempotency(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, batch_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,type TEXT NOT NULL,entity_id TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations VALUES(1,datetime('now'));`);
  }
  transaction<T>(fn: () => T): T {
    const nested = this.depth > 0,
      savepoint = `tx_${this.depth}`;
    let started = false;
    this.depth++;
    try {
      this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
      started = true;
      const value = fn();
      this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return value;
    } catch (error) {
      if (started) {
        try {
          this.db.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
          if (nested) this.db.exec(`RELEASE ${savepoint}`);
        } catch {
          /* Preserve the original storage error. */
        }
      }
      throw error;
    } finally {
      this.depth--;
    }
  }
  put(kind: string, data: any) {
    this.db
      .prepare(
        'INSERT INTO entities(kind,id,project_id,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,project_id=excluded.project_id',
      )
      .run(kind, data.id, data.project_id ?? null, JSON.stringify(data));
    return data;
  }
  get(kind: string, entityId: string): any {
    const row = this.db.prepare('SELECT data FROM entities WHERE kind=? AND id=?').get(kind, entityId) as any;
    return row ? JSON.parse(row.data) : undefined;
  }
  list(kind: string, projectId?: string): any[] {
    return (
      projectId
        ? this.db
            .prepare('SELECT data FROM entities WHERE kind=? AND project_id=? ORDER BY rowid DESC')
            .all(kind, projectId)
        : this.db.prepare('SELECT data FROM entities WHERE kind=? ORDER BY rowid DESC').all(kind)
    ).map((r: any) => JSON.parse(r.data));
  }
  task(taskId: string): any {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(taskId) as any;
    return row
      ? {
          ...JSON.parse(row.data),
          status: row.status,
          lease_owner: row.lease_owner,
          lease_until: row.lease_until,
          next_run: row.next_run,
        }
      : undefined;
  }
  tasks(batchId?: string): any[] {
    const rows = batchId
      ? this.db.prepare('SELECT id FROM jobs WHERE batch_id=? ORDER BY rowid').all(batchId)
      : this.db.prepare('SELECT id FROM jobs ORDER BY rowid').all();
    return rows.map((r: any) => this.task(r.id));
  }
  saveTask(t: any) {
    this.db
      .prepare(
        `INSERT INTO jobs(id,batch_id,project_id,status,lease_owner,lease_until,next_run,data) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,lease_owner=excluded.lease_owner,lease_until=excluded.lease_until,next_run=excluded.next_run,data=excluded.data`,
      )
      .run(
        t.id,
        t.batch_id,
        t.project_id,
        t.status,
        t.lease_owner ?? null,
        t.lease_until ?? null,
        t.next_run ?? 0,
        JSON.stringify(t),
      );
    return t;
  }
  event(type: string, entityId: string, data: any = {}) {
    const event = { id: id('evt'), type, entity_id: entityId, data, created_at: now() };
    const r = this.db
      .prepare('INSERT INTO events(id,type,entity_id,data,created_at) VALUES(?,?,?,?,?)')
      .run(event.id, type, entityId, JSON.stringify(data), event.created_at);
    return { ...event, seq: Number(r.lastInsertRowid) };
  }
  events(after = 0) {
    return this.db
      .prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 200')
      .all(after)
      .map((r: any) => ({ ...r, data: JSON.parse(r.data) }));
  }
  close() {
    this.db.close();
  }
}
