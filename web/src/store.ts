// Hub data store (snapshot + event stream) and small UI store.
import { useSyncExternalStore } from 'react';
import { api } from './api';
import type {
  Account, AppNode, Approval, Audit, Branch, CNode, Checkout, Device, FileSource, Grant, HilPlan, HilRun, Host, HubEvent,
  LayoutEntry, Machine, Message, Project, Session, StateSnapshot, Todo, Usage,
  CanvasChange,
} from './types';

// ---------- tiny store helper ----------
export interface Store<T> {
  get: () => T;
  set: (patch: Partial<T> | ((s: T) => Partial<T>)) => void;
  subscribe: (fn: () => void) => () => void;
}
export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (patch) => {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      subs.forEach((f) => f());
    },
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}
export function useStore<T extends object, R>(store: Store<T>, sel: (s: T) => R): R {
  return useSyncExternalStore(store.subscribe, () => sel(store.get()), () => sel(store.get()));
}

// ---------- hub data ----------
export interface HubData {
  ready: boolean;
  /** subscription usage, keyed `${vendor}:${accountId}` */
  usage: Record<string, Usage>;
  authRequired: boolean;
  error: string | null;
  connected: boolean;
  seq: number;
  hosts: Record<string, Host>;
  accounts: Record<string, Account>;
  checkouts: Record<string, Checkout>;
  sessions: Record<string, Session>;
  approvals: Record<string, Approval>;
  nodes: Record<string, AppNode>;
  layout: Record<string, LayoutEntry>;
  config: StateSnapshot['config'];
  messages: Record<string, Message[]>;
  audit: Audit[];
  // v2
  projects: Record<string, Project>;
  branches: Record<string, Branch>;
  machines: Record<string, Machine>;
  devices: Record<string, Device>;
  cnodes: Record<string, CNode>;
  todos: Record<string, Todo>;
  grants: Record<string, Grant>;
  hilPlans: Record<string, HilPlan>;
  hilRuns: Record<string, HilRun>;
}

const byId = <T extends { id: string }>(arr: T[] | undefined, norm?: (x: T) => T) => {
  const o: Record<string, T> = {};
  (arr || []).forEach((x) => { if (x && x.id) o[x.id] = norm ? norm(x) : x; });
  return o;
};

// Defensive defaults for v2 objects (the UI indexes into these lists freely).
const arr = <T,>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);
export const norm = {
  project: (p: Project): Project => ({ ...p, folders: arr(p.folders), checkouts: arr(p.checkouts), readme: p.readme || '', defaultBranch: p.defaultBranch || 'main',
    stats: { files: 0, commits: 0, sizeMB: 0, branches: 0, sessions: 0, ...((p.stats || {}) as Partial<Project['stats']>) }, gh: p.gh || null }),
  branch: (b: Branch): Branch => ({ ...b, checkouts: arr(b.checkouts), commits: arr(b.commits), apps: arr(b.apps), aheadBase: b.aheadBase || 0, behindBase: b.behindBase || 0,
    aheadRemote: b.aheadRemote || 0, behindRemote: b.behindRemote || 0, pr: b.pr ? { ...b.pr, reviews: { approved: 0, changesRequested: 0, commented: 0, ...((b.pr.reviews || {}) as Partial<NonNullable<Branch['pr']>['reviews']>) } } : null }),
  machine: (m: Machine): Machine => ({ ...m, gpu: arr(m.gpu), color: m.color || '#8A8F98', label: m.label || m.id }),
  device: (d: Device): Device => ({ ...d, parentId: d.parentId || null, title: d.title || d.id, icon: d.icon || 'USB', lock: d.lock || null }),
  plan: (p: HilPlan): HilPlan => ({ ...p, devices: arr(p.devices), setup: arr(p.setup), title: p.title || p.id }),
  run: (r: HilRun): HilRun => ({ ...r, rows: arr(r.rows), log: arr(r.log), pass: r.pass || 0, fail: r.fail || 0, left: r.left || 0 }),
  cnode: (c: CNode): CNode => {
    const data = { ...(c.data || {}) };
    if (c.type === 'review') { data.checklist = arr(data.checklist); data.comments = arr(data.comments); data.status ||= 'pending'; }
    if (c.type === 'file') { data.kind ||= 'text'; data.newer ||= null; }
    if (c.type === 'terminal') { data.status ||= 'open'; }
    return { ...c, parentId: c.parentId ?? null, data };
  },
};

