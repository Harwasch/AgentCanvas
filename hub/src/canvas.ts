// Canvas tools: what Claude (the Ask Claude assistant, an agent on a host, or an external
// MCP client) can do to the canvas, in three tiers:
//   free     read and arrange the canvas, add notes / files / to-dos (applied live, undoable)
//   confirm  start sessions, message agents, run HIL, create branches, open terminals
//            (the hub asks you first; the tool call waits for your decision)
//   never    approving agents' tool calls or actuating hardware: no tool exists for it
// Positions come from the PWA, which reports what it is showing (its layout is computed in
// the browser); edits are written as saved layout entries and announced as canvas.changed.
import type { Ctx } from './ctx.js';
import { newId, type Session } from './store.js';
import { spawnSession, sendToSession } from './nodes.js';
import { validRef } from './projects.js';
import { log } from './events.js';

const L = log('canvas');

export interface CanvasCaller { kind: 'assistant' | 'agent' | 'external'; sessionId: string | null; label: string }
export interface ViewNode { id: string; kind: string; title: string; parent: string | null; x: number; y: number; w: number; h: number; ex?: boolean }
export interface ViewReport { at: number; mode: string; nodes: ViewNode[]; selected: string[]; focusId: string | null; visible?: { x: number; y: number; w: number; h: number } | null }

type Op =
  | { t: 'layout'; id: string; prev: Record<string, any> | null }
  | { t: 'created'; cnodeId: string }
  | { t: 'removed'; row: Record<string, any> }
  | { t: 'todo'; todoId: string };
interface Batch { id: string; key: string; by: string; sessionId: string | null; ops: Op[]; ids: Set<string>; summary: string[]; at: number; undone: boolean }

type Tier = 'free' | 'confirm';
interface ToolDef { name: string; description: string; inputSchema: any; tier: Tier }

const ids = { type: 'array', items: { type: 'string' } };
const S = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, ...(required.length ? { required } : {}) });

