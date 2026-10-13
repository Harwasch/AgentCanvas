// Thin client for the hub HTTP API (docs/API.md). In mock mode every request is
// routed to an in-page handler instead of fetch().
import type {
  AppNode, Audit, Branch, CNode, CallToolResult, Checkout, FileKind, FileSource, Grant, LayoutEntry, Message, Review, Session, StateSnapshot, Todo,
} from './types';

export interface ApiResponse<T = any> { ok: boolean; status: number; data: T }
export type MockHandler = (method: string, path: string, body?: unknown) => Promise<ApiResponse>;

let mock: MockHandler | null = null;
export function setMockHandler(h: MockHandler | null) { mock = h; }

/** Minimal WebSocket surface used by terminal nodes (a real WebSocket, or the mock's fake). */
export interface TermSocket {
  binaryType: BinaryType;
  readyState: number;
  onopen: ((e?: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
let mockTerm: ((id: string) => TermSocket) | null = null;
export function setMockTerminal(f: ((id: string) => TermSocket) | null) { mockTerm = f; }
export function openTerminalSocket(id: string): TermSocket {
  if (mockTerm) return mockTerm(id);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/terminals/${encodeURIComponent(id)}/ws`);
  ws.binaryType = 'arraybuffer';
  return ws as unknown as TermSocket;
}

/** URL of a file's raw bytes (img/iframe src). In mock mode the mock serves blob/data URLs. */
let mockRaw: ((source: FileSource, path: string, sha?: string) => string) | null = null;
export function setMockRaw(f: typeof mockRaw) { mockRaw = f; }
export function rawUrl(source: FileSource, path: string, sha?: string | null): string {
  if (mockRaw) return mockRaw(source, path, sha || undefined);
  const q = new URLSearchParams({ source: JSON.stringify(source), path });
  if (sha) q.set('sha', sha);
  return `/api/files/raw?${q.toString()}`;
}
/** Fetch a file's raw bytes as text (rendered docs, code). */
export async function fetchRawText(source: FileSource, path: string, sha?: string | null): Promise<string> {
  const r = await fetch(rawUrl(source, path, sha), { credentials: 'same-origin' });
  if (!r.ok) throw new ApiError(r.status, { message: await r.text().catch(() => '') });
  return r.text();
}
export async function fetchRawBytes(source: FileSource, path: string, sha?: string | null): Promise<ArrayBuffer> {
  const r = await fetch(rawUrl(source, path, sha), { credentials: 'same-origin' });
  if (!r.ok) throw new ApiError(r.status, { message: await r.text().catch(() => '') });
  return r.arrayBuffer();
}
export const isMock = () => mock !== null;

export class ApiError extends Error {
  constructor(public status: number, public data: any) {
    super((data && (data.reason || data.error || data.message)) || `HTTP ${status}`);
  }
}

export async function request<T = any>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
  if (mock) return mock(method, path, body) as Promise<ApiResponse<T>>;
  const init: RequestInit = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  const res = await fetch(path, init);
  let data: any = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) {
    try { data = await res.json(); } catch { data = null; }
  } else {
    const t = await res.text();
    data = t ? { message: t } : null;
  }
  return { ok: res.ok, status: res.status, data };
}

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await request<T>(method, path, body);
  if (!r.ok) throw new ApiError(r.status, r.data);
  return r.data;
}

const enc = encodeURIComponent;

export const api = {
  state: () => request<StateSnapshot>('GET', '/api/state'),
  createSession: (body: {
    vendor: string; where: 'host' | 'cloud'; hostId?: string; accountId: string; checkoutId?: string; cwd?: string;
    branch?: string; environment?: string; prompt: string; attempts?: number; model?: string; effort?: string;
  }) => call<Session>('POST', '/api/sessions', body),
  messages: (id: string) => call<Message[]>('GET', `/api/sessions/${enc(id)}/messages`),
  send: (id: string, text: string) => call('POST', `/api/sessions/${enc(id)}/send`, { text }),
  interrupt: (id: string) => call('POST', `/api/sessions/${enc(id)}/interrupt`, {}),
  settings: (id: string, s: { model?: string; effort?: string }) => call('POST', `/api/sessions/${enc(id)}/settings`, s),
  stop: (id: string) => call('POST', `/api/sessions/${enc(id)}/stop`, {}),
  refresh: (id: string) => call<any>('POST', `/api/sessions/${enc(id)}/refresh`, {}),
  decide: (id: string, decision: 'allow' | 'deny' | 'allowSession') => call('POST', `/api/approvals/${enc(id)}`, { decision }),
  files: (id: string) => call<{ files: { path: string; xy: string | null }[] }>('GET', `/api/checkouts/${enc(id)}/files`),
  file: (id: string, path: string) => call<{ path: string; content: string }>('GET', `/api/checkouts/${enc(id)}/file?path=${enc(path)}`),
  refreshCheckout: (id: string) => call<Checkout>('POST', `/api/checkouts/${enc(id)}/refresh`, {}),
  publishApp: (hostId: string, dir: string, sessionId?: string) => call<AppNode>('POST', '/api/apps/publish', { hostId, dir, sessionId }),
  callApp: (id: string, tool: string, args: unknown, confirmed: boolean) =>
    request<CallToolResult | { code: string; reason: string }>('POST', `/api/apps/${enc(id)}/call`, { tool, arguments: args ?? {}, confirmed }),
  readResource: (id: string, uri: string) => request('POST', `/api/apps/${enc(id)}/resource`, { uri }),
  review: (id: string) => call<Review>('GET', `/api/apps/${enc(id)}/review`),
  promote: (id: string, body: { commit: string; grantActuate: boolean; commitDirty?: boolean; reviewHash: string }) =>
    call<AppNode>('POST', `/api/apps/${enc(id)}/promote`, body),
  reload: (id: string) => call('POST', `/api/apps/${enc(id)}/reload`, {}),
  login: (token: string) => request<{ ok: boolean }>('POST', '/login', { token }),
  removeApp: (id: string) => call('DELETE', `/api/apps/${enc(id)}`),
  audit: (node?: string) => call<Audit[]>('GET', `/api/audit${node ? `?node=${enc(node)}` : ''}`),
  layout: (body: { nodeId: string; x: number; y: number; w?: number; h?: number; collapsed?: boolean; size?: LayoutEntry['size'] }) => call('POST', '/api/layout', body),
  vapid: () => call<{ publicKey: string }>('GET', '/api/push/vapid'),
  pushSubscribe: (subscription: unknown) => call('POST', '/api/push/subscribe', { subscription }),
  pushTest: () => call('POST', '/api/push/test', {}),

  // ---- v2
  createCNode: (body: { type: 'note' | 'todos' | 'file' | 'terminal'; parentId?: string | null; data: unknown }) => call<CNode>('POST', '/api/cnodes', body),
  updateCNode: (id: string, data: unknown) => call<CNode>('POST', `/api/cnodes/${enc(id)}`, { data }),
  deleteCNode: (id: string) => call('DELETE', `/api/cnodes/${enc(id)}`),
  latest: (id: string) => call<CNode>('POST', `/api/cnodes/${enc(id)}/latest`, {}),
  createTodo: (text: string, scope: string | null) => call<Todo>('POST', '/api/todos', { text, scope }),
  updateTodo: (id: string, patch: { text?: string; done?: boolean }) => call<Todo>('POST', `/api/todos/${enc(id)}`, patch),
  deleteTodo: (id: string) => call('DELETE', `/api/todos/${enc(id)}`),
  dispatchTodo: (id: string, body: { vendor: string; where: 'host' | 'cloud'; hostId?: string; accountId: string; checkoutId?: string; branchId?: string }) =>
    call<Session>('POST', `/api/todos/${enc(id)}/dispatch`, body),
  launchSuggestion: (id: string, body: { vendor?: string; where?: 'host' | 'cloud'; hostId?: string; accountId?: string; checkoutId?: string } = {}) =>
    call<Session>('POST', `/api/suggestions/${enc(id)}/launch`, body),
  dismissSuggestion: (id: string) => call('POST', `/api/suggestions/${enc(id)}/dismiss`, {}),
  reviewDecision: (id: string, decision: 'approve' | 'changes', note?: string) => call('POST', `/api/reviews/${enc(id)}/decision`, { decision, note }),
  reviewComment: (id: string, text: string) => call('POST', `/api/reviews/${enc(id)}/comments`, { text }),
  listFiles: (source: FileSource, q = '') => call<{ files: { path: string; kind: FileKind }[] }>('GET', `/api/files/list?source=${enc(JSON.stringify(source))}&q=${enc(q)}`),
  createBranch: (body: { projectId: string; checkoutId: string; base: string; name: string; goal?: string; push?: boolean }) => call<Branch>('POST', '/api/branches', body),
  refreshBranch: (id: string) => call<Branch>('POST', `/api/branches/${enc(id)}/refresh`, {}),
  lockDevice: (id: string, sessionId: string | null) => call('POST', `/api/devices/${enc(id)}/lock`, { sessionId }),
  createGrant: (body: { sessionId: string; hostId: string; resources: string; purpose: string; quotaGB?: number }) => call<Grant>('POST', '/api/grants', body),
  setGrant: (id: string, status: 'active' | 'revoked') => call<Grant>('POST', `/api/grants/${enc(id)}`, { status }),
  hilRun: (planId: string) => call('POST', `/api/hil/${enc(planId)}/run`, {}),
  hilAbort: (runId: string) => call('POST', `/api/hil/runs/${enc(runId)}/abort`, {}),
  hilRerun: (runId: string) => call('POST', `/api/hil/runs/${enc(runId)}/rerun-failed`, {}),
  // canvas assistant
  assistantStart: (body: { hostId: string; accountId: string; prompt?: string }) => call<Session>('POST', '/api/assistant/start', body),
  canvasView: (body: unknown) => call('POST', '/api/canvas/view', body),
  canvasUndo: (batchId: string) => call('POST', `/api/canvas/undo/${enc(batchId)}`, {}),
  closeTerminal: (id: string) => call('DELETE', `/api/terminals/${enc(id)}`),
};