export const hub = createStore<HubData>({
  usage: {},
  ready: false, authRequired: false, error: null, connected: false, seq: 0,
  hosts: {}, accounts: {}, checkouts: {}, sessions: {}, approvals: {}, nodes: {}, layout: {}, config: {},
  messages: {}, audit: [],
  projects: {}, branches: {}, machines: {}, devices: {}, cnodes: {}, todos: {}, grants: {}, hilPlans: {}, hilRuns: {},
});
export const useHub = <R,>(sel: (s: HubData) => R) => useStore(hub, sel);

export function applySnapshot(s: StateSnapshot) {
  hub.set({
    ready: true, authRequired: false, error: null, seq: s.seq || 0,
    hosts: byId(s.hosts), accounts: byId(s.accounts), checkouts: byId(s.checkouts), sessions: byId(s.sessions),
    approvals: byId(s.approvals), nodes: byId(s.nodes), layout: { ...(s.layout || {}) }, config: s.config || {},
    projects: byId(s.projects, norm.project), branches: byId(s.branches, norm.branch), machines: byId(s.machines, norm.machine), devices: byId(s.devices, norm.device),
    cnodes: byId(s.cnodes, norm.cnode), todos: byId(s.todos), grants: byId(s.grants),
    hilPlans: byId(s.hil?.plans, norm.plan), hilRuns: byId(s.hil?.runs, norm.run),
    usage: Object.fromEntries((s.usage || []).map((u) => [`${u.vendor}:${u.accountId}`, u])),
  });
}

function without<T>(rec: Record<string, T>, id: string): Record<string, T> {
  if (!(id in rec)) return rec;
  const o = { ...rec };
  delete o[id];
  return o;
}

/** Optimistically merge an object returned by a command (the event stream confirms it). */
export function mergeLocal(kind: 'cnodes' | 'todos' | 'branches' | 'sessions' | 'grants' | 'devices' | 'hilRuns', obj: ({ id: string } & Record<string, unknown>) | object | null | undefined) {
  const id = obj && (obj as { id?: unknown }).id;
  if (typeof id !== 'string' || !id) return;
  hub.set((s) => ({ [kind]: { ...(s[kind] as Record<string, unknown>), [id]: { ...((s[kind] as Record<string, object>)[id] || {}), ...obj } } }) as Partial<HubData>);
}

function upsertMsg(list: Message[] | undefined, m: Message): Message[] {
  const arr = list ? list.slice() : [];
  const i = arr.findIndex((x) => x.id === m.id);
  if (i >= 0) arr[i] = { ...arr[i], ...m };
  else {
    arr.push(m);
    arr.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }
  return arr;
}

/** replace: drop what was cached (after a hub restart the cache may hold rows the hub no longer has) */
export function setMessages(sessionId: string, msgs: Message[], replace = false) {
  hub.set((s) => {
    // merge: keep anything streamed in meanwhile (new messages, and text appended after the hub read its copy)
    let list = msgs.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    if (!replace) {
      const cached = new Map((s.messages[sessionId] || []).map((m) => [m.id, m]));
      list = list.map((m) => {
        const c = cached.get(m.id);
        return c && typeof c.text === 'string' && typeof m.text === 'string' && c.text.length > m.text.length && c.text.startsWith(m.text) ? c : m;
      });
      cached.forEach((m) => { if (!list.find((x) => x.id === m.id)) list = upsertMsg(list, m); });
    }
    return { messages: { ...s.messages, [sessionId]: list } };
  });
}

/** Command output kept per message (same tail rule as the hub). */
const OUTPUT_TAIL = 64 * 1024;
const TRUNCATED = '…truncated…\n';
export function clipTail(s: string, max = OUTPUT_TAIL): string {
  if (s.length <= max + TRUNCATED.length && (s.length <= max || s.startsWith(TRUNCATED))) return s;
  return TRUNCATED + s.slice(-max);
}

export interface MessageAppend { id: string; session_id: string; seq?: number; kind?: string; field?: 'output'; append: string; at?: number; reset?: boolean; len?: number }
/**
 * Apply a streamed append to a cached message. `at` is the offset the append starts at, so a repeated append is
 * skipped and an overlapping one adds only its new part. Returns null when the message is unknown or text is
 * missing before `at` (the caller refetches the transcript).
 */
