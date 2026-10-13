// Thin client for the hub HTTP API (docs/API.md). In mock mode every request is
// routed to an in-page handler instead of fetch().
import type {
  AppNode, Audit, CallToolResult, Checkout, Message, Review, Session, StateSnapshot,
} from './types';

export interface ApiResponse<T = any> { ok: boolean; status: number; data: T }
export type MockHandler = (method: string, path: string, body?: unknown) => Promise<ApiResponse>;

let mock: MockHandler | null = null;
export function setMockHandler(h: MockHandler | null) { mock = h; }
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
  removeApp: (id: string) => call('DELETE', `/api/apps/${enc(id)}`),
  audit: (node?: string) => call<Audit[]>('GET', `/api/audit${node ? `?node=${enc(node)}` : ''}`),
  layout: (body: { nodeId: string; x: number; y: number; w?: number; h?: number; collapsed?: boolean }) => call('POST', '/api/layout', body),
  vapid: () => call<{ publicKey: string }>('GET', '/api/push/vapid'),
  pushSubscribe: (subscription: unknown) => call('POST', '/api/push/subscribe', { subscription }),
  pushTest: () => call('POST', '/api/push/test', {}),
};
