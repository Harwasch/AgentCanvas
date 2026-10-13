// MCP Apps host bridge: JSON-RPC 2.0 over postMessage between the PWA and one
// sandboxed app iframe (opaque origin → we reply with targetOrigin '*', and only
// accept messages whose source is that iframe's contentWindow).
import { api } from './api';
import { requestConfirm, toast } from './store';
import type { AppNode, CallToolResult } from './types';

export const PROTOCOL_VERSION = '2026-01-26';

interface RpcError { code: number; message: string; data?: unknown }
const rpcError = (code: number, message: string, data?: unknown): RpcError => ({ code, message, data });

export interface BridgeOptions {
  getNode: () => AppNode;
  getSize: () => { width: number; height: number };
  onReady?: () => void;
}

export class AppBridge {
  ready = false;
  private nextId = 1;
  private pending = new Map<number | string, (v: unknown) => void>();
  private attached = false;

  constructor(private iframe: HTMLIFrameElement, private opts: BridgeOptions) {}

  attach() {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener('message', this.onMessage);
  }

  detach() {
    this.attached = false;
    window.removeEventListener('message', this.onMessage);
    this.pending.forEach((r) => r(undefined));
    this.pending.clear();
    this.ready = false;
  }

  private post(msg: object) {
    const w = this.iframe.contentWindow;
    if (w) w.postMessage({ jsonrpc: '2.0', ...msg }, '*');
  }

  /** Host → view request (only after the view sent `initialized`). */
  request(method: string, params: unknown, timeoutMs = 1000): Promise<unknown> {
    if (!this.ready) return Promise.resolve(undefined);
    const id = `h${this.nextId++}`;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pending.delete(id); resolve(undefined); }, timeoutMs);
      this.pending.set(id, (v) => { clearTimeout(t); resolve(v); });
      this.post({ id, method, params });
    });
  }

  notify(method: string, params: unknown = {}) {
    if (this.ready) this.post({ method, params });
  }

  /** Best-effort `ui/resource-teardown` before the iframe is removed. */
  teardown(timeoutMs = 250): Promise<void> {
    if (!this.ready) return Promise.resolve();
    return this.request('ui/resource-teardown', { reason: 'host-unmount' }, timeoutMs).then(() => undefined);
  }

  private onMessage = (e: MessageEvent) => {
    const w = this.iframe.contentWindow;
    if (!w || e.source !== w) return;
    const m = e.data;
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return;
    if (typeof m.method === 'string') {
      if (m.id !== undefined && m.id !== null) void this.handleRequest(m.id, m.method, m.params ?? {});
      else this.handleNotification(m.method, m.params ?? {});
    } else if (m.id !== undefined && this.pending.has(m.id)) {
      const r = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      r(m.result ?? m.error);
    }
  };

  private handleNotification(method: string, params: any) {
    switch (method) {
      case 'ui/notifications/initialized':
        if (!this.ready) { this.ready = true; this.opts.onReady?.(); }
        break;
      case 'notifications/message':
        // eslint-disable-next-line no-console
        console.log(`[app ${this.opts.getNode().id}]`, params?.level ?? 'info', params?.data ?? params);
        break;
      case 'ui/notifications/size-changed':
      default:
        break;
    }
  }

  private async handleRequest(id: number | string, method: string, params: any) {
    try {
      const result = await this.dispatch(method, params);
      this.post({ id, result });
    } catch (err) {
      const e = err as Partial<RpcError> & Error;
      this.post({ id, error: { code: typeof e.code === 'number' ? e.code : -32603, message: e.message || 'Internal error', ...(e.data !== undefined ? { data: e.data } : {}) } });
    }
  }

  private async dispatch(method: string, params: any): Promise<unknown> {
    const node = this.opts.getNode();
    switch (method) {
      case 'ui/initialize': {
        this.ready = false;
        const { width, height } = this.opts.getSize();
        return {
          protocolVersion: PROTOCOL_VERSION,
          hostInfo: { name: 'agent-hub', version: '0.1.0' },
          hostCapabilities: { serverTools: {}, serverResources: {}, openLinks: {}, logging: {}, message: { text: {} } },
          hostContext: {
            theme: 'dark', displayMode: 'inline', platform: 'web',
            containerDimensions: { width: Math.round(width), height: Math.round(height) },
            appState: node.state,
          },
        };
      }
      case 'ping':
        return {};
      case 'tools/call':
        return this.callTool(node, String(params?.name ?? ''), params?.arguments ?? {});
      case 'resources/read': {
        const r = await api.readResource(node.id, String(params?.uri ?? ''));
        if (!r.ok) throw rpcError(-32002, (r.data && (r.data.reason || r.data.error)) || `resource read failed (${r.status})`);
        return r.data;
      }
      case 'ui/open-link': {
        const url = String(params?.url ?? '');
        if (!/^https?:\/\//i.test(url)) throw rpcError(-32000, 'only http(s) links can be opened');
        window.open(url, '_blank', 'noopener,noreferrer');
        return {};
      }
      case 'ui/message': {
        const content = Array.isArray(params?.content) ? params.content : params?.content ? [params.content] : [];
        const text = content.filter((c: any) => c && c.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n').trim();
        if (!text || !node.sessionId) return { isError: true };
        await api.send(node.sessionId, text);
        return {};
      }
      case 'ui/update-model-context':
        return {};
      default:
        throw rpcError(-32601, `Method not found: ${method}`);
    }
  }

  private async callTool(node: AppNode, name: string, args: unknown): Promise<CallToolResult> {
    const decl = node.manifest?.tools?.[name];
    let confirmed = false;
    if (decl && decl.tier === 'actuate' && decl.confirm && node.state === 'promoted') {
      confirmed = await requestConfirm(`${node.title} wants to run ${name}`, 'This is an actuate tool: it changes real hardware or state.', name, args);
      if (!confirmed) return { isError: true, content: [{ type: 'text', text: 'cancelled by user' }] };
    }
    const r = await api.callApp(node.id, name, args, confirmed);
    if (r.status === 409) {
      const d = (r.data || {}) as { code?: string; reason?: string };
      const reason = d.reason || d.code || 'policy refused';
      toast(`${node.title}: ${name} blocked by hub — ${reason}`, 'warn');
      return { isError: true, content: [{ type: 'text', text: `blocked by hub: ${reason}` }] };
    }
    if (!r.ok) {
      const d = r.data as any;
      throw rpcError(-32603, (d && (d.reason || d.error || d.message)) || `tool call failed (${r.status})`);
    }
    return r.data as CallToolResult;
  }
}