export const CANVAS_TOOLS: ToolDef[] = [
  // ---- free: read
  { tier: 'free', name: 'canvas_snapshot', description: 'What the canvas shows right now: layout mode, every node (id, kind, title, parent, x/y/w/h in canvas units), the user\'s selection and focused node. Call this before arranging anything.', inputSchema: S({ kinds: { ...ids, description: 'only these node kinds (project, branch, session, app, file, note, todos, machine, device, hil, …)' } }) },
  { tier: 'free', name: 'hub_overview', description: 'Hosts, accounts, projects with their checkouts, branches, sessions and HIL plans, with the ids the other hub tools take.', inputSchema: S({}) },
  // ---- free: arrange (live, undoable)
  { tier: 'free', name: 'canvas_move', description: 'Move nodes. Each move gives absolute x/y or a relative dx/dy (canvas units). with_children also moves every descendant by the same offset.', inputSchema: S({ moves: { type: 'array', items: S({ id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' } }, ['id']) }, with_children: { type: 'boolean' } }, ['moves']) },
  { tier: 'free', name: 'canvas_arrange', description: 'Line nodes up as a row, a column or a grid (default: the user\'s current selection), starting at origin or at their current top-left.', inputSchema: S({ ids: { ...ids, description: 'node ids; omit for the current selection' }, pattern: { type: 'string', enum: ['row', 'column', 'grid'] }, gap: { type: 'number' }, columns: { type: 'integer' }, origin: S({ x: { type: 'number' }, y: { type: 'number' } }) }, ['pattern']) },
  { tier: 'free', name: 'canvas_resize', description: 'Resize nodes (canvas units; min 160×56). Sizes are kept per collapsed/expanded state.', inputSchema: S({ sizes: { type: 'array', items: S({ id: { type: 'string' }, w: { type: 'number' }, h: { type: 'number' } }, ['id', 'w', 'h']) } }, ['sizes']) },
  { tier: 'free', name: 'canvas_layout', description: 'Switch the canvas layout: cluster (radial), columns (top-down trees), tree (left → right trees), custom (saved positions).', inputSchema: S({ mode: { type: 'string', enum: ['cluster', 'columns', 'tree', 'custom'] } }, ['mode']) },
  { tier: 'free', name: 'canvas_focus', description: 'Pan the user\'s view to a node.', inputSchema: S({ id: { type: 'string' } }, ['id']) },
  { tier: 'free', name: 'canvas_select', description: 'Set the user\'s selection (empty list clears it).', inputSchema: S({ ids }, ['ids']) },
  // ---- free: add / remove (undoable)
  { tier: 'free', name: 'canvas_add_note', description: 'Add a note node, optionally attached to a node (parent) and/or at x/y.', inputSchema: S({ text: { type: 'string' }, title: { type: 'string' }, parent: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, ['text']) },
  { tier: 'free', name: 'canvas_add_todo', description: 'Add a to-do, optionally scoped to a project id (shown in that project\'s to-do list).', inputSchema: S({ text: { type: 'string' }, project: { type: 'string' } }, ['text']) },
  { tier: 'free', name: 'canvas_open_file', description: 'Place a file from a repo on the canvas as a node pinned to its last commit (markdown, image, code, STL, PDF…). Give a project id with an optional git ref, or a checkout id.', inputSchema: S({ path: { type: 'string' }, project: { type: 'string' }, ref: { type: 'string' }, checkout: { type: 'string' }, parent: { type: 'string' } }, ['path']) },
  { tier: 'free', name: 'canvas_remove', description: 'Remove note, file or to-do-list nodes (undoable from the hub). Sessions, apps, branches and hardware cannot be removed this way.', inputSchema: S({ ids }, ['ids']) },
  // ---- confirm: the user approves in the hub first
  { tier: 'confirm', name: 'hub_spawn_session', description: 'Start an agent session (the user confirms in the hub first). Local: host + account + a checkout_id or branch_id (or cwd). Cloud: where="cloud" with a checkout_id.', inputSchema: S({ vendor: { type: 'string', enum: ['claude', 'codex'] }, prompt: { type: 'string' }, host: { type: 'string' }, account: { type: 'string' }, checkout_id: { type: 'string' }, branch_id: { type: 'string' }, cwd: { type: 'string' }, where: { type: 'string', enum: ['host', 'cloud'] }, environment: { type: 'string' } }, ['vendor', 'prompt']) },
  { tier: 'confirm', name: 'hub_send_message', description: 'Send a message to another agent session (the user confirms first).', inputSchema: S({ session: { type: 'string' }, text: { type: 'string' } }, ['session', 'text']) },
  { tier: 'confirm', name: 'hub_run_hil', description: 'Start a hardware-in-the-loop plan (the user confirms first; the hub takes the plan\'s device locks).', inputSchema: S({ plan: { type: 'string' }, only: ids }, ['plan']) },
  { tier: 'confirm', name: 'hub_create_branch', description: 'Create a branch as a git worktree on a host, optionally pushed to GitHub (the user confirms first).', inputSchema: S({ project: { type: 'string' }, name: { type: 'string' }, base: { type: 'string' }, checkout_id: { type: 'string' }, goal: { type: 'string' }, push: { type: 'boolean' } }, ['project', 'name']) },
  { tier: 'confirm', name: 'hub_open_terminal', description: 'Open a terminal node (a shell over SSH) on a host for the user (the user confirms first).', inputSchema: S({ host: { type: 'string' }, cwd: { type: 'string' } }, ['host']) },
];
const BY_NAME = new Map(CANVAS_TOOLS.map((t) => [t.name, t]));
export const CANVAS_TOOL_NAMES = CANVAS_TOOLS.map((t) => t.name);

type Result = { content: any[]; isError?: boolean; structuredContent?: any };
const text = (t: string) => ({ type: 'text', text: t });
const ok = (t: string, structured?: any): Result => ({ content: [text(t)], ...(structured ? { structuredContent: structured } : {}) });
const fail = (t: string): Result => ({ isError: true, content: [text(t)] });
const REMOVABLE = new Set(['note', 'file', 'todos']);
const MERGE_MS = 8000;
/** below the 180 s tool-call timeouts of hub_channel.py and Codex's tool_timeout_sec, so a late Allow never runs an abandoned call */
export const CONFIRM_MS = 150_000;

export class CanvasService {
  private views = new Map<string, ViewReport>();
  private batches: Batch[] = [];
  private waiters = new Map<string, (ok: boolean) => void>();
  constructor(private c: Ctx) {}

  private audit(tool: string, caller: string, args: any, allowed: boolean, reason: string) {
    const ts = Date.now();
    const tier = BY_NAME.get(tool)?.tier ?? 'canvas';
    this.c.db.run('INSERT INTO audit (ts, app_node_id, tool, tier, caller, args, allowed, reason, result) VALUES (?,?,?,?,?,?,?,?,?)',
      ts, 'canvas', tool, tier, caller, JSON.stringify(args ?? {}).slice(0, 4000), allowed ? 1 : 0, reason, '');
    this.c.bus.publish('audit.append', { ts, app_node_id: 'canvas', tool, tier, caller, args, allowed, reason, result: '' });
  }

  has(tool: string) {
    return BY_NAME.has(tool);
  }
  tools() {
    return CANVAS_TOOLS.map(({ tier, ...t }) => ({ ...t, annotations: { readOnlyHint: t.name === 'canvas_snapshot' || t.name === 'hub_overview' } }));
  }

  // ------------------------------------------------------------ view reports from the PWA
  report(clientId: string, r: Omit<ViewReport, 'at'>) {
    const nodes = (Array.isArray(r.nodes) ? r.nodes : []).slice(0, 2000).map((n) => ({
      id: String(n.id), kind: String(n.kind || ''), title: String(n.title || '').slice(0, 120), parent: n.parent ? String(n.parent) : null,
      x: Math.round(+n.x || 0), y: Math.round(+n.y || 0), w: Math.round(+n.w || 0), h: Math.round(+n.h || 0), ex: !!n.ex,
    }));
    this.views.set(clientId.slice(0, 64), { at: Date.now(), mode: String(r.mode || ''), nodes, selected: (r.selected || []).map(String).slice(0, 500), focusId: r.focusId ? String(r.focusId) : null, visible: r.visible ?? null });
    if (this.views.size > 20) this.views.delete([...this.views.entries()].sort((a, b) => a[1].at - b[1].at)[0][0]);
  }
  /** the most recent report from any client */
  view(): ViewReport | null {
    let best: ViewReport | null = null;
    for (const v of this.views.values()) if (!best || v.at > best.at) best = v;
    return best;
  }
  private box(id: string): { x: number; y: number; w: number; h: number } | null {
    const n = this.view()?.nodes.find((x) => x.id === id);
    if (n) return n;
    const l = this.c.db.get('SELECT * FROM layout WHERE node_id=?', id);
    return l && Number.isFinite(l.x) ? { x: l.x, y: l.y, w: l.w ?? 300, h: l.h ?? 160 } : null;
  }
  private knownIds(): Set<string> {
    const v = this.view();
    const s = new Set<string>(v ? v.nodes.map((n) => n.id) : []);
    for (const r of this.c.db.all('SELECT id FROM cnode')) s.add(r.id);
    for (const x of this.c.store.sessions()) s.add(x.id);
    return s;
  }

  // ------------------------------------------------------------ batches + undo
  private batch(caller: CanvasCaller): Batch {
    const key = `${caller.kind}:${caller.sessionId ?? caller.label}`;
    const last = this.batches[this.batches.length - 1];
    if (last && last.key === key && !last.undone && Date.now() - last.at < MERGE_MS) { last.at = Date.now(); return last; }
    const b: Batch = { id: newId('cb-'), key, by: caller.label, sessionId: caller.sessionId, ops: [], ids: new Set(), summary: [], at: Date.now(), undone: false };
    this.batches.push(b);
    if (this.batches.length > 50) this.batches.shift();
    return b;
  }
  private announce(b: Batch, summary: string, changed: string[], moved = false) {
    changed.forEach((i) => b.ids.add(i));
    b.summary.push(summary);
    this.c.bus.publish('canvas.changed', { batchId: b.id, by: b.by, sessionId: b.sessionId, summary: b.summary.slice(-6), ids: [...b.ids], moved, at: Date.now() });
  }
  batchesList() {
    return this.batches.slice(-20).reverse().map((b) => ({ id: b.id, by: b.by, sessionId: b.sessionId, summary: b.summary, ids: [...b.ids], at: b.at, undone: b.undone }));
  }
  undo(batchId: string) {
    const b = this.batches.find((x) => x.id === batchId);
    if (!b) throw new Error('unknown change batch');
    if (b.undone) throw new Error('already undone');
    for (const op of [...b.ops].reverse()) {
      try {
        if (op.t === 'layout') {
          if (op.prev) this.c.db.upsert('layout', op.prev, 'node_id');
          else this.c.db.run('DELETE FROM layout WHERE node_id=?', op.id);
          const row = this.c.db.get('SELECT * FROM layout WHERE node_id=?', op.id);
          this.c.bus.publish('layout.upsert', row ? { nodeId: op.id, ...layoutEntry(row) } : { nodeId: op.id, removed: true });
        } else if (op.t === 'created') this.c.nodes.remove(op.cnodeId);
        else if (op.t === 'todo') this.c.nodes.removeTodo(op.todoId);
        else if (op.t === 'removed') {
          this.c.db.upsert('cnode', op.row);
          this.c.bus.publish('cnode.upsert', this.c.nodes.get(op.row.id));
        }
      } catch (e: any) {
        L(`undo ${b.id}: ${e.message}`);
      }
    }
    b.undone = true;
    this.c.bus.publish('canvas.undone', { batchId: b.id, ids: [...b.ids] });
    this.audit('undo', 'user:you', { batchId: b.id, by: b.by }, true, '');
    return { ok: true };
  }

  private setLayout(b: Batch, id: string, patch: { x?: number; y?: number; size?: Record<string, [number, number] | null> }) {
    const prev = this.c.db.get('SELECT * FROM layout WHERE node_id=?', id) ?? null;
    if (!b.ops.some((o) => o.t === 'layout' && o.id === id)) b.ops.push({ t: 'layout', id, prev: prev ? { ...prev } : null });
    const cur = this.box(id);
    const row: Record<string, any> = {
      node_id: id, x: Math.round(patch.x ?? prev?.x ?? cur?.x ?? 0), y: Math.round(patch.y ?? prev?.y ?? cur?.y ?? 0),
      w: cur?.w ?? prev?.w ?? null, h: cur?.h ?? prev?.h ?? null, collapsed: prev?.collapsed ?? 1,
    };
    if (patch.size) row.sz = JSON.stringify(mergeSize(prev?.sz ? JSON.parse(prev.sz) : {}, patch.size));
    this.c.db.upsert('layout', row, 'node_id');
    const saved = this.c.db.get('SELECT * FROM layout WHERE node_id=?', id)!;
    this.c.bus.publish('layout.upsert', { nodeId: id, ...layoutEntry(saved) });
  }

  // ------------------------------------------------------------ confirm tier
  /**
   * Ask the user in the hub; resolves true/false. The approval expires (false) after CONFIRM_MS, which stays below
   * the callers' own tool-call timeouts, or as soon as the waiting HTTP request goes away (`signal`), so an Allow can
   * never run an action the agent was already told had failed.
   */
  private confirm(caller: CanvasCaller, title: string, detail: string, tool: string, args: any, signal?: AbortSignal): Promise<boolean> {
    const id = newId('ca-');
    const expiresAt = Date.now() + CONFIRM_MS;
    this.c.store.upsertApproval({ id, session_id: caller.sessionId ?? 'mcp:external', source: 'canvas-action', status: 'pending', title, detail, data: { tool, args, by: caller.label, expiresAt } });
    this.c.push.notify({ title: 'Claude asks', body: title, tag: id, url: caller.sessionId ? `/?focus=${caller.sessionId}` : '/' });
    return new Promise((resolve) => {
      const finish = (v: boolean, expire: boolean) => {
        if (!this.waiters.has(id)) return;
        this.waiters.delete(id);
        clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
        if (expire) this.c.store.upsertApproval({ id, status: 'expired' });
        resolve(v);
      };
      const t = setTimeout(() => finish(false, true), CONFIRM_MS);
      const onAbort = () => {
        L(`${id}: caller went away; approval expired`);
        finish(false, true);
      };
      this.waiters.set(id, (v) => finish(v, false));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  /** a tool call is still waiting on this approval */
  waiting(approvalId: string) {
    return this.waiters.has(approvalId);
  }
  decide(approvalId: string, decision: 'allow' | 'deny') {
    const w = this.waiters.get(approvalId);
    if (!w) throw new Error('no longer waiting');
    this.c.store.upsertApproval({ id: approvalId, status: decision, decided_by: 'hub' });
    w(decision === 'allow');
  }

  // ------------------------------------------------------------ tool calls
  /** `signal` aborts when the HTTP request that waits for the result goes away (confirm-tier approvals then expire). */
  async call(tool: string, args: any, caller: CanvasCaller, signal?: AbortSignal): Promise<Result> {
    const def = BY_NAME.get(tool);
    if (!def) return fail(`unknown canvas tool ${tool}`);
    args = args || {};
    try {
      const r = await this.run(tool, args, caller, signal);
      if (tool !== 'canvas_snapshot' && tool !== 'hub_overview')
        this.audit(tool, `${caller.kind}:${caller.sessionId ?? caller.label}`, args, !r.isError, r.isError ? String(r.content?.[0]?.text || '').slice(0, 300) : '');
      return r;
    } catch (e: any) {
      return fail(String(e.message || e));
    }
  }

  private async run(tool: string, a: any, caller: CanvasCaller, signal?: AbortSignal): Promise<Result> {
    const v = this.view();
    switch (tool) {
      case 'canvas_snapshot': {
        if (!v) return ok(JSON.stringify({ note: 'No browser has reported the canvas yet (open the hub PWA); listing hub entities without positions.', nodes: this.fallbackNodes() }, null, 1));
        const kinds: string[] | null = Array.isArray(a.kinds) && a.kinds.length ? a.kinds : null;
        const nodes = v.nodes.filter((n) => !kinds || kinds.includes(n.kind)).map(({ ex, ...n }) => (ex ? { ...n, expanded: true } : n));
        return ok(JSON.stringify({ layoutMode: v.mode, reportedSecondsAgo: Math.round((Date.now() - v.at) / 1000), selected: v.selected, focus: v.focusId, visible: v.visible, nodes }), { layoutMode: v.mode, selected: v.selected, count: nodes.length });
      }
      case 'hub_overview':
        return ok(JSON.stringify(this.overview()));
      case 'canvas_move': {
        const moves: any[] = Array.isArray(a.moves) ? a.moves.slice(0, 500) : [];
        if (!moves.length) return fail('moves is required');
        const known = this.knownIds();
        const b = this.batch(caller);
        const out: string[] = [];
        const kids = this.childrenMap();
        for (const m of moves) {
          const id = String(m.id);
          if (!known.has(id)) return fail(`unknown node ${id} (call canvas_snapshot for ids)`);
          const cur = this.box(id);
          const x = Number.isFinite(m.x) ? m.x : (cur?.x ?? 0) + (+m.dx || 0);
          const y = Number.isFinite(m.y) ? m.y : (cur?.y ?? 0) + (+m.dy || 0);
          const dx = x - (cur?.x ?? x), dy = y - (cur?.y ?? y);
          this.setLayout(b, id, { x, y });
          out.push(id);
          if (a.with_children) for (const d of this.descendants(id, kids)) {
            const db = this.box(d);
            if (!db) continue;
            this.setLayout(b, d, { x: db.x + dx, y: db.y + dy });
            out.push(d);
          }
        }
        this.announce(b, `moved ${out.length} node${out.length === 1 ? '' : 's'}`, out, true);
        return ok(`moved ${out.length} node(s); the user sees the change highlighted and can undo it (batch ${b.id})`, { batchId: b.id, moved: out });
      }
      case 'canvas_arrange': {
        const list: string[] = (Array.isArray(a.ids) && a.ids.length ? a.ids : v?.selected || []).map(String);
        if (list.length < 1) return fail('nothing to arrange: pass ids, or ask the user to select nodes');
        const boxes = list.map((id) => ({ id, b: this.box(id) })).filter((x) => x.b) as { id: string; b: { x: number; y: number; w: number; h: number } }[];
        if (!boxes.length) return fail('no positions known for those nodes (is the hub open in a browser?)');
        const gap = Number.isFinite(a.gap) ? Math.max(0, a.gap) : 40;
        const ox = Number.isFinite(a.origin?.x) ? a.origin.x : Math.min(...boxes.map((x) => x.b.x));
        const oy = Number.isFinite(a.origin?.y) ? a.origin.y : Math.min(...boxes.map((x) => x.b.y));
        const pattern = a.pattern === 'column' ? 'column' : a.pattern === 'grid' ? 'grid' : 'row';
        const cols = pattern === 'row' ? boxes.length : pattern === 'column' ? 1 : Math.max(1, Math.min(boxes.length, a.columns || Math.ceil(Math.sqrt(boxes.length))));
        const colW: number[] = [], rowH: number[] = [];
        boxes.forEach((x, i) => { const c = i % cols, r = Math.floor(i / cols); colW[c] = Math.max(colW[c] || 0, x.b.w); rowH[r] = Math.max(rowH[r] || 0, x.b.h); });
        const b = this.batch(caller);
        boxes.forEach((x, i) => {
          const c = i % cols, r = Math.floor(i / cols);
          const px = ox + colW.slice(0, c).reduce((s, w) => s + w + gap, 0);
          const py = oy + rowH.slice(0, r).reduce((s, h) => s + h + gap, 0);
          this.setLayout(b, x.id, { x: px, y: py });
        });
        this.announce(b, `arranged ${boxes.length} nodes in a ${pattern}`, boxes.map((x) => x.id), true);
        return ok(`arranged ${boxes.length} node(s) in a ${pattern} (batch ${b.id})`, { batchId: b.id, ids: boxes.map((x) => x.id) });
      }
      case 'canvas_resize': {
        const sizes: any[] = Array.isArray(a.sizes) ? a.sizes.slice(0, 200) : [];
        const known = this.knownIds();
        const b = this.batch(caller);
        const done: string[] = [];
        for (const s of sizes) {
          const id = String(s.id);
          if (!known.has(id)) return fail(`unknown node ${id}`);
          const w = Math.max(160, Math.round(+s.w || 0)), h = Math.max(56, Math.round(+s.h || 0));
          const ex = !!v?.nodes.find((n) => n.id === id)?.ex;
          this.setLayout(b, id, { size: { [ex ? 'x' : 'c']: [w, h] } });
          done.push(id);
        }
        this.announce(b, `resized ${done.length} node${done.length === 1 ? '' : 's'}`, done);
        return ok(`resized ${done.length} node(s) (batch ${b.id})`, { batchId: b.id });
      }
      case 'canvas_layout': {
        const mode = String(a.mode);
        if (!['cluster', 'columns', 'tree', 'custom'].includes(mode)) return fail('mode must be cluster|columns|tree|custom');
        this.c.bus.publish('canvas.ui', { layoutMode: mode, by: caller.label });
        return ok(`layout switched to ${mode}`);
      }
      case 'canvas_focus':
        this.c.bus.publish('canvas.ui', { focus: String(a.id), by: caller.label });
        return ok(`focused ${a.id}`);
      case 'canvas_select': {
        const list = (Array.isArray(a.ids) ? a.ids : []).map(String).slice(0, 500);
        this.c.bus.publish('canvas.ui', { select: list, by: caller.label });
        return ok(list.length ? `selected ${list.length} node(s)` : 'selection cleared');
      }
      case 'canvas_add_note': {
        const parent = a.parent && this.knownIds().has(String(a.parent)) ? String(a.parent) : null;
        const n = await this.c.nodes.create('note', parent, { title: a.title || 'Note', text: String(a.text || '') }, caller.sessionId ?? 'claude');
        const b = this.batch(caller);
        b.ops.push({ t: 'created', cnodeId: n.id });
        if (Number.isFinite(a.x) && Number.isFinite(a.y)) this.setLayout(b, n.id, { x: a.x, y: a.y });
        this.announce(b, 'added a note', [n.id], Number.isFinite(a.x));
        return ok(`note ${n.id} added (batch ${b.id})`, { nodeId: n.id, batchId: b.id });
      }
      case 'canvas_add_todo': {
        const project = a.project && this.c.projects.project(String(a.project)) ? String(a.project) : null;
        const t = this.c.nodes.addTodo(String(a.text || ''), project, caller.sessionId ?? 'claude');
        const b = this.batch(caller);
        b.ops.push({ t: 'todo', todoId: t.id });
        this.announce(b, 'added a to-do', []);
        return ok(`to-do ${t.id} added${project ? ` to ${project}` : ''} (batch ${b.id})`, { todoId: t.id, batchId: b.id });
      }
      case 'canvas_open_file': {
        let source: any;
        if (a.checkout) {
          if (!this.c.repos.checkout(String(a.checkout))) return fail(`unknown checkout ${a.checkout}`);
          source = { kind: 'checkout', checkoutId: String(a.checkout) };
        } else {
          const p = this.c.projects.project(String(a.project || ''));
          if (!p) return fail('give project (a project id from hub_overview) or checkout');
          source = { kind: 'github', projectId: p.id, ref: String(a.ref || p.defaultBranch || 'main') };
        }
        const parent = a.parent && this.knownIds().has(String(a.parent)) ? String(a.parent) : null;
        const n = await this.c.nodes.create('file', parent, { source, path: String(a.path) }, caller.sessionId ?? 'claude');
        const b = this.batch(caller);
        b.ops.push({ t: 'created', cnodeId: n.id });
        this.announce(b, `opened ${String(a.path).split('/').pop()}`, [n.id]);
        return ok(`file node ${n.id} (${n.data.kind}) pinned at ${String(n.data.sha).slice(0, 8)} (batch ${b.id})`, { nodeId: n.id, batchId: b.id });
      }
      case 'canvas_remove': {
        const list = (Array.isArray(a.ids) ? a.ids : []).map(String);
        const b = this.batch(caller);
        const done: string[] = [];
        const refused: string[] = [];
        for (const id of list) {
          const row = this.c.db.get('SELECT * FROM cnode WHERE id=?', id);
          if (!row || !REMOVABLE.has(row.type)) { refused.push(id); continue; }
          b.ops.push({ t: 'removed', row: { ...row } });
          this.c.nodes.remove(id);
          done.push(id);
        }
        if (done.length) this.announce(b, `removed ${done.length} node${done.length === 1 ? '' : 's'}`, done);
        return ok(`removed ${done.length}${refused.length ? `; not removable: ${refused.join(', ')}` : ''}`, { removed: done, refused });
      }

      // ---- confirm tier
      case 'hub_spawn_session': {
        const vendor = String(a.vendor || '');
        const host = a.where === 'cloud' ? 'cloud' : String(a.host || '');
        const account = String(a.account || this.c.cfg.accounts[0]?.id || '');
        const okd = await this.confirm(caller, `Start a ${vendor} session ${a.where === 'cloud' ? 'in the cloud' : `on ${host}`}`, String(a.prompt || ''), tool, a, signal);
        if (!okd) return fail('the user declined (or did not answer) starting this session');
        const s = await spawnSession(this.c, { vendor, accountId: account, where: a.where === 'cloud' ? 'cloud' : host, hostId: host, checkoutId: a.checkout_id, branchId: a.branch_id, cwd: a.cwd, prompt: a.prompt, environment: a.environment });
        return ok(`started ${s.vendor} session ${s.id} (${s.title})`, { sessionId: s.id });
      }
      case 'hub_send_message': {
        const s = this.c.store.session(String(a.session || ''));
        if (!s) return fail(`unknown session ${a.session}`);
        if (s.id === caller.sessionId) return fail('that is your own session');
        if (!(await this.confirm(caller, `Message ${s.title}`, String(a.text || ''), tool, a, signal))) return fail('the user declined sending this message');
        await sendToSession(this.c, s, String(a.text));
        return ok(`sent to ${s.id}`);
      }
      case 'hub_run_hil': {
        const plan = this.c.hil.plans().find((p) => p.id === a.plan || p.id.endsWith(`:${a.plan}`));
        if (!plan) return fail(`unknown HIL plan ${a.plan}; plans: ${this.c.hil.plans().map((p) => p.id).join(', ') || 'none'}`);
        const only = Array.isArray(a.only) && a.only.length ? a.only.map(String) : null;
        if (!(await this.confirm(caller, `Run HIL plan ${plan.title}${only ? ` (${only.join(', ')})` : ''}`, `${plan.hostId} · takes the plan's device locks`, tool, a, signal))) return fail('the user declined the HIL run');
        const run = await this.c.hil.start(plan.id, caller.sessionId ?? 'you', only);
        return ok(`HIL run ${run.id} started on ${plan.hostId}${caller.sessionId ? '; results will arrive as a message in this session' : ''}`, { runId: run.id });
      }
      case 'hub_create_branch': {
        const p = this.c.projects.project(String(a.project || ''));
        if (!p) return fail(`unknown project ${a.project}`);
        const checkoutId = String(a.checkout_id || p.checkouts?.[0] || '');
        if (!checkoutId) return fail('this project has no checkout on any host');
        const base = String(a.base || p.defaultBranch || 'main');
        if (!validRef(String(a.name ?? '')) || !validRef(base)) return fail('invalid branch or base name (letters, digits, . _ - / only)');
        if (!(await this.confirm(caller, `Create branch ${a.name} from ${base}`, `${p.name} · ${a.push ? 'pushed to GitHub' : 'local worktree'}${a.goal ? ` · ${a.goal}` : ''}`, tool, a, signal))) return fail('the user declined creating the branch');
        const br = await this.c.projects.createBranch({ projectId: p.id, checkoutId, base, name: String(a.name), goal: a.goal, push: !!a.push, createdBy: 'agent' });
        return ok(`branch ${br.name} created`, { branchId: br.id });
      }
      case 'hub_open_terminal': {
        const host = String(a.host || '');
        if (!this.c.cfg.hosts.some((h) => h.id === host)) return fail(`unknown host ${host}`);
        if (!(await this.confirm(caller, `Open a terminal on ${host}`, a.cwd ? `in ${a.cwd}` : 'home directory', tool, a, signal))) return fail('the user declined opening a terminal');
        const n = await this.c.nodes.create('terminal', host, { hostId: host, cwd: a.cwd });
        return ok(`terminal node ${n.id} opened on ${host}`, { nodeId: n.id });
      }
    }
    return fail(`unknown canvas tool ${tool}`);
  }

  private childrenMap() {
    const m: Record<string, string[]> = {};
    for (const n of this.view()?.nodes || []) if (n.parent) (m[n.parent] ||= []).push(n.id);
    return m;
  }
  private descendants(id: string, kids: Record<string, string[]>) {
    const out: string[] = [];
    const seen = new Set([id]);
    const walk = (x: string) => (kids[x] || []).forEach((k) => { if (!seen.has(k)) { seen.add(k); out.push(k); walk(k); } });
    walk(id);
    return out;
  }

  private fallbackNodes() {
    return [
      ...this.c.projects.projects().map((p: any) => ({ id: p.id, kind: 'project', title: p.name })),
      ...this.c.projects.branches().map((b: any) => ({ id: b.id, kind: 'branch', title: b.name, parent: b.projectId })),
      ...this.c.store.sessions().filter((s) => s.status !== 'ended').map((s) => ({ id: s.id, kind: 'session', title: s.title })),
      ...this.c.nodes.all().map((n: any) => ({ id: n.id, kind: n.type, title: n.data?.title || n.data?.path || n.type, parent: n.parentId })),
    ];
  }

  overview() {
    const sessions = this.c.store.sessions().filter((s: Session) => s.status !== 'ended');
    return {
      hosts: this.c.cfg.hosts.map((h) => ({ id: h.id, label: h.label || h.id, status: (this.c.hosts.row(h.id) as any)?.status })),
      accounts: this.c.cfg.accounts.map((x) => ({ id: x.id, label: x.label || x.id })),
      projects: this.c.projects.projects().map((p: any) => ({
        id: p.id, name: p.name, defaultBranch: p.defaultBranch,
        checkouts: (p.checkouts || []).map((cid: string) => { const co = this.c.repos.checkout(cid); return co ? { id: cid, host: co.host_id, path: co.path, branch: co.branch } : { id: cid }; }),
      })),
      branches: this.c.projects.branches().map((b: any) => ({ id: b.id, project: b.projectId, name: b.name, base: b.base, pr: b.pr?.number ?? null, ci: b.ci?.state ?? null })),
      sessions: sessions.map((s) => ({ id: s.id, vendor: s.vendor, kind: s.kind, host: s.host_id, title: s.title, status: s.status, role: s.meta?.role || undefined })),
      hilPlans: this.c.hil.plans().map((p) => ({ id: p.id, title: p.title, host: p.hostId })),
    };
  }
}

// ------------------------------------------------------------ layout rows (shared with api.ts)
type Size = [number, number];
export function mergeSize(prev: Record<string, Size>, patch: any): Record<string, Size> {
  const out: Record<string, Size> = { ...prev };
  if (!patch || typeof patch !== 'object') return out;
  for (const k of ['c', 'x']) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === null) delete out[k];
    else if (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n) && n > 0 && n < 20000)) out[k] = [Math.round(v[0]), Math.round(v[1])];
  }
  return out;
}

export function layoutEntry(l: Record<string, any>) {
  const size = l.sz ? JSON.parse(l.sz) : undefined;
  return { x: l.x, y: l.y, w: l.w, h: l.h, collapsed: !!l.collapsed, ...(size && Object.keys(size).length ? { size } : {}) };
}
