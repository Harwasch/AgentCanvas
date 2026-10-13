// Hub-stored canvas nodes: notes, to-do lists and items, agent-created to-dos,
// suggestions, reviews, file nodes (pinned to a commit) and terminals.
import crypto from 'node:crypto';
import type { Ctx } from './ctx.js';
import { j } from './db.js';
import { fileKind, parseSource, safePath, type FileSource } from './files.js';
import type { Session } from './store.js';
import { log } from './events.js';

const L = log('nodes');
const id = (p: string) => `${p}-${crypto.randomBytes(5).toString('hex')}`;

export type CNodeType = 'note' | 'todos' | 'htodo' | 'suggest' | 'review' | 'file' | 'terminal';

/** Start a session from a spawn-dialog-shaped body (shared by the API, to-do dispatch and suggestions). */
export async function spawnSession(c: Ctx, b: any): Promise<Session> {
  const need = (v: any, n: string) => {
    if (v === undefined || v === null || v === '') throw new Error(`${n} is required`);
    return v;
  };
  const vendor = need(b.vendor, 'vendor');
  const accountId = need(b.accountId, 'accountId');
  c.account(accountId);
  let checkoutId = b.checkoutId;
  if (!checkoutId && b.branchId) {
    const br = c.projects.branch(b.branchId);
    checkoutId = br?.checkouts?.[0] ?? c.projects.project(br?.projectId)?.checkouts?.[0];
  }
  if (b.where === 'cloud') {
    checkoutId = need(checkoutId, 'checkoutId');
    const prompt = need(b.prompt, 'prompt');
    const branch = b.branch ?? (b.branchId ? c.projects.branch(b.branchId)?.name : undefined);
    if (vendor === 'claude') return c.cloud.startClaude({ accountId, checkoutId, branch, environment: b.environment, prompt });
    if (vendor === 'codex') return c.cloud.startCodex({ accountId, checkoutId, branch, environment: need(b.environment, 'environment'), prompt, attempts: b.attempts ? Number(b.attempts) : undefined });
    throw new Error('unknown vendor');
  }
  const hostId = b.where && b.where !== 'host' ? b.where : need(b.hostId, 'hostId');
  let co = checkoutId ? c.repos.checkout(checkoutId) : undefined;
  if (co && co.host_id !== hostId) {
    // same branch checked out on the chosen host?
    const alt = c.db.all('SELECT * FROM checkout WHERE host_id=? AND repo_id=?', hostId, co.repo_id).map((r) => c.repos.row(r));
    co = alt.find((x) => x.branch === co!.branch) ?? alt[0];
  }
  const cwd = co?.path ?? need(b.cwd, 'cwd or checkoutId');
  const o = { hostId, accountId, cwd, checkoutId: co?.id ?? null, branch: co?.branch ?? b.branch ?? null, prompt: b.prompt, model: b.model, effort: b.effort };
  if (vendor === 'claude') return c.claude.start(o);
  if (vendor === 'codex') return c.codex.start(o);
  throw new Error('unknown vendor');
}

/** Deliver a user message to a session (local Claude/Codex, or a Claude cloud session). */
export async function sendToSession(c: Ctx, s: Session, text: string) {
  if (s.kind === 'cloud') {
    if (s.vendor === 'claude') return c.cloud.sendClaude(s.id, text);
    throw new Error('Codex cloud tasks cannot be continued outside ChatGPT; open it there');
  }
  if (s.vendor === 'claude') return c.claude.send(s.id, text);
  return c.codex.send(s.id, text);
}

export class NodeService {
  private timer?: NodeJS.Timeout;
  constructor(private c: Ctx) {}