export function applyAppend(m: Message | undefined, d: MessageAppend): Message | null {
  if (!m) return null;
  const add = (cur: string, curLen: number): { text: string; len: number } | null => {
    if (d.at == null || d.at === curLen) return { text: cur + d.append, len: curLen + d.append.length };
    if (d.at > curLen) return null;
    const over = curLen - d.at;
    return over >= d.append.length ? { text: cur, len: curLen } : { text: cur + d.append.slice(over), len: d.at + d.append.length };
  };
  if (d.field === 'output') {
    const data = m.data || {};
    if (d.reset) return { ...m, data: { ...data, output: d.append, outputLen: d.len ?? d.append.length } };
    const cur = String(data.output ?? '');
    const r = add(cur, Number(data.outputLen ?? cur.length));
    return r ? (r.text === cur ? m : { ...m, data: { ...data, output: clipTail(r.text), outputLen: r.len } }) : null;
  }
  if (d.reset) return { ...m, text: d.append };
  const cur = m.text || '';
  const r = add(cur, cur.length);
  return r ? (r.text === cur ? m : { ...m, text: r.text }) : null;
}

/** an append for a message we do not have (or with a gap): refetch that transcript, once at a time */
const refetching = new Set<string>();
function refetchForAppend(sessionId: string) {
  if (refetching.has(sessionId)) return;
  refetching.add(sessionId);
  setTimeout(() => { void fetchMessages(sessionId).finally(() => refetching.delete(sessionId)); }, 150);
}

export function applyEvent(ev: HubEvent) {
  const s = hub.get();
  if (typeof ev.seq === 'number' && ev.seq > 0 && ev.seq <= s.seq) return;
  const seq = typeof ev.seq === 'number' && ev.seq > s.seq ? ev.seq : s.seq;
  const d = ev.data;
  switch (ev.type) {
    case 'host.upsert': hub.set({ seq, hosts: { ...s.hosts, [d.id]: d } }); break;
    case 'checkout.upsert': hub.set({ seq, checkouts: { ...s.checkouts, [d.id]: d } }); break;
    case 'session.upsert': hub.set({ seq, sessions: { ...s.sessions, [d.id]: { ...(s.sessions[d.id] || {}), ...d } } }); break;
    case 'message.upsert': hub.set({ seq, messages: { ...s.messages, [d.session_id]: upsertMsg(s.messages[d.session_id], d) } }); break;
    case 'message.append': {
      const list = s.messages[d.session_id];
      const i = list ? list.findIndex((x) => x.id === d.id) : -1;
      const next = i >= 0 ? applyAppend(list![i], d) : null;
      if (!next) {
        hub.set({ seq });
        // only transcripts that are loaded (on screen or cached) are worth fetching
        if (list || watched.has(d.session_id)) refetchForAppend(d.session_id);
      } else if (next !== list![i]) {
        const copy = list!.slice();
        copy[i] = next;
        hub.set({ seq, messages: { ...s.messages, [d.session_id]: copy } });
      } else hub.set({ seq });
      break;
    }
    case 'approval.upsert': hub.set({ seq, approvals: { ...s.approvals, [d.id]: d } }); break;
    case 'node.upsert': hub.set({ seq, nodes: { ...s.nodes, [d.id]: d } }); break;
    case 'node.remove': {
      const nodes = { ...s.nodes }; delete nodes[d.id];
      hub.set({ seq, nodes });
      break;
    }
    case 'audit.append': hub.set({ seq, audit: [d, ...s.audit].slice(0, 500) }); break;
    case 'layout.upsert': {
      const { nodeId, removed, ...rest } = d;
      const layout = { ...s.layout };
      if (removed) delete layout[nodeId];
      else layout[nodeId] = { ...(s.layout[nodeId] || {}), ...rest };
      hub.set({ seq, layout });
      break;
    }
    case 'layout.bulk': {
      const layout = { ...s.layout };
      (d.entries || []).forEach(({ nodeId, removed, ...rest }: any) => {
        if (removed) delete layout[nodeId];
        else layout[nodeId] = { ...(layout[nodeId] || {}), ...rest };
      });
      hub.set({ seq, layout });
      break;
    }
    case 'canvas.changed': hub.set({ seq }); onCanvasChanged(d); break;
    case 'usage.upsert': hub.set({ seq, usage: { ...s.usage, [`${d.vendor}:${d.accountId}`]: d } }); break;
    case 'canvas.undone': hub.set({ seq }); ui.set((u) => ({ changes: u.changes.map((c) => (c.batchId === d.batchId ? { ...c, undone: true } : c)) })); break;
    case 'canvas.ui': {
      hub.set({ seq });
      if (d.layoutMode) setLayoutMode(d.layoutMode);
      if (Array.isArray(d.select)) ui.set({ selected: Object.fromEntries(d.select.map((x: string) => [x, true])) });
      if (d.focus) focusNode(d.focus);
      break;
    }
    case 'toast': hub.set({ seq }); toast(d.text, d.level); break;
    case 'project.upsert': hub.set({ seq, projects: { ...s.projects, [d.id]: norm.project(d) } }); break;
    case 'branch.upsert': hub.set({ seq, branches: { ...s.branches, [d.id]: norm.branch(d) } }); break;
    case 'branch.remove': hub.set({ seq, branches: without(s.branches, d.id) }); break;
    case 'machine.upsert': hub.set({ seq, machines: { ...s.machines, [d.id]: norm.machine(d) } }); break;
    case 'device.upsert': hub.set({ seq, devices: { ...s.devices, [d.id]: norm.device(d) } }); break;
    case 'cnode.upsert': hub.set({ seq, cnodes: { ...s.cnodes, [d.id]: norm.cnode(d) } }); break;
    case 'cnode.remove': hub.set({ seq, cnodes: without(s.cnodes, d.id) }); break;
    case 'todo.upsert': hub.set({ seq, todos: { ...s.todos, [d.id]: d } }); break;
    case 'todo.remove': hub.set({ seq, todos: without(s.todos, d.id) }); break;
    case 'grant.upsert': hub.set({ seq, grants: { ...s.grants, [d.id]: d } }); break;
    case 'hil.upsert': hub.set({ seq, hilRuns: { ...s.hilRuns, [d.id]: norm.run(d) } }); break;
    default: hub.set({ seq });
  }
}

