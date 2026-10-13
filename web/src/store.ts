// Hub data store (snapshot + event stream) and small UI store.
import { useSyncExternalStore } from 'react';
import { api } from './api';
import type {
  Account, AppNode, Approval, Audit, Checkout, Host, HubEvent, LayoutEntry, Message, Session, StateSnapshot,
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
}

const byId = <T extends { id: string }>(arr: T[] | undefined) => {
  const o: Record<string, T> = {};
  (arr || []).forEach((x) => { o[x.id] = x; });
  return o;
};

export const hub = createStore<HubData>({
  ready: false, authRequired: false, error: null, connected: false, seq: 0,
  hosts: {}, accounts: {}, checkouts: {}, sessions: {}, approvals: {}, nodes: {}, layout: {}, config: {},
  messages: {}, audit: [],
});
export const useHub = <R,>(sel: (s: HubData) => R) => useStore(hub, sel);

export function applySnapshot(s: StateSnapshot) {
  hub.set({
    ready: true, authRequired: false, error: null, seq: s.seq || 0,
    hosts: byId(s.hosts), accounts: byId(s.accounts), checkouts: byId(s.checkouts), sessions: byId(s.sessions),
    approvals: byId(s.approvals), nodes: byId(s.nodes), layout: { ...(s.layout || {}) }, config: s.config || {},
  });
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

export function setMessages(sessionId: string, msgs: Message[]) {
  hub.set((s) => {
    // merge: keep anything streamed in meanwhile
    let list = msgs.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    (s.messages[sessionId] || []).forEach((m) => { if (!list.find((x) => x.id === m.id)) list = upsertMsg(list, m); });
    return { messages: { ...s.messages, [sessionId]: list } };
  });
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
    case 'approval.upsert': hub.set({ seq, approvals: { ...s.approvals, [d.id]: d } }); break;
    case 'node.upsert': hub.set({ seq, nodes: { ...s.nodes, [d.id]: d } }); break;
    case 'node.remove': {
      const nodes = { ...s.nodes }; delete nodes[d.id];
      hub.set({ seq, nodes });
      break;
    }
    case 'audit.append': hub.set({ seq, audit: [d, ...s.audit].slice(0, 500) }); break;
    case 'layout.upsert': {
      const { nodeId, ...rest } = d;
      hub.set({ seq, layout: { ...s.layout, [nodeId]: { ...(s.layout[nodeId] || {}), ...rest } } });
      break;
    }
    case 'toast': hub.set({ seq }); toast(d.text, d.level); break;
    default: hub.set({ seq });
  }
}

// ---------- UI store ----------
export type Tab = 'canvas' | 'sessions' | 'repos' | 'audit';
export type LayoutMode = 'cluster' | 'columns' | 'custom';
export interface ToastItem { id: number; text: string; level: 'info' | 'warn' | 'error' }
export interface ConfirmReq { id: number; title: string; detail: string; tool: string; args: unknown; resolve: (ok: boolean) => void }

export interface UIState {
  tab: Tab;
  layoutMode: LayoutMode;
  search: string;
  filter: string | null; // host id | 'cloud:claude' | 'cloud:codex'
  expanded: Record<string, boolean>;
  focusId: string | null;
  panTo: { id: string; n: number } | null;
  repoCheckout: string | null;
  toasts: ToastItem[];
  confirm: ConfirmReq | null;
  spawnOpen: boolean;
  spawnPreset: { checkoutId?: string } | null;
  promoteId: string | null;
}

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
export function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

export const ui = createStore<UIState>({
  tab: 'canvas',
  layoutMode: (lsGet('hub.layoutMode') as LayoutMode) || 'columns',
  search: '', filter: null, expanded: {}, focusId: null, panTo: null, repoCheckout: null,
  toasts: [], confirm: null, spawnOpen: false, spawnPreset: null, promoteId: null,
});
export const useUI = <R,>(sel: (s: UIState) => R) => useStore(ui, sel);

let toastN = 0;
export function toast(text: string, level: ToastItem['level'] = 'info') {
  const id = ++toastN;
  ui.set((s) => ({ toasts: [...s.toasts, { id, text, level }].slice(-4) }));
  setTimeout(() => ui.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), level === 'error' ? 6000 : 3800);
}

let confirmN = 0;
export function requestConfirm(title: string, detail: string, tool: string, args: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    const prev = ui.get().confirm;
    if (prev) prev.resolve(false);
    ui.set({ confirm: { id: ++confirmN, title, detail, tool, args, resolve } });
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
let ws: WebSocket | null = null;
let backoff = 1000;
let stopped = false;

export async function loadState(): Promise<boolean> {
  try {
    const r = await api.state();
    if (r.status === 401) { hub.set({ authRequired: true, ready: false }); return false; }
    if (!r.ok) { hub.set({ error: `Hub returned ${r.status}` }); return false; }
    applySnapshot(r.data);
    return true;
  } catch (e) {
    hub.set({ error: (e as Error).message || 'Hub unreachable' });
    return false;
  }
}

function scheduleReconnect() {
  if (stopped) return;
  const wait = backoff;
  backoff = Math.min(backoff * 2, 30000);
  setTimeout(async () => {
    if (stopped) return;
    const ok = await loadState();
    if (ok || !hub.get().authRequired) openSocket();
  }, wait);
}

function openSocket() {
  if (stopped) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/api/events?since=${hub.get().seq}`;
  try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
  ws.onopen = () => { backoff = 1000; hub.set({ connected: true, error: null }); };
  ws.onmessage = (e) => {
    try {
      const frame = JSON.parse(typeof e.data === 'string' ? e.data : '');
      if (Array.isArray(frame)) frame.forEach(applyEvent); else applyEvent(frame);
    } catch { /* ignore malformed frame */ }
  };
  ws.onclose = () => { hub.set({ connected: false }); ws = null; scheduleReconnect(); };
  ws.onerror = () => { try { ws?.close(); } catch { /* */ } };
}

export async function startLive() {
  stopped = false;
  const ok = await loadState();
  if (ok) openSocket();
  else if (!hub.get().authRequired) scheduleReconnect();
}

export function startMock(subscribe: (fn: (ev: HubEvent) => void) => void, snapshot: StateSnapshot) {
  applySnapshot(snapshot);
  hub.set({ connected: true });
  subscribe(applyEvent);
}
