// Mock canvas assistant for the demo build: answers in the Ask Claude panel and drives the same
// canvas operations the hub's canvas tools do (arrange, layout, focus, notes, to-dos, undo), and
// asks before starting a session — the confirm tier — through an approval card.
import type { Approval, Session } from './types';

type Resp = { ok: boolean; status: number; data: any };
export interface AsstCtx {
  state: any;
  emit: (type: string, data: unknown) => void;
  addMsg: (sid: string, role: 'user' | 'assistant' | 'tool' | 'system', kind: 'text' | 'tool' | 'command' | 'reasoning' | 'status', text: string, data?: unknown) => void;
  streamReply: (sid: string, text: string) => Promise<void>;
  updSession: (id: string, patch: Partial<Session>) => void;
  createSession: (body: any) => Session;
  v2: (method: string, path: string, body: any) => Resp | null;
}
interface VNode { id: string; kind: string; title: string; parent: string | null; x: number; y: number; w: number; h: number }
interface Batch { id: string; ops: { id: string; prev: any }[]; created: string[]; todos: string[]; removed: any[]; hidden: { id: string; prev: boolean }[]; ids: string[]; summary: string[]; undone: boolean }

let view: { mode: string; nodes: VNode[]; selected: string[]; focusId: string | null } | null = null;
const batches = new Map<string, Batch>();
const waiters = new Map<string, (ok: boolean) => void>();
let n = 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

export function reportView(b: any) { view = b; }

export function assistantStart(ctx: AsstCtx, body: { hostId: string; accountId: string; prompt?: string }): Session {
  const id = `s_ask_${++n}`;
  const now = new Date().toISOString();
  const s: Session = {
    id, vendor: 'claude', kind: 'local', host_id: body.hostId, account_id: body.accountId, checkout_id: null, cwd: '~', branch: '',
    native_id: null, native_url: null, title: 'Canvas assistant', status: 'starting', last_event: null, model: 'opus', effort: 'high',
    created_at: now, updated_at: now, meta: { role: 'assistant', channel: 'connected' },
  };
  ctx.state.sessions.push(s);
  ctx.emit('session.upsert', clone(s));
  if (body.prompt) ctx.addMsg(id, 'user', 'text', body.prompt);
  setTimeout(() => {
    ctx.updSession(id, { status: 'idle' });
    if (body.prompt) void assistantTurn(ctx, id, body.prompt);
  }, 900);
  return clone(s);
}

const nodes = () => view?.nodes || [];
const box = (id: string) => nodes().find((x) => x.id === id);

function newBatch(): Batch {
  const b: Batch = { id: `cb_${Date.now().toString(36)}${++n}`, ops: [], created: [], todos: [], removed: [], hidden: [], ids: [], summary: [], undone: false };
  batches.set(b.id, b);
  return b;
}
function announce(ctx: AsstCtx, sid: string, b: Batch, summary: string, ids: string[], moved = false) {
  b.summary.push(summary);
  b.ids.push(...ids);
  ctx.emit('canvas.changed', { batchId: b.id, by: 'Claude', sessionId: sid, summary: b.summary, ids: b.ids, moved, at: Date.now() });
}
function setPos(ctx: AsstCtx, b: Batch, id: string, x: number, y: number) {
  const L = ctx.state.layout;
  if (!b.ops.some((o) => o.id === id)) b.ops.push({ id, prev: L[id] ? clone(L[id]) : null });
  const cur = box(id);
  L[id] = { ...(L[id] || {}), x: Math.round(x), y: Math.round(y), w: cur?.w, h: cur?.h };
  ctx.emit('layout.upsert', { nodeId: id, ...L[id] });
}
const tool = (ctx: AsstCtx, sid: string, name: string, input: unknown) => ctx.addMsg(sid, 'assistant', 'tool', JSON.stringify(input).slice(0, 90), { name, input });