// ---------- UI store ----------
export type Tab = 'canvas' | 'sessions' | 'repos' | 'audit';
export type LayoutMode = 'cluster' | 'columns' | 'tree' | 'custom';
export interface ToastItem { id: number; text: string; level: 'info' | 'warn' | 'error' }
export interface ConfirmReq { id: number; title: string; detail: string; tool: string; args: unknown; action?: string; resolve: (ok: boolean) => void }

export interface UIState {
  tab: Tab;
  layoutMode: LayoutMode;
  search: string;
  filter: string | null; // host id | 'cloud:claude' | 'cloud:codex'
  expanded: Record<string, boolean>;
  focusId: string | null;
  /** canvas multi-selection (marquee / click) */
  selected: Record<string, true>;
  panTo: { id: string; n: number } | null;
  repoCheckout: string | null;
  toasts: ToastItem[];
  confirm: ConfirmReq | null;
  spawnOpen: boolean;
  spawnPreset: SpawnPreset | null;
  promoteId: string | null;
  // v2
  quickOpen: QuickOpenReq | null;
  branchModal: { projectId: string; base: string; checkoutId?: string } | null;
  reviewId: string | null;
  repoSource: FileSource | null;
  addMenu: { x?: number; y?: number; parentId?: string | null; kind?: string } | null;
  // Ask Claude
  askOpen: boolean;
  askBar: boolean;
  /** Custom layout starts from this auto layout (the one showing when Claude or you first pinned positions) */
  customBase: Exclude<LayoutMode, 'custom'>;
  changes: CanvasChange[];
  glow: Record<string, number>;
  /** Delete with running sessions or terminals in the selection waits for this dialog */
  deleteAsk: { ids: string[]; running: number; terminals: number; kept: number } | null;
}
export interface SpawnPreset { checkoutId?: string; branch?: string; prompt?: string; hostId?: string; title?: string }
export interface QuickOpenReq { source?: FileSource; parentId?: string | null; scopeLabel?: string }

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
export function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