  // ------------------------------------------------------------ cnodes
  view(r: any) {
    return r ? { id: r.id, type: r.type, parentId: r.parent_id, data: j<any>(r.data, {}), createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at } : undefined;
  }
  all() {
    return this.c.db.all('SELECT * FROM cnode ORDER BY created_at').map((r) => this.view(r));
  }
  get(nid: string) {
    return this.view(this.c.db.get('SELECT * FROM cnode WHERE id=?', nid));
  }
  private put(n: { id: string; type: CNodeType; parentId: string | null; data: any; createdBy: string }) {
    const prev = this.c.db.get('SELECT created_at FROM cnode WHERE id=?', n.id);
    this.c.db.upsert('cnode', { id: n.id, type: n.type, parent_id: n.parentId, data: n.data, created_by: n.createdBy, created_at: prev?.created_at ?? Date.now(), updated_at: Date.now() });
    const v = this.get(n.id)!;
    this.c.bus.publish('cnode.upsert', v);
    return v;
  }
  patch(nid: string, data: any) {
    const n = this.get(nid);
    if (!n) throw new Error('unknown node');
    const allowed: Record<string, string[]> = { note: ['title', 'text'], todos: ['title'], review: ['checklist'], file: [], terminal: [], suggest: [], htodo: [] };
    const clean: any = {};
    for (const k of Object.keys(data || {})) if ((allowed[n.type] || []).includes(k)) clean[k] = data[k];
    return this.put({ id: n.id, type: n.type as CNodeType, parentId: n.parentId, data: { ...n.data, ...clean }, createdBy: n.createdBy });
  }
  remove(nid: string) {
    const n = this.get(nid);
    if (!n) return;
    if (n.type === 'terminal') this.c.terminals.close(nid).catch(() => {});
    this.c.db.run('DELETE FROM cnode WHERE id=?', nid);
    this.c.bus.publish('cnode.remove', { id: nid });
  }

  async create(type: CNodeType, parentId: string | null, data: any, createdBy = 'you') {
    switch (type) {
      case 'note':
        return this.put({ id: id('note'), type, parentId, data: { title: String(data?.title || 'Note'), text: String(data?.text || '') }, createdBy });
      case 'todos':
        return this.put({ id: id('todos'), type, parentId, data: { title: String(data?.title || (data?.scope ? `To-dos · ${this.c.projects.project(data.scope)?.name ?? ''}` : 'My to-dos')), scope: data?.scope ?? null }, createdBy });
      case 'file': {
        const source = parseSource(data?.source);
        const path = safePath(String(data?.path || ''));
        const pin = await this.c.files.pin(source, path);
        return this.put({ id: id('file'), type, parentId, data: { source, path, sha: pin.sha, blob: pin.blob, kind: fileKind(path), subject: pin.subject ?? null, newer: null }, createdBy });
      }
      case 'terminal':
        return this.c.terminals.create({ hostId: data?.hostId, cwd: data?.cwd, sessionId: data?.sessionId ?? null, parentId });
      default:
        throw new Error(`nodes of type ${type} are created by agents`);
    }
  }

  /** used by TerminalService */
  putTerminal(nid: string, parentId: string | null, data: any) {
    return this.put({ id: nid, type: 'terminal', parentId, data, createdBy: 'you' });
  }

  // ------------------------------------------------------------ to-dos
  todoView(r: any) {
    return r ? { id: r.id, scope: r.scope, text: r.text, src: r.src, done: !!r.done, dispatchedSessionId: r.dispatched_session_id, createdAt: r.created_at } : undefined;
  }
  todos() {
    return this.c.db.all('SELECT * FROM todo ORDER BY created_at').map((r) => this.todoView(r));
  }
  addTodo(text: string, scope: string | null, src = 'you') {
    if (!text?.trim()) throw new Error('text is required');
    const t = { id: id('todo'), scope, text: text.trim().slice(0, 500), src, done: 0, dispatched_session_id: null, created_at: Date.now() };
    this.c.db.upsert('todo', t);
    const v = this.todoView(this.c.db.get('SELECT * FROM todo WHERE id=?', t.id))!;
    this.c.bus.publish('todo.upsert', v);
    return v;
  }
  updateTodo(tid: string, p: { text?: string; done?: boolean; dispatched_session_id?: string }) {
    const r = this.c.db.get('SELECT * FROM todo WHERE id=?', tid);
    if (!r) throw new Error('unknown to-do');
    this.c.db.upsert('todo', { id: tid, ...(p.text !== undefined ? { text: p.text } : {}), ...(p.done !== undefined ? { done: p.done ? 1 : 0 } : {}), ...(p.dispatched_session_id ? { dispatched_session_id: p.dispatched_session_id } : {}) });
    const v = this.todoView(this.c.db.get('SELECT * FROM todo WHERE id=?', tid))!;
    this.c.bus.publish('todo.upsert', v);
    return v;
  }
  removeTodo(tid: string) {
    this.c.db.run('DELETE FROM todo WHERE id=?', tid);
    this.c.bus.publish('todo.remove', { id: tid });
  }
  async dispatchTodo(tid: string, b: any) {
    const t = this.todoView(this.c.db.get('SELECT * FROM todo WHERE id=?', tid));
    if (!t) throw new Error('unknown to-do');
    const s = await spawnSession(this.c, { ...b, prompt: t.text });
    this.updateTodo(tid, { dispatched_session_id: s.id });
    return s;
  }

