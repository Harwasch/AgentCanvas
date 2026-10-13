// Codex driver: one WebSocket JSON-RPC client per (host, account), through
// `codex app-server proxy` over the multiplexed SSH connection. The proxy is a
// byte relay to the daemon's control socket, so the WebSocket upgrade and
// framing run over the SSH stdio stream. The daemon is shared with the ChatGPT
// desktop app: both are subscribers of the same loaded thread.
import { Duplex } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import type { Ctx } from '../ctx.js';
import { CodexAdapter } from '../adapters.js';
import { JsonRpcPeer, PARKED, RpcError } from '../jsonrpc.js';
import { newId, type Session } from '../store.js';
import { log } from '../events.js';

const L = log('codex');

interface Conn {
  key: string;
  hostId: string;
  accountId: string;
  proc?: ChildProcess;
  ws?: WebSocket;
  peer?: JsonRpcPeer;
  ready?: Promise<void>;
  up: boolean;
  backoff: number;
  subscribed: Set<string>; // thread ids
}

const textInput = (text: string) => [{ type: 'text', text, text_elements: [] }];

export class CodexDriver {
  private conns = new Map<string, Conn>();
  constructor(private c: Ctx) {}

  private home(accountId: string) {
    return this.c.account(accountId).codex?.home || '~/.codex';
  }

  /** Connect (idempotent): daemon start, proxy over SSH, WebSocket upgrade, initialize. */
  conn(hostId: string, accountId: string): Promise<Conn> {
    const key = `${hostId}/${accountId}`;
    let cn = this.conns.get(key);
    if (!cn) {
      cn = { key, hostId, accountId, up: false, backoff: 1000, subscribed: new Set() };
      this.conns.set(key, cn);
    }
    if (!cn.ready) cn.ready = this.open(cn).catch((e) => {
      cn!.ready = undefined;
      throw e;
    });
    return cn.ready.then(() => cn!);
  }

  private async open(cn: Conn) {
    const bin = this.c.hosts.bin(cn.hostId, 'codex');
    const home = this.home(cn.accountId);
    await this.c.boot.ensureCodexMcp(cn.hostId, this.c.account(cn.accountId)).catch((e) => L(`mcp config on ${cn.key}: ${e.message}`));
    const out = await this.c.hosts.execOk(cn.hostId, CodexAdapter.daemonStart(bin, home), { timeoutMs: 30000 });
    const life = CodexAdapter.parseLifecycle(out);
    L(`${cn.key}: daemon ${life?.status ?? 'unknown'} ${life?.socketPath ?? ''}`);
    const proc = this.c.hosts.spawn(cn.hostId, CodexAdapter.proxy(bin, home));
    cn.proc = proc;
    proc.stderr!.on('data', (d) => L(`${cn.key} proxy: ${String(d).trim()}`));
    const stream = Duplex.from({ readable: proc.stdout!, writable: proc.stdin! });
    const ws = new WebSocket('ws://localhost/', { createConnection: () => stream as any, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    cn.ws = ws;
    const peer = new JsonRpcPeer((m) => ws.send(JSON.stringify(m)), { includeVersion: false, timeoutMs: 120000 });
    cn.peer = peer;
    peer.onNotification = (method, params) => this.onNotification(cn, method, params);
    peer.onRequest = (method, params, id) => this.onServerRequest(cn, method, params, id);
    ws.on('message', (d) => {
      let m: any;
      try {
        m = JSON.parse(String(d));
      } catch {
        return;
      }
      try {
        peer.handle(m);
      } catch (e: any) {
        // one unexpected notification shape must not take the hub down
        L(`${cn.key}: error handling ${m?.method ?? `response ${m?.id}`}: ${e?.stack || e}`);
      }
    });
    const closed = () => {
      if (!cn.up && !cn.peer) return;
      cn.up = false;
      cn.ready = undefined;
      peer.close('codex connection closed');
      cn.peer = undefined;
      proc.kill();
      const had = [...cn.subscribed];
      cn.subscribed.clear();
      for (const s of this.c.store.sessions("vendor='codex' AND kind='local' AND host_id=? AND account_id=? AND status IN ('running','waiting')", cn.hostId, cn.accountId))
        this.c.store.upsertSession({ id: s.id, last_event: 'daemon connection lost' });
      if (had.length) {
        // reconnect and re-attach the threads we were driving
        setTimeout(() => this.conn(cn.hostId, cn.accountId).then(() => Promise.all(had.map((t) => this.subscribe(cn, t)))).catch((e) => L(`${cn.key} reconnect: ${e.message}`)), (cn.backoff = Math.min(cn.backoff * 2, 30000)));
      }
    };
    ws.on('close', closed);
    ws.on('error', (e) => L(`${cn.key} ws: ${e.message}`));
    proc.on('close', () => ws.terminate());
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
      setTimeout(() => rej(new Error('websocket upgrade timeout')), 15000);
    });
    const init = await peer.request('initialize', { clientInfo: CodexAdapter.clientInfo, capabilities: { experimentalApi: false, requestAttestation: false } }, 15000);
    peer.notify('initialized');
    cn.up = true;
    cn.backoff = 1000;
    L(`${cn.key}: initialized (${init.userAgent})`);
    this.importThreads(cn).catch((e) => L(`${cn.key} thread/list: ${e.message}`));
  }

