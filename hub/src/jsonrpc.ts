// Minimal JSON-RPC 2.0 peer used for: the Codex app-server (WebSocket frames,
// one message per frame), MCP stdio servers (newline-delimited), and the hub
// channel relay (newline-delimited). Framing lives outside; this class only
// correlates ids and dispatches.

export type Json = any;

export interface RpcMessage {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { code: number; message: string; data?: Json };
}

export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: Json) {
    super(message);
  }
}

type Pending = { resolve: (v: Json) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout; method: string };

export interface PeerOptions {
  /** include "jsonrpc":"2.0" on outgoing messages (Codex app-server omits it on the wire) */
  includeVersion?: boolean;
  timeoutMs?: number;
}

export class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<string, Pending>();
  onNotification: (method: string, params: Json) => void = () => {};
  /** server-initiated request handler; return value becomes the result, throw RpcError for errors */
  onRequest: (method: string, params: Json, id: number | string) => Promise<Json> | Json = (m) => {
    throw new RpcError(-32601, `method not found: ${m}`);
  };
  /** if set, a server request is parked: the handler is responsible for calling respond() later */
  closed = false;

  constructor(private sendRaw: (msg: RpcMessage) => void, private opts: PeerOptions = {}) {}

  private out(msg: RpcMessage) {
    if (this.closed) throw new Error('rpc peer closed');
    this.sendRaw(this.opts.includeVersion === false ? msg : { jsonrpc: '2.0', ...msg });
  }

  request<T = Json>(method: string, params?: Json, timeoutMs?: number): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve, reject, method };
      const to = timeoutMs ?? this.opts.timeoutMs ?? 60000;
      if (to > 0) p.timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new RpcError(-32000, `timeout waiting for ${method}`));
      }, to);
      this.pending.set(String(id), p);
      try {
        this.out(params === undefined ? { id, method } : { id, method, params });
      } catch (e) {
        this.pending.delete(String(id));
        if (p.timer) clearTimeout(p.timer);
        reject(e as Error);
      }
    });
  }

  notify(method: string, params?: Json) {
    this.out(params === undefined ? { method } : { method, params });
  }

  respond(id: number | string, result: Json) {
    this.out({ id, result });
  }

  respondError(id: number | string, code: number, message: string, data?: Json) {
    this.out({ id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  }

  /** Feed one decoded message (object). Returns false if it was not a valid JSON-RPC message. */
  handle(msg: RpcMessage): boolean {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (msg.method && hasId) {
      const id = msg.id as number | string;
      Promise.resolve()
        .then(() => this.onRequest(msg.method!, msg.params, id))
        .then((r) => {
          if (r !== PARKED) this.respond(id, r ?? {});
        })
        .catch((e) => {
          if (this.closed) return;
          if (e instanceof RpcError) this.respondError(id, e.code, e.message, e.data);
          else this.respondError(id, -32603, String(e?.message || e));
        })
        .catch(() => {}); // the transport went away while answering
      return true;
    }
    if (msg.method) {
      this.onNotification(msg.method, msg.params);
      return true;
    }
    if (hasId && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(String(msg.id));
      if (!p) return true;
      this.pending.delete(String(msg.id));
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
      return true;
    }
    return false;
  }

  close(reason = 'closed') {
    this.closed = true;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcError(-32001, `${reason} (pending ${p.method})`));
    }
    this.pending.clear();
  }
}

/** Return from onRequest to answer later via respond(). */
export const PARKED = Symbol('parked');

/**
 * Newline-delimited JSON decoder tolerant of arbitrary chunk boundaries,
 * CRLF, blank lines, and multi-byte UTF-8 split across chunks.
 */
export class NdjsonDecoder {
  private buf = '';
  private td = new TextDecoder('utf-8');
  constructor(private onMessage: (m: any) => void, private onBadLine: (line: string, err: Error) => void = () => {}) {}
  push(chunk: Buffer | Uint8Array | string) {
    this.buf += typeof chunk === 'string' ? chunk : this.td.decode(chunk, { stream: true });
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch (e) {
        this.onBadLine(line, e as Error);
        continue;
      }
      try {
        this.onMessage(m);
      } catch (e) {
        // a handler choking on one message must not take the stream (or the hub) down
        this.onBadLine(line, e as Error);
      }
    }
  }
}

export const ndjson = (m: any) => JSON.stringify(m) + '\n';