  // ------------------------------------------------------------ agent-created nodes
  agentTodo(s: Session, text: string, project?: string) {
    const scope = project ?? (s.checkout_id ? this.c.repos.checkout(s.checkout_id)?.repo_id : null) ?? null;
    const t = this.addTodo(text, scope, s.id);
    return this.put({ id: id('htodo'), type: 'htodo', parentId: s.id, data: { todoId: t!.id }, createdBy: s.id });
  }

  suggest(s: Session, a: { title: string; prompt: string; rationale?: string; vendor?: string; host?: string; account?: string }) {
    const n = this.put({
      id: id('suggest'), type: 'suggest', parentId: s.id, createdBy: s.id,
      data: {
        title: String(a.title).slice(0, 120), prompt: String(a.prompt || a.title), rationale: String(a.rationale || ''), vendor: a.vendor === 'codex' ? 'codex' : a.vendor === 'claude' ? 'claude' : s.vendor,
        hostId: a.host ?? s.host_id, accountId: a.account ?? s.account_id, branchId: null, checkoutId: s.checkout_id, status: 'open',
      },
    });
    this.c.push.notify({ title: 'Agent suggests a follow-up', body: n.data.title, tag: n.id, url: `/?focus=${n.id}` });
    return n;
  }

  async launchSuggestion(nid: string, over: any = {}) {
    const n = this.get(nid);
    if (!n || n.type !== 'suggest') throw new Error('unknown suggestion');
    if (n.data.status !== 'open') throw new Error(`suggestion already ${n.data.status}`);
    const d = n.data;
    const s = await spawnSession(this.c, { vendor: over.vendor ?? d.vendor, where: over.where ?? d.hostId ?? 'cloud', hostId: over.where ?? d.hostId, accountId: over.accountId ?? d.accountId, checkoutId: over.checkoutId ?? d.checkoutId, prompt: d.prompt, environment: over.environment });
    this.put({ id: n.id, type: 'suggest', parentId: n.parentId, data: { ...d, status: 'launched', sessionId: s.id }, createdBy: n.createdBy });
    return s;
  }
  dismissSuggestion(nid: string) {
    const n = this.get(nid);
    if (!n || n.type !== 'suggest') throw new Error('unknown suggestion');
    return this.put({ id: n.id, type: 'suggest', parentId: n.parentId, data: { ...n.data, status: 'dismissed' }, createdBy: n.createdBy });
  }

  async requestReview(s: Session, a: { path: string; title?: string; note?: string; promote_to?: string; checklist?: string[]; kind?: string }) {
    const co = s.checkout_id ? this.c.repos.checkout(s.checkout_id) : s.host_id && s.cwd ? this.c.repos.checkoutForPath(s.host_id, s.cwd) : undefined;
    if (!co) throw new Error('request_review needs a session working in a known checkout');
    let rel = String(a.path || '');
    if (rel.startsWith('/')) {
      if (!rel.startsWith(co.path + '/')) throw new Error(`${rel} is outside the checkout ${co.path}`);
      rel = rel.slice(co.path.length + 1);
    }
    safePath(rel);
    const source: FileSource = { kind: 'checkout', checkoutId: co.id };
    const pin = await this.c.files.pin(source, rel);
    const n = this.put({
      id: id('review'), type: 'review', parentId: s.id, createdBy: s.id,
      data: {
        sessionId: s.id, title: a.title || rel.split('/').pop(), path: rel, source, sha: pin.sha, blob: pin.blob, kind: a.kind || fileKind(rel), note: a.note || '',
        promoteTo: a.promote_to || null, checklist: (a.checklist || []).slice(0, 20).map((t) => ({ text: String(t), done: false })), comments: [], status: 'pending', newer: null,
      },
    });
    this.c.push.notify({ title: 'Review requested', body: `${s.title}: ${n.data.title}`, tag: n.id, url: `/?focus=${n.id}` });
    return n;
  }