export const ui = createStore<UIState>({
  tab: 'canvas',
  layoutMode: (lsGet('hub.layoutMode') as LayoutMode) || 'columns',
  search: '', filter: null, expanded: {}, focusId: null, selected: {}, panTo: null, repoCheckout: null,
  toasts: [], confirm: null, spawnOpen: false, spawnPreset: null, promoteId: null,
  quickOpen: null, branchModal: null, reviewId: null, repoSource: null, addMenu: null,
  askOpen: lsGet('hub.askOpen') === '1', askBar: false,
  customBase: ((b) => (b === 'cluster' || b === 'tree' ? b : 'columns'))(lsGet('hub.customBase')),
  changes: [], glow: {}, deleteAsk: null,
});

/** Switch layout mode; entering Custom from an auto layout keeps that layout as the base. */
export function setLayoutMode(mode: LayoutMode) {
  const cur = ui.get().layoutMode;
  if (mode === 'custom' && cur !== 'custom') { ui.set({ customBase: cur }); lsSet('hub.customBase', cur); }
  ui.set({ layoutMode: mode });
  lsSet('hub.layoutMode', mode);
}

function onCanvasChanged(d: CanvasChange) {
  const until = Date.now() + 3500;
  ui.set((u) => {
    const glow = { ...u.glow };
    d.ids.forEach((id) => { glow[id] = until; });
    const changes = [d, ...u.changes.filter((c) => c.batchId !== d.batchId)].slice(0, 8);
    return { glow, changes };
  });
  // moves only show in Custom: keep the current auto layout underneath so nothing else jumps
  if (d.moved && ui.get().layoutMode !== 'custom') setLayoutMode('custom');
  setTimeout(() => ui.set((u) => {
    const glow = { ...u.glow };
    Object.keys(glow).forEach((k) => { if (glow[k] <= Date.now()) delete glow[k]; });
    return { glow };
  }), 3600);
}
export const useUI = <R,>(sel: (s: UIState) => R) => useStore(ui, sel);

let toastN = 0;
export function toast(text: string, level: ToastItem['level'] = 'info') {
  const id = ++toastN;
  ui.set((s) => ({ toasts: [...s.toasts, { id, text, level }].slice(-4) }));
  setTimeout(() => ui.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), level === 'error' ? 6000 : 3800);
}

let confirmN = 0;
export function requestConfirm(title: string, detail: string, tool: string, args: unknown, action?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const prev = ui.get().confirm;
    if (prev) prev.resolve(false);
    ui.set({ confirm: { id: ++confirmN, title, detail, tool, args, action, resolve } });
  });
}

export function focusNode(id: string, expand = false) {
  const n = (ui.get().panTo?.n || 0) + 1;
  ui.set((s) => ({ tab: 'canvas', focusId: id, panTo: { id, n }, expanded: expand ? { ...s.expanded, [id]: true } : s.expanded }));
}

export function setExpanded(id: string, on: boolean) {
  ui.set((s) => {
    const expanded = { ...s.expanded };
    if (on) expanded[id] = true; else delete expanded[id];
    return { expanded };
  });
}

// ---------- connection ----------
// Messages are not in the snapshot, so every (re)connect refetches the transcripts on screen (watchMessages).
// The hub says hello first (resync when it restarted or the replay ring no longer covers us) and sends a keepalive
// every 25 s; a socket silent for longer than DEAD_MS is treated as dead. Coming back to the page reconnects at once.
let ws: WebSocket | null = null;
let backoff = 1000;
let stopped = false;
let paused = false;
let live = false;
let reconnectTimer: number | undefined;
let lastFrame = 0;
let boot: string | null = null;
const DEAD_MS = 60_000;
const STALE_ON_WAKE_MS = 35_000;

/** transcripts on screen (expanded nodes, the phone sheet, the Ask panel), refcounted */
const watched = new Map<string, number>();
async function fetchMessages(id: string, replace = false) {
  try { setMessages(id, await api.messages(id), replace); } catch { /* offline: refetched on reconnect */ }
}
/** Load a session's messages now and after every reconnect while the returned function has not been called. */
export function watchMessages(id: string): () => void {
  watched.set(id, (watched.get(id) || 0) + 1);
  void fetchMessages(id);
  return () => {
    const n = (watched.get(id) || 1) - 1;
    if (n <= 0) watched.delete(id); else watched.set(id, n);
  };
}
function refetchWatched(replace: boolean) {
  // transcripts nobody is looking at are dropped; opening one fetches it again
  hub.set((s) => ({ messages: Object.fromEntries(Object.entries(s.messages).filter(([k]) => watched.has(k))) }));
  watched.forEach((_, id) => { void fetchMessages(id, replace); });
}

