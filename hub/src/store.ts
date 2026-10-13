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

/** Command output kept per message (DB and wire): the tail, behind this marker. */
export const OUTPUT_TAIL = 64 * 1024;
export const TRUNCATED = '…truncated…\n';
export function clipTail(s: string, max = OUTPUT_TAIL): string {
  if (s.length <= max + TRUNCATED.length && (s.length <= max || s.startsWith(TRUNCATED))) return s;
  return TRUNCATED + s.slice(-max);
}

interface Stream {
  msg: Message;
  field: 'text' | 'output';
  /** published as one message.append when the coalescing timer fires */
  pend: string;
  /** offset of pend in the text (or in all output ever received): appends are idempotent and gaps are detectable */
  at: number;
  /** pend is the whole (clipped) output, not an append */
  reset: boolean;
  /** not yet written to SQLite */
  dirty?: boolean;
  lastWrite: number;
  pubTimer?: NodeJS.Timeout;
  writeTimer?: NodeJS.Timeout;
}

export class Store {
  private streams = new Map<string, Stream>();
  constructor(public db: Db, public bus: EventBus, private opts: { appendMs?: number; persistMs?: number } = {}) {}

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
  /** Merge into a session's meta without publishing (bookkeeping clients never show). */
  patchMetaQuiet(id: string, patch: Record<string, any>) {
    const r = this.db.get('SELECT meta FROM session WHERE id=?', id);
    if (r) this.db.run('UPDATE session SET meta=? WHERE id=?', JSON.stringify({ ...j(r.meta, {}), ...patch }), id);
  }
  setStatus(id: string, status: SessionStatus, lastEvent?: string) {
    const s = this.session(id);
    if (!s) return;
    if (s.status === status && !lastEvent) return;
    this.upsertSession({ id, status, last_event: lastEvent ?? s.last_event });
  }

  // ---------------- messages
  messages(sessionId: string, limit = 500): Message[] {
    this.flushStreams(sessionId);
    return this.db
      .all('SELECT * FROM (SELECT * FROM message WHERE session_id=? ORDER BY seq DESC LIMIT ?) ORDER BY seq', sessionId, limit)
      .map((r) => ({ ...(r as any), data: j(r.data, null) }));
  }
  /** One message as stored, with any streamed text not yet written included. */
  message(id: string): Message | undefined {
    this.flushStream(id);
    const r = this.db.get('SELECT * FROM message WHERE id=?', id);
    return r ? ({ ...(r as any), data: j(r.data, null) } as Message) : undefined;
  }
  /** Insert or update a message by id. A full upsert ends any delta stream on that id (its text is authoritative). */
  upsertMessage(m: Omit<Message, 'seq' | 'created_at'> & { seq?: number; created_at?: number }): Message {
    this.flushStream(m.id);
    const prev = this.db.get('SELECT seq, created_at, role, kind, text, data FROM message WHERE id=?', m.id);
    const seq = prev?.seq ?? m.seq ?? ((this.db.get('SELECT MAX(seq) s FROM message WHERE session_id=?', m.session_id)?.s ?? 0) + 1);
    const row = { ...m, seq, created_at: prev?.created_at ?? m.created_at ?? Date.now() };
    const out = { ...row, data: m.data ?? null } as Message;
    // a replay (thread resume, transcript re-read) of an unchanged message is neither written nor published
    if (prev && prev.role === m.role && prev.kind === m.kind && prev.text === m.text && (prev.data ?? null) === (m.data == null ? null : JSON.stringify(m.data))) return out;
    this.db.upsert('message', row);
    this.bus.publish('message.upsert', out);
    return out;
  }

  /**
   * Streaming: deltas are appended in memory and published as `message.append` (coalesced per message every
   * `appendMs`), and written to SQLite at most every `persistMs`. The first delta of a new message publishes a
   * `message.upsert` so clients learn its seq, role and kind.
   */
  appendDelta(id: string, sessionId: string, delta: string, init: Partial<Message> = {}) {
    this.stream(id, sessionId, 'text', delta, init);
  }
  /** Command output: only the last OUTPUT_TAIL characters are kept (stored and on the wire), behind a truncation marker. */
  appendOutput(id: string, sessionId: string, delta: string, init: Partial<Message> = {}) {
    this.stream(id, sessionId, 'output', delta, init);
  }
  private stream(id: string, sessionId: string, field: 'text' | 'output', delta: string, init: Partial<Message>) {
    if (!delta) return;
    let st = this.streams.get(id);
    if (!st) {
      const prev = this.message(id);
      if (!prev) {
        const base = { role: 'assistant', kind: 'text', data: null, text: '', ...init } as Message;
        const first = field === 'text' ? { ...base, text: base.text + delta } : { ...base, data: { ...(base.data || {}), output: clipTail(delta), outputLen: delta.length } };
        this.upsertMessage({ ...first, id, session_id: sessionId });
        return;
      }
      st = { msg: prev, field, pend: '', at: 0, reset: false, lastWrite: 0 };
      this.streams.set(id, st);
    }
    const m = st.msg;
    st.field = field;
    if (field === 'text') {
      if (!st.pend) st.at = m.text.length;
      m.text += delta;
      st.pend += delta;
    } else {
      const before = String(m.data?.output ?? '');
      const len = Number(m.data?.outputLen ?? before.length);
      if (!st.pend) st.at = len;
      const out = clipTail(before + delta);
      m.data = { ...(m.data || {}), output: out, outputLen: len + delta.length };
      st.pend += delta;
      // the pending append alone is longer than the kept tail: clients replace the output instead
      if (st.reset || st.pend.length > OUTPUT_TAIL) {
        st.reset = true;
        st.pend = out;
      }
    }
    st.dirty = true;
    st.pubTimer ??= setTimeout(() => this.publishStream(id), this.opts.appendMs ?? 100);
    st.writeTimer ??= setTimeout(() => this.writeStream(id), Math.max(0, (this.opts.persistMs ?? 500) - (Date.now() - st.lastWrite)));
  }
  private publishStream(id: string) {
    const st = this.streams.get(id);
    if (!st) return;
    clearTimeout(st.pubTimer);
    st.pubTimer = undefined;
    if (st.pend) {
      const m = st.msg;
      const out = st.field === 'output';
      this.bus.publish('message.append', {
        id, session_id: m.session_id, seq: m.seq, kind: m.kind, ...(out ? { field: 'output' } : {}), append: st.pend,
        ...(st.reset ? { reset: true, len: m.data.outputLen } : { at: st.at }),
      });
      st.pend = '';
      st.reset = false;
    }
    if (!st.dirty && !st.writeTimer) this.streams.delete(id);
  }
  private writeStream(id: string) {
    const st = this.streams.get(id);
    if (!st) return;
    clearTimeout(st.writeTimer);
    st.writeTimer = undefined;
    if (st.dirty) {
      const m = st.msg;
      this.db.run('UPDATE message SET text=?, data=? WHERE id=?', m.text, m.data == null ? null : JSON.stringify(m.data), id);
      st.dirty = false;
      st.lastWrite = Date.now();
    }
    if (!st.pend && !st.pubTimer) this.streams.delete(id);
  }
  /** Publish and write whatever a stream holds now (before a full upsert or a read of that message). */
  flushStream(id: string) {
    if (!this.streams.has(id)) return;
    this.publishStream(id);
    this.writeStream(id);
    this.streams.delete(id);
  }
  /** Flush every open stream (of one session): reads, shutdown. */
  flushStreams(sessionId?: string) {
    for (const [id, st] of [...this.streams]) if (!sessionId || st.msg.session_id === sessionId) this.flushStream(id);
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