export function canvasUndo(ctx: AsstCtx, batchId: string): Resp {
  const b = batches.get(batchId);
  if (!b) return { ok: false, status: 404, data: { error: 'unknown change batch' } };
  if (b.undone) return { ok: false, status: 409, data: { error: 'already undone' } };
  const entries: any[] = [];
  for (const o of [...b.ops].reverse()) {
    if (o.prev) { ctx.state.layout[o.id] = o.prev; entries.push({ nodeId: o.id, ...o.prev }); }
    else { delete ctx.state.layout[o.id]; entries.push({ nodeId: o.id, removed: true }); }
  }
  if (entries.length) ctx.emit('layout.bulk', { entries });
  b.removed.forEach((c) => { ctx.state.cnodes.push(c); ctx.emit('cnode.upsert', clone(c)); });
  b.hidden.forEach(({ id, prev }) => { const s = ctx.state.sessions.find((x: Session) => x.id === id); if (s) ctx.updSession(id, { meta: { ...s.meta, hidden: prev } }); });
  b.created.forEach((id) => ctx.v2('DELETE', `/api/cnodes/${id}`, {}));
  b.todos.forEach((id) => ctx.v2('DELETE', `/api/todos/${id}`, {}));
  b.undone = true;
  ctx.emit('canvas.undone', { batchId: b.id, ids: b.ids });
  return { ok: true, status: 200, data: { ok: true } };
}

/** approvals with source canvas-action land here (Allow / Deny in the panel) */
export function decideAction(ctx: AsstCtx, ap: Approval, allow: boolean) {
  const w = waiters.get(ap.id);
  waiters.delete(ap.id);
  w?.(allow);
}
function confirm(ctx: AsstCtx, sid: string, title: string, detail: string): Promise<boolean> {
  const a: Approval = { id: `ca_${Date.now().toString(36)}${++n}`, session_id: sid, source: 'canvas-action', status: 'pending', title, detail, data: null, created_at: new Date().toISOString() } as Approval;
  ctx.state.approvals.push(a);
  ctx.emit('approval.upsert', clone(a));
  ctx.updSession(sid, { status: 'waiting' });
  return new Promise((r) => waiters.set(a.id, (v) => { ctx.updSession(sid, { status: 'running' }); r(v); }));
}