export async function loadState(): Promise<boolean> {
  try {
    const r = await api.state();
    if (r.status === 401) { hub.set({ authRequired: true, ready: false }); return false; }
    if (!r.ok) { hub.set({ error: `Hub returned ${r.status}` }); return false; }
    const restarted = boot !== null && !!r.data.boot && r.data.boot !== boot;
    applySnapshot(r.data);
    boot = r.data.boot ?? null;
    refetchWatched(restarted);
    return true;
  } catch (e) {
    hub.set({ error: (e as Error).message || 'Hub unreachable' });
    return false;
  }
}

/** close the current socket without triggering its own reconnect */
function drop() {
  window.clearTimeout(reconnectTimer);
  const old = ws;
  ws = null;
  if (old) {
    old.onclose = null; old.onmessage = null; old.onerror = null; old.onopen = null;
    try { old.close(); } catch { /* */ }
  }
  hub.set({ connected: false });
}

async function reconnect() {
  if (stopped || paused) return;
  const ok = await loadState();
  if (stopped || paused) return;
  if (ok) openSocket();
  else if (!hub.get().authRequired) scheduleReconnect();
}

function scheduleReconnect() {
  if (stopped || paused) return;
  const wait = backoff;
  backoff = Math.min(backoff * 2, 30000);
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => { void reconnect(); }, wait);
}

/** reconnect right away (page visible again, network back): fresh backoff */
function reconnectNow() {
  if (stopped || paused) return;
  backoff = 1000;
  drop();
  void reconnect();
}

function openSocket() {
  if (stopped || paused) return;
  if (ws) drop();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/api/events?since=${hub.get().seq}${boot ? `&boot=${encodeURIComponent(boot)}` : ''}`;
  let sock: WebSocket;
  try { sock = new WebSocket(url); } catch { scheduleReconnect(); return; }
  ws = sock;
  lastFrame = Date.now();
  sock.onopen = () => { backoff = 1000; lastFrame = Date.now(); hub.set({ connected: true, error: null }); };
  sock.onmessage = (e) => {
    lastFrame = Date.now();
    try {
      const frame = JSON.parse(typeof e.data === 'string' ? e.data : '');
      if (frame?.type === 'keepalive') return;
      if (frame?.type === 'hello') {
        // another hub run, or events we can no longer replay: reload everything (the socket stays)
        if (frame.data?.resync || (boot && frame.data?.boot && frame.data.boot !== boot)) void loadState();
        return;
      }
      if (Array.isArray(frame)) frame.forEach(applyEvent); else applyEvent(frame);
    } catch { /* ignore malformed frame */ }
  };
  sock.onclose = () => { if (ws !== sock) return; ws = null; hub.set({ connected: false }); scheduleReconnect(); };
  sock.onerror = () => { try { sock.close(); } catch { /* */ } };
}

function wake() {
  if (stopped || paused || !live || document.visibilityState === 'hidden') return;
  const open = ws && ws.readyState === WebSocket.OPEN;
  if (!open || Date.now() - lastFrame > STALE_ON_WAKE_MS) reconnectNow();
}

export async function startLive() {
  stopped = false;
  if (!live) {
    live = true;
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
    // silence longer than two keepalives: the socket is dead even if the browser has not noticed
    window.setInterval(() => {
      if (!paused && ws && ws.readyState === WebSocket.OPEN && Date.now() - lastFrame > DEAD_MS) reconnectNow();
    }, 10_000);
    // test hook: hold the event socket closed (as if offline), then reconnect
    (globalThis as unknown as { __hubConn?: unknown }).__hubConn = {
      pause: () => { paused = true; drop(); },
      resume: () => { paused = false; reconnectNow(); },
    };
  }
  await reconnect();
}

export function startMock(subscribe: (fn: (ev: HubEvent) => void) => void, snapshot: StateSnapshot) {
  applySnapshot(snapshot);
  hub.set({ connected: true });
  subscribe(applyEvent);
}
