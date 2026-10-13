// SQLite state. Cheap to rebuild; never the only copy of a conversation.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS host (
  id TEXT PRIMARY KEY, label TEXT, target TEXT NOT NULL, port INTEGER, color TEXT,
  roots TEXT, bins TEXT, status TEXT DEFAULT 'unknown', last_seen INTEGER, info TEXT
);
CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY, label TEXT, color TEXT, cfg TEXT
);
CREATE TABLE IF NOT EXISTS repo (
  id TEXT PRIMARY KEY, remote_url TEXT, name TEXT, gh_account TEXT
);
CREATE TABLE IF NOT EXISTS checkout (
  id TEXT PRIMARY KEY, host_id TEXT, path TEXT, repo_id TEXT, branch TEXT, head TEXT,
  head_subject TEXT, head_time INTEGER, upstream TEXT, ahead INTEGER, behind INTEGER, dirty INTEGER,
  changes TEXT, apps TEXT, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY, vendor TEXT, kind TEXT, host_id TEXT, account_id TEXT, checkout_id TEXT,
  cwd TEXT, native_id TEXT, native_url TEXT, title TEXT, status TEXT, last_event TEXT,
  model TEXT, effort TEXT, branch TEXT, created_at INTEGER, updated_at INTEGER, meta TEXT
);
CREATE INDEX IF NOT EXISTS session_native ON session(native_id);
CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, role TEXT, kind TEXT, text TEXT,
  data TEXT, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS message_session ON message(session_id, seq);
CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY, session_id TEXT, source TEXT, title TEXT, detail TEXT, data TEXT,
  status TEXT, decided_by TEXT, created_at INTEGER, resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS app_node (
  id TEXT PRIMARY KEY, app_id TEXT, session_id TEXT, host_id TEXT, dir TEXT, checkout_id TEXT,
  title TEXT, manifest TEXT, state TEXT, version INTEGER, pinned_commit TEXT, pinned_dir TEXT,
  granted_version INTEGER, status TEXT, errors TEXT, logs TEXT, thumbnail TEXT, preview_of TEXT,
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS layout (
  node_id TEXT PRIMARY KEY, x REAL, y REAL, w REAL, h REAL, collapsed INTEGER
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, app_node_id TEXT, tool TEXT, tier TEXT,
  caller TEXT, args TEXT, allowed INTEGER, reason TEXT, result TEXT
);
CREATE TABLE IF NOT EXISTS push_sub (
  endpoint TEXT PRIMARY KEY, keys TEXT, created_at INTEGER
);
`;

export type Row = Record<string, any>;

export class Db {
  sql: DatabaseSync;
  constructor(dataDir: string | ':memory:') {
    this.sql = new DatabaseSync(dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'hub.sqlite'));
    this.sql.exec('PRAGMA journal_mode=WAL;');
    this.sql.exec(SCHEMA);
  }
  all(q: string, ...p: any[]): Row[] {
    return this.sql.prepare(q).all(...p) as Row[];
  }
  get(q: string, ...p: any[]): Row | undefined {
    return this.sql.prepare(q).get(...p) as Row | undefined;
  }
  run(q: string, ...p: any[]) {
    return this.sql.prepare(q).run(...p);
  }
  /** INSERT OR REPLACE-style upsert that only touches the provided columns. */
  upsert(table: string, row: Row, key = 'id') {
    const cols = Object.keys(row);
    const vals = cols.map((c) => enc(row[c]));
    const set = cols.filter((c) => c !== key).map((c) => `${c}=excluded.${c}`).join(',');
    this.run(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
       ON CONFLICT(${key}) DO ${set ? 'UPDATE SET ' + set : 'NOTHING'}`,
      ...vals,
    );
  }
}

function enc(v: any) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

export function j<T = any>(v: any, dflt: T | null): T {
  if (v == null || v === "") return dflt as T;
  try {
    return JSON.parse(v);
  } catch {
    return dflt as T;
  }
}
