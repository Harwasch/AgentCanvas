// Agent Hub: one process + SQLite on the always-on host.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadConfig, loadSecrets } from './config.js';
import { Db } from './db.js';
import { EventBus, log } from './events.js';
import { Store, newId } from './store.js';
import { HostManager } from './ssh.js';
import { Bootstrapper } from './bootstrap.js';
import { ClaudeDriver } from './claude/driver.js';
import { CodexDriver } from './codex/driver.js';
import { CloudService } from './cloud.js';
import { RepoIndexer } from './repos.js';
import { AppService } from './apps/service.js';
import { Push } from './push.js';
import { routes } from './api.js';
import { createServer, cookies, bearer, safeEqual, json, hubOrigins, crossOriginReason, type Auth, type Req, type Res } from './http.js';
import { hostForToken } from './tokens.js';
import type { Ctx } from './ctx.js';
import { ProjectService } from './projects.js';
import { FileService } from './files.js';
import { NodeService } from './nodes.js';
import { ComputeService } from './compute.js';
import { HilService } from './hil.js';
import { TerminalService } from './terminal.js';
import { CanvasService } from './canvas.js';

const L = log('hub');
const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function main() {
  const { config: cfg, file } = loadConfig(process.argv[2]);
  const secrets = loadSecrets(cfg.dataDir);
  const db = new Db(cfg.dataDir);
  const bus = new EventBus();
  const store = new Store(db, bus);
  const hosts = new HostManager(cfg, db, bus);
  const c = { bootId: newId('boot-'), cfg, secrets, db, bus, store, hosts } as Ctx;
  c.account = (id: string) => {
    const a = cfg.accounts.find((x) => x.id === id);
    if (!a) throw new Error(`unknown account ${id}`);
    return a;
  };
  for (const a of cfg.accounts) db.upsert('account', { id: a.id, label: a.label || a.id, color: a.color || null, cfg: a });
  c.boot = new Bootstrapper(cfg, secrets, hosts);
  c.push = new Push(c);
  c.repos = new RepoIndexer(c);
  c.claude = new ClaudeDriver(c);
  c.codex = new CodexDriver(c);
  c.cloud = new CloudService(c);
  c.apps = new AppService(c);
  c.projects = new ProjectService(c);
  c.files = new FileService(c);
  c.nodes = new NodeService(c);
  c.compute = new ComputeService(c);
  c.hil = new HilService(c);
  c.terminals = new TerminalService(c);
  c.canvas = new CanvasService(c);
  // a session that ends gives back its device locks (only real ends: a session on an unreachable host is kept, not ended)
  bus.on('event', (ev: any) => {
    if (ev.type === 'session.upsert' && ev.data.status === 'ended') c.compute.releaseAll(ev.data.id);
  });
  // approvals whose waiter lived in the previous process (pending tool calls, held hooks, Codex requests) can never be answered
  const orphaned = store.expireOrphanedApprovals();
  if (orphaned.length) L(`expired ${orphaned.length} approval(s) left pending by the previous run`);

  const authCheck = (auth: Auth, req: Req) => {
    if (auth === 'none') return true;
    const tok = bearer(req) ?? (auth === 'hub' ? cookies(req).hub_token : undefined);
    if (!tok) return false;
    if (auth === 'hub') return safeEqual(tok, secrets.hubToken);
    if (auth === 'hook') {
      // per-host token (HMAC of the hook secret): the request speaks for that host only
      const host = hostForToken(secrets.hookToken, cfg.hosts.map((h) => h.id), tok);
      if (host) req.authHost = host;
      return !!host;
    }
    if (auth === 'cloudHook') return safeEqual(tok, secrets.cloudHookToken);
    if (auth === 'mcp') return safeEqual(tok, secrets.mcpToken);
    return false;
  };
  const router = routes(c);
  const secure = !!cfg.tls || cfg.publicUrl.startsWith('https:');
  const cookie = (t: string) => `hub_token=${encodeURIComponent(t)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`;
  // GET stays for the documented bookmarklet / first-run link; the PWA posts the token instead (no token in URLs or history)
  router.get('/login', 'none', (req, res) => {
    const t = req.query.get('token') || '';
    if (!safeEqual(t, secrets.hubToken)) return json(res, 401, { error: 'bad token' });
    res.writeHead(302, { location: '/', 'set-cookie': cookie(t), 'referrer-policy': 'no-referrer' });
    res.end();
  });
  router.post('/login', 'none', (req: Req, res: Res) => {
    const t = String(req.body?.token || '');
    if (!safeEqual(t, secrets.hubToken)) return json(res, 401, { error: 'bad token' });
    if (/json/.test(String(req.headers['content-type']))) return json(res, 200, { ok: true }, { 'set-cookie': cookie(t) });
    res.writeHead(303, { location: '/', 'set-cookie': cookie(t) });
    res.end();
  }, { form: true });
  router.get('/healthz', 'none', () => ({ ok: true }));

  const staticRoot = path.resolve(HERE, '../../web/dist');
  if (!fs.existsSync(staticRoot)) L(`warning: ${staticRoot} missing; run npm run build`);
  const origins = hubOrigins(cfg);
  const server = createServer({ cfg, router, authCheck, origins, staticRoot });

  // event stream
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', (e) => L(`upgrade socket: ${e.message}`));
    const u = new URL(req.url || '/', 'http://x');
    const tok = cookies(req).hub_token ?? u.searchParams.get('token') ?? '';
    const term = u.pathname.match(/^\/api\/terminals\/([\w-]+)\/ws$/);
    if ((u.pathname !== '/api/events' && !term) || !safeEqual(tok, secrets.hubToken)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    // same-origin only: SameSite=Strict still sends the cookie from same-site origins (other ports, sibling hosts)
    const why = crossOriginReason(req.headers, origins);
    if (why) {
      L(`refused ${u.pathname} upgrade: ${why}`);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    if (term) {
      wss.handleUpgrade(req, socket, head, (ws) => c.terminals.attach(term[1], ws));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const since = Number(u.searchParams.get('since') || 0);
      const boot = u.searchParams.get('boot');
      ws.on('error', (e) => L(`events socket: ${e.message}`));
      // hello first: a client from another hub run (seq restarted) or one that fell out of the replay ring must resync
      const missed = bus.since(since);
      const gap = (!!boot && boot !== c.bootId) || since > bus.seq || (since > 0 && since < bus.seq && (!missed.length || missed[0].seq > since + 1));
      ws.send(JSON.stringify({ seq: 0, type: 'hello', data: { boot: c.bootId, seq: bus.seq, resync: gap }, ts: Date.now() }));
      if (!gap) for (const ev of missed) ws.send(JSON.stringify(ev));
      const on = (ev: any) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(ev));
      bus.on('event', on);
      // keepalive: a text frame the PWA can see (it treats silence as a dead socket) plus a ping; no pong for a round → drop
      let alive = true;
      ws.on('pong', () => (alive = true));
      const ping = setInterval(() => {
        if (ws.readyState !== ws.OPEN) return;
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
        ws.send(JSON.stringify({ seq: 0, type: 'keepalive', data: {}, ts: Date.now() }));
      }, 25000);
      ws.on('close', () => {
        bus.off('event', on);
        clearInterval(ping);
      });
    });
  });

  await new Promise<void>((r) => server.listen(cfg.listen.port, cfg.listen.host, r));
  L(`listening on ${cfg.tls ? 'https' : 'http'}://${cfg.listen.host}:${cfg.listen.port} (public ${cfg.publicUrl}); config ${file}`);
  L(`open ${cfg.publicUrl.replace(/\/$/, '')}/login?token=<hub token from ${path.join(cfg.dataDir, 'secrets.json')}>`);
  L(`canvas MCP for Claude Code / Desktop: ${cfg.publicUrl.replace(/\/$/, '')}/mcp (bearer: mcpToken in ${path.join(cfg.dataDir, 'secrets.json')})`);

  hosts.start();
  // refresh each host's hub.env / channel script on start (tokens are per host)
  for (const h of cfg.hosts) c.boot.ensure(h.id).catch((e) => L(`bootstrap ${h.id}: ${e.message}`));
  c.repos.start();
  c.cloud.start();
  c.apps.start();
  c.projects.start();
  c.compute.start();
  c.nodes.start();
  c.claude.recover(undefined, { startup: true }).catch((e) => L(`claude recover: ${e.message}`));
  c.codex.recover().catch((e) => L(`codex recover: ${e.message}`));
  c.claude.startLiveness();
  // a host that was unreachable is back: reattach its sessions (nothing was ended while it was away)
  hosts.onOnline((h) => {
    c.claude.recover(h).catch((e) => L(`claude recover ${h}: ${e.message}`));
    c.codex.recover(h).catch((e) => L(`codex recover ${h}: ${e.message}`));
  });

  const shutdown = async () => {
    L('shutting down');
    c.repos.stop();
    c.cloud.stop();
    c.projects.stop();
    c.compute.stop();
    c.nodes.stop();
    c.claude.stopLiveness();
    await c.apps.stop();
    hosts.stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return c;
}

process.on('unhandledRejection', (e) => console.error('[hub] unhandled rejection', e));
// a peer that went away mid-write (ssh child, socket) is not fatal; anything else is a bug: log and exit
process.on('uncaughtException', (e: NodeJS.ErrnoException) => {
  if (e?.code === 'EPIPE' || e?.code === 'ECONNRESET' || e?.code === 'ERR_STREAM_DESTROYED') {
    console.error('[hub] ignored', e.code, e.message);
    return;
  }
  console.error('[hub] uncaught exception', e);
  process.exit(1);
});
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
