// App server runtime: an MCP server started on its host over the SSH channel
// (stdio), spoken to as newline-delimited JSON-RPC.
import type { ChildProcess } from 'node:child_process';
import type { HostManager } from '../ssh.js';
import { q, rpath } from '../ssh.js';
import { JsonRpcPeer, NdjsonDecoder } from '../jsonrpc.js';

export const MCP_APPS_MIME = 'text/html;profile=mcp-app';
export const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/i;

export class AppRuntime {
  proc?: ChildProcess;
  peer?: JsonRpcPeer;
  tools: any[] = [];
  logs: string[] = [];
  status: 'stopped' | 'starting' | 'running' | 'error' = 'stopped';
  lastUse = Date.now();
  private exitHandlers: ((code: number | null) => void)[] = [];

  constructor(private hosts: HostManager, public hostId: string, public dir: string, public command: string[], public env: Record<string, string> = {}) {}

  private log(s: string) {
    for (const line of s.split('\n')) if (line.trim()) this.logs.push(line.slice(0, 500));
    if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
  }

  onExit(f: (code: number | null) => void) {
    this.exitHandlers.push(f);
  }

  async start() {
    const bad = Object.keys(this.env).filter((k) => !ENV_KEY.test(k));
    if (bad.length) {
      this.status = 'error';
      throw new Error(`server.env: invalid variable name ${bad.map((k) => JSON.stringify(k)).join(', ')}`);
    }
    this.status = 'starting';
    const envs = Object.entries(this.env).map(([k, v]) => `${k}=${q(v)}`).join(' ');
    const cmd = `cd ${rpath(this.dir)} && exec ${envs ? 'env ' + envs + ' ' : ''}${this.command.map(q).join(' ')}`;
    const p = this.hosts.spawn(this.hostId, cmd);
    this.proc = p;
    const peer = new JsonRpcPeer((m) => {
      if (!p.stdin?.writable) throw new Error('app server is not running');
      p.stdin.write(JSON.stringify(m) + '\n');
    }, { timeoutMs: 30000 });
    this.peer = peer;
    const dec = new NdjsonDecoder((m) => peer.handle(m), (line, e) => this.log(`[stdout] ${line}${e instanceof SyntaxError ? '' : ` (${e.message})`}`));
    p.stdout!.on('data', (d) => dec.push(d));
    p.stderr!.on('data', (d) => this.log(String(d)));
    p.on('close', (code) => {
      peer.close('app server exited');
      if (this.proc === p) {
        this.status = code === 0 || this.status === 'stopped' ? 'stopped' : 'error';
        this.proc = undefined;
        this.log(`[hub] server exited with code ${code}`);
        this.exitHandlers.forEach((f) => f(code));
      }
    });
    try {
      await peer.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [MCP_APPS_MIME] } } },
        clientInfo: { name: 'agent-hub', version: '0.1.0' },
      }, 20000);
      peer.notify('notifications/initialized');
      const t = await peer.request('tools/list', {});
      this.tools = t.tools || [];
      this.status = 'running';
    } catch (e: any) {
      this.status = 'error';
      this.log(`[hub] start failed: ${e.message}`);
      this.stop();
      throw new Error(`app server failed to start: ${e.message}; last log: ${this.logs.slice(-5).join(' | ')}`);
    }
  }

  async readResource(uri: string): Promise<{ html: string; meta: any }> {
    const r = await this.peer!.request('resources/read', { uri });
    const c = (r.contents || []).find((x: any) => x.uri === uri) || r.contents?.[0];
    if (!c) throw new Error(`resource ${uri} returned no contents`);
    const html = typeof c.text === 'string' ? c.text : c.blob ? Buffer.from(c.blob, 'base64').toString('utf8') : '';
    if (c.mimeType && !String(c.mimeType).startsWith('text/html')) throw new Error(`resource ${uri} has mimeType ${c.mimeType}, expected ${MCP_APPS_MIME}`);
    return { html, meta: c._meta?.ui ?? null };
  }

  async call(name: string, args: any) {
    this.lastUse = Date.now();
    return this.peer!.request('tools/call', { name, arguments: args ?? {} }, 30000);
  }

  stop() {
    const p = this.proc;
    this.status = 'stopped';
    if (p) {
      this.proc = undefined;
      p.stdin?.end();
      p.kill('SIGTERM');
    }
  }
}