  addComment(nid: string, text: string, author: 'you' | 'agent' = 'you') {
    const n = this.get(nid);
    if (!n || n.type !== 'review') throw new Error('unknown review');
    const comments = [...(n.data.comments || []), { id: id('c'), author, text: String(text).slice(0, 4000), at: Date.now() }];
    return this.put({ id: n.id, type: 'review', parentId: n.parentId, data: { ...n.data, comments }, createdBy: n.createdBy });
  }

  /** Approve / request changes: the decision, checklist and comments go back to the agent as a message. */
  async decideReview(nid: string, decision: 'approve' | 'changes', note?: string) {
    const n = this.get(nid);
    if (!n || n.type !== 'review') throw new Error('unknown review');
    const d = n.data;
    const lines = [
      `Review of ${d.path} @ ${d.sha === 'worktree' ? 'working tree (uncommitted)' : String(d.sha).slice(0, 8)}: ${decision === 'approve' ? 'APPROVED' : 'CHANGES REQUESTED'}.`,
      note ? `Note: ${note}` : '',
      d.checklist?.length ? `Checklist: ${d.checklist.map((c: any) => `[${c.done ? 'x' : ' '}] ${c.text}`).join('; ')}` : '',
      ...(d.comments || []).filter((c: any) => c.author === 'you').map((c: any) => `Comment: ${c.text}`),
      decision === 'approve' && d.promoteTo ? `You may now promote it to ${d.promoteTo}.` : '',
    ].filter(Boolean);
    const s = this.c.store.session(d.sessionId);
    if (s && s.status !== 'ended') {
      try {
        if (s.kind === 'cloud') {
          if (s.vendor === 'claude') await this.c.cloud.sendClaude(s.id, lines.join('\n'));
        } else if (s.vendor === 'claude') await this.c.claude.send(s.id, lines.join('\n'));
        else await this.c.codex.send(s.id, lines.join('\n'));
      } catch (e: any) {
        L(`review ${nid}: could not deliver to ${s.id}: ${e.message}`);
      }
    }
    return this.put({ id: n.id, type: 'review', parentId: n.parentId, data: { ...d, status: decision === 'approve' ? 'approved' : 'changes', decisionNote: note || '' }, createdBy: n.createdBy });
  }

  // ------------------------------------------------------------ pins
  async latest(nid: string) {
    const n = this.get(nid);
    if (!n || (n.type !== 'file' && n.type !== 'review')) throw new Error('not a file node');
    const pin = await this.c.files.pin(n.data.source, n.data.path);
    return this.put({ id: n.id, type: n.type as CNodeType, parentId: n.parentId, data: { ...n.data, sha: pin.sha, blob: pin.blob, subject: pin.subject ?? null, newer: null }, createdBy: n.createdBy });
  }

  /** Detect newer versions of pinned files; live (worktree) pins just follow the file. */
  async checkNewer() {
    for (const n of this.all()) {
      if (!n || (n.type !== 'file' && n.type !== 'review')) continue;
      try {
        const pin = await this.c.files.pin(n.data.source, n.data.path);
        let data = n.data;
        if (n.data.sha === 'worktree') {
          if (pin.sha === 'worktree' && pin.blob !== n.data.blob) data = { ...n.data, blob: pin.blob };
          else if (pin.sha !== 'worktree') data = { ...n.data, sha: pin.sha, blob: pin.blob, subject: pin.subject ?? null };
        } else if (pin.sha !== n.data.sha) {
          const newer = { sha: pin.sha, subject: pin.subject ?? (pin.sha === 'worktree' ? 'uncommitted changes' : ''), at: pin.at ?? Date.now() };
          if (JSON.stringify(newer) !== JSON.stringify(n.data.newer)) data = { ...n.data, newer };
        } else if (n.data.newer) data = { ...n.data, newer: null };
        if (data !== n.data) this.put({ id: n.id, type: n.type as CNodeType, parentId: n.parentId, data, createdBy: n.createdBy });
      } catch {
        /* host offline or file gone: leave the pin */
      }
    }
  }

  start() {
    this.timer = setInterval(() => this.checkNewer().catch(() => {}), Math.max(10, this.c.cfg.githubPollIntervalSec) * 1000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