  /** List threads in the daemon's store (cli + vscode sources by default) and show them as sessions. */
  private async importThreads(cn: Conn) {
    const r = await cn.peer!.request('thread/list', { limit: 50, sortKey: 'updated_at' });
    for (const t of r.data || []) this.upsertThread(cn, t);
  }

  private sessionFor(threadId: string): Session | undefined {
    return this.c.store.sessionByNative(threadId);
  }

  private upsertThread(cn: Conn, t: any, extra: Partial<Session> = {}): Session {
    const prev = this.sessionFor(t.id);
    const st = t.status?.type;
    const status = st === 'active' ? (t.status.activeFlags?.includes('waitingOnApproval') ? 'waiting' : 'running') : prev?.status && prev.status !== 'starting' ? prev.status : 'idle';
    const co = this.c.repos.checkoutForPath(cn.hostId, t.cwd);
    return this.c.store.upsertSession({
      id: prev?.id ?? newId('cx-'), vendor: 'codex', kind: 'local', host_id: cn.hostId, account_id: cn.accountId, native_id: t.id, native_url: null,
      cwd: t.cwd, checkout_id: prev?.checkout_id ?? co?.id ?? null, branch: prev?.branch ?? t.gitInfo?.branch ?? co?.branch ?? null,
      title: prev?.title && !prev.title.startsWith('Codex · ') ? prev.title : t.name || t.preview?.slice(0, 60) || `Codex · ${String(t.cwd).split('/').pop()}`,
      model: t.model ?? prev?.model ?? null, effort: t.reasoningEffort ?? prev?.effort ?? null, status: status as any,
      meta: { source: typeof t.source === 'string' ? t.source : 'other', loaded: st !== 'notLoaded' },
      ...extra,
    });
  }

  private async subscribe(cn: Conn, threadId: string) {
    if (cn.subscribed.has(threadId)) return;
    const r = await cn.peer!.request('thread/resume', { threadId });
    cn.subscribed.add(threadId);
    const s = this.upsertThread(cn, r.thread);
    for (const turn of r.thread.turns || []) for (const item of turn.items || []) this.itemToMessage(s.id, item, true);
    const active = (r.thread.turns || []).find((t: any) => t.status === 'inProgress');
    if (active) this.c.store.upsertSession({ id: s.id, meta: { activeTurnId: active.id } });
  }