export async function assistantTurn(ctx: AsstCtx, sid: string, raw: string) {
  ctx.updSession(sid, { status: 'running' });
  const selLine = raw.match(/\(Selected on the canvas: ([^)]*)\)/);
  const text = raw.replace(/\n*\(Selected on the canvas: [^)]*\)\s*$/, '').trim();
  const low = text.toLowerCase();
  const selected = selLine ? selLine[1].split(',').map((x) => x.trim()).filter((x) => x && x !== '…') : view?.selected || [];
  await wait(500);
  const say = (t: string) => ctx.streamReply(sid, t);
  try {
    if (/\b(arrange|tidy|line up|lay out|row|column|grid)\b/.test(low) && !/\blayout\b/.test(low)) {
      tool(ctx, sid, 'canvas_snapshot', {});
      await wait(300);
      let ids = selected.filter((id) => box(id));
      if (!ids.length && /session/.test(low)) ids = nodes().filter((x) => x.kind === 'session').map((x) => x.id);
      if (!ids.length) return await say('Select the nodes you want arranged (left-drag a box around them), then ask again — or say "arrange the sessions".');
      const pattern = /column/.test(low) ? 'column' : /grid/.test(low) ? 'grid' : 'row';
      tool(ctx, sid, 'canvas_arrange', { ids, pattern, gap: 48 });
      const bs = ids.map((id) => box(id)!);
      const ox = Math.min(...bs.map((b) => b.x)), oy = Math.min(...bs.map((b) => b.y));
      const cols = pattern === 'row' ? bs.length : pattern === 'column' ? 1 : Math.ceil(Math.sqrt(bs.length));
      const colW: number[] = [], rowH: number[] = [];
      bs.forEach((b, i) => { const c = i % cols, r = Math.floor(i / cols); colW[c] = Math.max(colW[c] || 0, b.w); rowH[r] = Math.max(rowH[r] || 0, b.h); });
      const b = newBatch();
      ids.forEach((id, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        setPos(ctx, b, id, ox + colW.slice(0, c).reduce((s, w) => s + w + 48, 0), oy + rowH.slice(0, r).reduce((s, h) => s + h + 48, 0));
      });
      announce(ctx, sid, b, `arranged ${ids.length} nodes in a ${pattern}`, ids, true);
      if (/\bnote\b/.test(low)) await addNote(ctx, sid, b, `Lined up ${ids.length} nodes in a ${pattern}.`, ox, oy - 200);
      return await say(`Arranged ${ids.length} nodes in a ${pattern}${/\bnote\b/.test(low) ? ' and added a note above them' : ''}. Undo is on the pill at the top if you want them back.`);
    }
    const lm = low.match(/\b(cluster|columns|tree|custom)\b/);
    if (lm && /\blayout|view|switch\b/.test(low)) {
      tool(ctx, sid, 'canvas_layout', { mode: lm[1] });
      ctx.emit('canvas.ui', { layoutMode: lm[1], by: 'Claude' });
      return await say(`Switched the canvas to the ${lm[1]} layout.`);
    }
    const sm = low.match(/\b(?:start|spawn|launch)\b.*?\b(codex|claude)\b/);
    if (sm) {
      const vendor = sm[1];
      const host = (low.match(/\bon (mini-\d)\b/) || [])[1] || 'mini-2';
      const prompt = (text.match(/\bto (.+)$/i) || [])[1] || 'Look around the repository and summarise open work.';
      const co = ctx.state.checkouts.find((c: any) => c.host_id === host);
      tool(ctx, sid, 'hub_overview', {});
      await say(`I'll need your OK to start a ${vendor} session on ${host}.`);
      tool(ctx, sid, 'hub_spawn_session', { vendor, host, checkout_id: co?.id, prompt });
      const yes = await confirm(ctx, sid, `Start a ${vendor} session on ${host}`, prompt);
      if (!yes) return await say('Okay — not started.');
      const s = ctx.createSession({ vendor, hostId: host, accountId: co?.account_id || 'personal', checkoutId: co?.id, prompt });
      ctx.emit('canvas.ui', { focus: s.id, by: 'Claude' });
      return await say(`Started ${vendor} session “${s.title}” on ${host}; it's on the canvas now.`);
    }
    if (/\b(summar|what.*doing|status)\b/.test(low)) {
      tool(ctx, sid, 'canvas_snapshot', { kinds: ['session'] });
      const ss = ctx.state.sessions.filter((s: Session) => s.meta?.role !== 'assistant' && !['ended', 'error'].includes(s.status));
      const body = ss.map((s: Session) => `• ${s.title} — ${s.vendor} ${s.kind === 'cloud' ? 'cloud' : `on ${s.host_id}`}, ${s.status}`).join('\n');
      const b = newBatch();
      const near = ss.map((s: Session) => box(s.id)).filter(Boolean) as VNode[];
      await addNote(ctx, sid, b, body, near.length ? Math.min(...near.map((x) => x.x)) : undefined, near.length ? Math.min(...near.map((x) => x.y)) - 260 : undefined, 'What each session is doing');
      return await say(`Added a note with what the ${ss.length} active sessions are doing.`);
    }
    const fm = low.match(/\b(?:focus|show me|zoom to|go to|find)\b\s+(?:the\s+)?(.+)$/);
    if (fm) {
      const q = fm[1].replace(/[.?!]$/, '');
      const hit = nodes().find((x) => x.title.toLowerCase().includes(q));
      tool(ctx, sid, 'canvas_focus', { id: hit?.id || q });
      if (!hit) return await say(`I couldn't find a node matching “${q}”.`);
      ctx.emit('canvas.ui', { focus: hit.id, select: [hit.id], by: 'Claude' });
      return await say(`There it is: ${hit.title.slice(0, 60)}.`);
    }
    if (/\bto-?do\b/.test(low)) {
      const t = text.replace(/^.*?\bto-?do\b[:\s-]*/i, '').trim() || text;
      tool(ctx, sid, 'canvas_add_todo', { text: t });
      const r = ctx.v2('POST', '/api/todos', { text: t, scope: null });
      const b = newBatch();
      if (r?.data?.id) b.todos.push(r.data.id);
      announce(ctx, sid, b, 'added a to-do', []);
      return await say(`Added the to-do “${t}”.`);
    }
    if (/\bnote\b/.test(low)) {
      const t = text.replace(/^.*?\bnote\b[:\s-]*(?:saying|that)?\s*/i, '').trim() || text;
      const b = newBatch();
      const sel = selected.map((id) => box(id)).filter(Boolean) as VNode[];
      await addNote(ctx, sid, b, t, sel[0] ? sel[0].x : undefined, sel[0] ? sel[0].y - 200 : undefined);
      return await say('Added the note.');
    }
    return await say('In this demo I can arrange selected nodes (row, column or grid), switch layouts, focus a node, summarise sessions in a note, add notes and to-dos, and — with your OK — start a session. Try “arrange these in a grid” after selecting a few nodes.');
  } finally {
    const cur = ctx.state.sessions.find((x: Session) => x.id === sid);
    if (cur && cur.status !== 'ended') ctx.updSession(sid, { status: 'idle' });
  }
}

