// Typed accessors over SQLite that also publish events. The vendor store stays
// the source of truth; rows here are a cache for display and routing.
import crypto from 'node:crypto';
import { Db, j, Row } from './db.js';
import { EventBus } from './events.js';

export type SessionStatus = 'starting' | 'running' | 'idle' | 'waiting' | 'ended' | 'error' | 'pending' | 'ready' | 'applied';

export interface Session {
  id: string;
  vendor: 'claude' | 'codex';
  kind: 'local' | 'cloud';
  host_id: string | null;
  account_id: string;
  checkout_id: string | null;
  cwd: string | null;
  branch: string | null;
  native_id: string | null;
  native_url: string | null;
  title: string;
  status: SessionStatus;
  last_event: string | null;
  model: string | null;
  effort: string | null;
  created_at: number;
  updated_at: number;
  meta: Record<string, any>;
}

export interface Message {
  id: string;
  session_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  kind: 'text' | 'tool' | 'command' | 'reasoning' | 'status';
  text: string;
  data: any;
  created_at: number;
}

export interface Approval {
  id: string;
  session_id: string;
  source: 'codex' | 'claude-channel' | 'claude-hook' | 'app-confirm' | 'canvas-action';
  title: string;
  detail: string;
  data: any;
  status: 'pending' | 'allow' | 'deny' | 'expired';
  decided_by?: string | null;
  created_at: number;
}

export const newId = (p = '') => p + crypto.randomBytes(6).toString('hex');

/** Approval sources whose waiter lives only in hub memory (a pending tool call, a held hook response, a JSON-RPC request on one connection). */
export const IN_MEMORY_SOURCES: ReadonlySet<Approval['source']> = new Set(['canvas-action', 'app-confirm', 'claude-hook', 'codex']);

export class Store {
  constructor(public db: Db, public bus: EventBus) {}

  // ---------------- sessions
  session(id: string): Session | undefined {
    const r = this.db.get('SELECT * FROM session WHERE id=?', id);
    return r ? this.toSession(r) : undefined;
  }
  sessionByNative(nativeId: string): Session | undefined {
    const r = this.db.get('SELECT * FROM session WHERE native_id=? ORDER BY updated_at DESC', nativeId);
    return r ? this.toSession(r) : undefined;
  }
  sessions(where = '1=1', ...p: any[]): Session[] {
    return this.db.all(`SELECT * FROM session WHERE ${where} ORDER BY created_at`, ...p).map((r) => this.toSession(r));
  }
  private toSession(r: Row): Session {
    return { ...(r as any), meta: j(r.meta, {}) };
  }
  upsertSession(s: Partial<Session> & { id: string }): Session {
    const prev = this.session(s.id);
    const meta = s.meta ? { ...(prev?.meta || {}), ...s.meta } : prev?.meta || {};
    const row = { ...s, meta, updated_at: Date.now() } as any;
    if (!prev) row.created_at = s.created_at ?? Date.now();
    this.db.upsert('session', row);
    const out = this.session(s.id)!;
    this.bus.publish('session.upsert', out);
    return out;
  }
  setStatus(id: string, status: SessionStatus, lastEvent?: string) {
    const s = this.session(id);
    if (!s) return;
    if (s.status === status && !lastEvent) return;
    this.upsertSession({ id, status, last_event: lastEvent ?? s.last_event });
  }

  // ---------------- messages
  messages(sessionId: string, limit = 500): Message[] {
    return this.db
      .all('SELECT * FROM (SELECT * FROM message WHERE session_id=? ORDER BY seq DESC LIMIT ?) ORDER BY seq', sessionId, limit)
      .map((r) => ({ ...(r as any), data: j(r.data, null) }));
  }
  /** Insert or update a message by id (streaming deltas update text). */
  upsertMessage(m: Omit<Message, 'seq' | 'created_at'> & { seq?: number; created_at?: number }): Message {
    const prev = this.db.get('SELECT seq, created_at FROM message WHERE id=?', m.id);
    const seq = prev?.seq ?? m.seq ?? ((this.db.get('SELECT MAX(seq) s FROM message WHERE session_id=?', m.session_id)?.s ?? 0) + 1);
    const row = { ...m, seq, created_at: prev?.created_at ?? m.created_at ?? Date.now() };
    this.db.upsert('message', row);
    const out = { ...row, data: m.data ?? null } as Message;
    this.bus.publish('message.upsert', out);
    return out;
  }
  appendDelta(id: string, sessionId: string, delta: string, init: Partial<Message> = {}) {
    const prev = this.db.get('SELECT text FROM message WHERE id=?', id);
    this.upsertMessage({ id, session_id: sessionId, role: 'assistant', kind: 'text', data: null, ...init, text: (prev?.text ?? '') + delta } as any);
  }

  // ---------------- approvals
  approval(id: string): Approval | undefined {
    const r = this.db.get('SELECT * FROM approval WHERE id=?', id);
    return r ? ({ ...(r as any), data: j(r.data, {}) } as Approval) : undefined;
  }
  pendingApprovals(): Approval[] {
    return this.db.all("SELECT * FROM approval WHERE status='pending' ORDER BY created_at").map((r) => ({ ...(r as any), data: j(r.data, {}) }));
  }
  /**
   * On hub start: pending approvals whose waiter lived in the previous process can never be answered, so they are expired
   * (Codex re-sends its requests on reconnect as new rows). Channel approvals go through the session's channel and stay,
   * unless their session is gone. Returns the expired ids.
   */
  expireOrphanedApprovals(): string[] {
    const out: string[] = [];
    for (const a of this.pendingApprovals()) {
      const s = this.session(a.session_id);
      const sessionGone = !s || s.status === 'ended' || s.status === 'error';
      if (IN_MEMORY_SOURCES.has(a.source) || (a.source === 'claude-channel' && sessionGone)) {
        this.upsertApproval({ id: a.id, status: 'expired', decided_by: 'hub restart' });
        out.push(a.id);
      }
    }
    return out;
  }
  upsertApproval(a: Partial<Approval> & { id: string }): Approval {
    const prev = this.approval(a.id);
    this.db.upsert('approval', { ...a, created_at: prev?.created_at ?? Date.now(), ...(a.status && a.status !== 'pending' ? { resolved_at: Date.now() } : {}) });
    const out = this.approval(a.id)!;
    this.bus.publish('approval.upsert', out);
    return out;
  }
}