  // ---------------------------------------------------------------- commands
  async start(o: { hostId: string; accountId: string; cwd: string; checkoutId?: string | null; branch?: string | null; prompt?: string; model?: string; effort?: string }): Promise<Session> {
    const cn = await this.conn(o.hostId, o.accountId);
    const r = await cn.peer!.request('thread/start', { cwd: o.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write', ...(o.model ? { model: o.model } : {}) });
    cn.subscribed.add(r.thread.id);
    const s = this.upsertThread(cn, r.thread, {
      checkout_id: o.checkoutId ?? null, branch: o.branch ?? null, title: o.prompt ? o.prompt.slice(0, 60) : `Codex · ${o.cwd.split('/').pop()}`,
      effort: o.effort ?? r.reasoningEffort ?? null, model: o.model ?? r.model,
      meta: { nativeHint: 'Open this host’s SSH project in the ChatGPT desktop app; the thread is on the shared daemon.' },
    });
    if (o.prompt) await this.send(s.id, o.prompt);
    return this.c.store.session(s.id)!;
  }

  async attach(id: string) {
    const s = this.need(id);
    const cn = await this.conn(s.host_id!, s.account_id);
    await this.subscribe(cn, s.native_id!);
  }

  async send(id: string, text: string) {
    const s = this.need(id);
    const cn = await this.conn(s.host_id!, s.account_id);
    await this.subscribe(cn, s.native_id!);
    const active = s.meta.activeTurnId;
    if (active) {
      try {
        await cn.peer!.request('turn/steer', { threadId: s.native_id, input: textInput(text), expectedTurnId: active });
        return;
      } catch (e: any) {
        L(`${id}: steer failed (${e.message}); starting a turn`);
      }
    }
    const r = await cn.peer!.request('turn/start', {
      threadId: s.native_id, input: textInput(text), ...(s.model ? { model: s.model } : {}), ...(s.effort ? { effort: s.effort } : {}),
    });
    this.c.store.upsertSession({ id, status: 'running', last_event: 'turn started', meta: { activeTurnId: r.turn.id } });
  }

  async interrupt(id: string) {
    const s = this.need(id);
    const turnId = s.meta.activeTurnId;
    if (!turnId) return;
    const cn = await this.conn(s.host_id!, s.account_id);
    // the response is deferred until the turn actually aborts
    await cn.peer!.request('turn/interrupt', { threadId: s.native_id, turnId }, 30000);
  }

  async settings(id: string, o: { model?: string; effort?: string }) {
    const s = this.need(id);
    // model and effort are per-turn overrides in turn/start; they apply from the next turn
    this.c.store.upsertSession({ id, model: o.model ?? s.model, effort: o.effort ?? s.effort });
  }

  async stop(id: string) {
    const s = this.need(id);
    const cn = this.conns.get(`${s.host_id}/${s.account_id}`);
    if (s.meta.activeTurnId) await this.interrupt(id).catch(() => {});
    if (cn?.peer) await cn.peer.request('thread/unsubscribe', { threadId: s.native_id }).catch(() => {});
    cn?.subscribed.delete(s.native_id!);
    this.c.store.setStatus(id, 'ended', 'unsubscribed from hub');
  }

  async decide(approvalId: string, decision: 'allow' | 'deny' | 'allowSession') {
    const a = this.c.store.approval(approvalId);
    if (!a || a.status !== 'pending') return;
    const cn = this.conns.get(a.data.connKey);
    if (!cn?.peer) throw new Error('codex connection is down; the approval will be re-sent on reconnect');
    const d = decision === 'allow' ? 'accept' : decision === 'allowSession' ? 'acceptForSession' : 'decline';
    cn.peer.respond(a.data.requestId, { decision: d });
    this.c.store.upsertApproval({ id: approvalId, status: decision === 'deny' ? 'deny' : 'allow', decided_by: 'hub' });
  }

  async recover() {
    const keys = new Set(this.c.store.sessions("vendor='codex' AND kind='local' AND status NOT IN ('ended')").map((s) => `${s.host_id}\u0000${s.account_id}`));
    for (const k of keys) {
      const [h, a] = k.split('\u0000');
      this.conn(h, a).catch((e) => L(`recover ${h}/${a}: ${e.message}`));
    }
  }

  private need(id: string) {
    const s = this.c.store.session(id);
    if (!s || s.vendor !== 'codex' || s.kind !== 'local') throw new Error(`no local codex session ${id}`);
    return s;
  }

  // ---------------------------------------------------------------- events
  private onServerRequest(cn: Conn, method: string, p: any, id: number | string) {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const s = this.sessionFor(p.threadId);
      if (!s) throw new RpcError(-32603, 'unknown thread');
      const isCmd = method.includes('commandExecution');
      this.c.store.upsertApproval({
        id: `cxa-${cn.key.replace(/\W/g, '')}-${id}-${p.itemId}`, session_id: s.id, source: 'codex', status: 'pending',
        title: isCmd ? `Run: ${p.command ?? '(command)'}` : 'Apply file changes',
        detail: isCmd ? [p.cwd && `cwd ${p.cwd}`, p.reason].filter(Boolean).join(' · ') : p.reason || '',
        data: { connKey: cn.key, requestId: id, method, itemId: p.itemId, command: p.command },
      });
      this.c.store.setStatus(s.id, 'waiting', 'approval requested');
      this.c.push.notify({ title: 'Approval needed', body: `${s.title}: ${p.command ?? 'file changes'}`, tag: `cx-${id}`, url: `/?focus=${s.id}` });
      return PARKED;
    }
    throw new RpcError(-32601, `agent hub does not handle ${method}`);
  }

  private onNotification(cn: Conn, method: string, p: any) {
    switch (method) {
      case 'thread/started':
        // broadcast to every connection: threads started elsewhere (desktop app) appear here
        this.upsertThread(cn, p.thread);
        return;
      case 'thread/status/changed': {
        const s = this.sessionFor(p.threadId);
        if (!s) return;
        const st = p.status?.type;
        const status = st === 'active' ? (p.status.activeFlags?.includes('waitingOnApproval') ? 'waiting' : 'running') : st === 'idle' ? 'idle' : st === 'systemError' ? 'error' : s.status;
        this.c.store.setStatus(s.id, status as any);
        return;
      }
      case 'thread/closed': {
        const s = this.sessionFor(p.threadId);
        cn.subscribed.delete(p.threadId);
        if (s) this.c.store.upsertSession({ id: s.id, meta: { loaded: false } });
        return;
      }
    }
    const s = p?.threadId ? this.sessionFor(p.threadId) : undefined;
    if (!s) return;
    switch (method) {
      case 'turn/started':
        this.c.store.upsertSession({ id: s.id, status: 'running', meta: { activeTurnId: p.turn.id } });
        break;
      case 'turn/completed': {
        const st = p.turn.status;
        this.c.store.upsertSession({ id: s.id, status: 'idle', last_event: `turn ${st}`, meta: { activeTurnId: null } });
        if (st === 'interrupted') this.c.store.upsertMessage({ id: `cx-int-${p.turn.id}`, session_id: s.id, role: 'system', kind: 'status', text: 'Turn interrupted', data: null });
        if (st === 'failed') this.c.store.upsertMessage({ id: `cx-err-${p.turn.id}`, session_id: s.id, role: 'system', kind: 'status', text: `Turn failed: ${p.turn.error?.message ?? ''}`, data: null });
        for (const a of this.c.store.pendingApprovals()) if (a.session_id === s.id && a.source === 'codex') this.c.store.upsertApproval({ id: a.id, status: 'expired' });
        if (s.checkout_id) this.c.repos.refreshCheckout(s.checkout_id).catch(() => {});
        if (st === 'completed') this.c.push.notify({ title: 'Codex turn finished', body: s.title, tag: s.id, url: `/?focus=${s.id}` });
        break;
      }
      case 'item/started':
      case 'item/completed':
        this.itemToMessage(s.id, p.item, method === 'item/completed');
        if (method === 'item/completed' && p.item.type === 'fileChange' && p.item.status === 'completed')
          for (const ch of p.item.changes || []) this.c.apps.onFileWritten(s, ch.path).catch((e) => L(`hot reload: ${e.message}`));
        break;
      case 'item/agentMessage/delta':
        this.c.store.appendDelta(`cxi-${p.itemId}`, s.id, p.delta, { role: 'assistant', kind: 'text' });
        break;
      case 'item/reasoning/summaryTextDelta':
        this.c.store.appendDelta(`cxi-${p.itemId}`, s.id, p.delta, { role: 'assistant', kind: 'reasoning' });
        break;
      case 'item/commandExecution/outputDelta': {
        const m = this.c.db.get('SELECT data, text FROM message WHERE id=?', `cxi-${p.itemId}`);
        const data = m?.data ? JSON.parse(m.data) : {};
        this.c.store.upsertMessage({ id: `cxi-${p.itemId}`, session_id: s.id, role: 'tool', kind: 'command', text: m?.text ?? '', data: { ...data, output: (data.output || '') + p.delta } });
        break;
      }
      case 'serverRequest/resolved':
        // answered by another client (e.g. the desktop app) or aborted: withdraw the prompt here
        for (const a of this.c.store.pendingApprovals())
          if (a.source === 'codex' && a.data.connKey === cn.key && String(a.data.requestId) === String(p.requestId)) this.c.store.upsertApproval({ id: a.id, status: 'expired', decided_by: 'elsewhere' });
        break;
      case 'error':
        if (!p.willRetry) this.c.store.upsertMessage({ id: `cx-e-${Date.now()}`, session_id: s.id, role: 'system', kind: 'status', text: `Error: ${p.error?.message}`, data: null });
        break;
    }
  }

  private itemToMessage(sessionId: string, item: any, final: boolean) {
    const id = `cxi-${item.id}`;
    const put = (m: any) => this.c.store.upsertMessage({ id, session_id: sessionId, data: null, ...m });
    switch (item.type) {
      case 'userMessage':
        put({ role: 'user', kind: 'text', text: (item.content || []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n') });
        break;
      case 'agentMessage':
        if (final || item.text) put({ role: 'assistant', kind: 'text', text: item.text });
        break;
      case 'reasoning':
        if (final && item.summary?.length) put({ role: 'assistant', kind: 'reasoning', text: item.summary.join('\n') });
        break;
      case 'commandExecution': {
        const prev = this.c.db.get('SELECT data FROM message WHERE id=?', id);
        const pd = prev?.data ? JSON.parse(prev.data) : {};
        put({ role: 'tool', kind: 'command', text: item.command, data: { ...pd, status: item.status, exitCode: item.exitCode, output: item.aggregatedOutput ?? pd.output ?? '' } });
        break;
      }
      case 'fileChange':
        put({ role: 'tool', kind: 'tool', text: `edit ${(item.changes || []).map((c: any) => c.path).join(', ')}`, data: { status: item.status, changes: item.changes } });
        break;
      case 'mcpToolCall':
        put({ role: 'tool', kind: 'tool', text: `${item.server}.${item.tool}`, data: { status: item.status, arguments: item.arguments, result: item.result, error: item.error } });
        break;
    }
  }
}