async function addNote(ctx: AsstCtx, sid: string, b: Batch, text: string, x?: number, y?: number, title = 'Note from Claude') {
  tool(ctx, sid, 'canvas_add_note', { title, text, ...(x != null ? { x, y } : {}) });
  const r = ctx.v2('POST', '/api/cnodes', { type: 'note', parentId: null, data: { title, text } });
  const id = r?.data?.id;
  if (!id) return;
  b.created.push(id);
  if (x != null && y != null) setPos(ctx, b, id, x, y);
  announce(ctx, sid, b, 'added a note', [id], x != null);
}

// ---- your own edits (same semantics as the hub's /api/canvas/remove and /api/layout/bulk)
const USER_REMOVABLE = new Set(['note', 'file', 'todos', 'suggest', 'htodo']);
export function userRemove(ctx: AsstCtx, ids: string[], stop: boolean): Resp {
  const b = newBatch();
  const out = { removed: [] as string[], hidden: [] as string[], stopped: [] as string[], closed: [] as string[], refused: [] as string[] };
  for (const id of ids) {
    const c = ctx.state.cnodes.find((x: any) => x.id === id);
    if (c && (USER_REMOVABLE.has(c.type) || c.type === 'terminal')) {
      if (c.type !== 'terminal') b.removed.push(clone(c));
      ctx.v2('DELETE', `/api/cnodes/${id}`, {});
      (c.type === 'terminal' ? out.closed : out.removed).push(id);
      continue;
    }
    const s = ctx.state.sessions.find((x: Session) => x.id === id);
    if (s) {
      if (stop && !['ended', 'error', 'applied'].includes(s.status)) { ctx.updSession(id, { status: 'ended' }); out.stopped.push(id); }
      b.hidden.push({ id, prev: !!s.meta?.hidden });
      const cur = ctx.state.sessions.find((x: Session) => x.id === id)!;
      ctx.updSession(id, { meta: { ...cur.meta, hidden: true } });
      out.hidden.push(id);
      continue;
    }
    out.refused.push(id);
  }
  const parts = [out.removed.length ? `removed ${out.removed.length} node${out.removed.length === 1 ? '' : 's'}` : '', out.hidden.length ? `hid ${out.hidden.length} session${out.hidden.length === 1 ? '' : 's'}` : '',
    out.stopped.length ? `stopped ${out.stopped.length}` : '', out.closed.length ? `closed ${out.closed.length} terminal${out.closed.length === 1 ? '' : 's'}` : ''].filter(Boolean);
  if (parts.length) { b.summary.push(parts.join(' · ')); ctx.emit('canvas.changed', { batchId: b.id, by: 'You', sessionId: null, summary: b.summary, ids: [], moved: false, at: Date.now() }); }
  return { ok: true, status: 200, data: { batchId: parts.length ? b.id : null, ...out } };
}

export function bulkLayout(ctx: AsstCtx, entries: { nodeId: string; x: number; y: number; w?: number; h?: number }[], opts: { undoable?: boolean; label?: string }): Resp {
  const b = opts.undoable ? newBatch() : null;
  const L = ctx.state.layout;
  const out = entries.map((e) => {
    if (b) b.ops.push({ id: e.nodeId, prev: L[e.nodeId] ? clone(L[e.nodeId]) : null });
    L[e.nodeId] = { ...(L[e.nodeId] || {}), x: Math.round(e.x), y: Math.round(e.y), w: e.w, h: e.h };
    return { nodeId: e.nodeId, ...L[e.nodeId] };
  });
  ctx.emit('layout.bulk', { entries: out });
  if (b) { b.summary.push(opts.label || `moved ${out.length} nodes`); ctx.emit('canvas.changed', { batchId: b.id, by: 'You', sessionId: null, summary: b.summary, ids: [], moved: false, at: Date.now() }); }
  return { ok: true, status: 200, data: { saved: out.length, batchId: b?.id ?? null } };
}
