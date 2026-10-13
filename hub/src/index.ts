// Agent Hub: one process + SQLite on the always-on host.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadConfig, loadSecrets } from './config.js';
import { Db } from './db.js';
import { EventBus, log } from './events.js';
import { Store } from './store.js';
import { HostManager } from './ssh.js';
import { Bootstrapper } from './bootstrap.js';
import { ClaudeDriver } from './claude/driver.js';
import { CodexDriver } from './codex/driver.js';
import { CloudService } from './cloud.js';
import { RepoIndexer } from './repos.js';
import { AppService } from './apps/service.js';
import { Push } from './push.js';
import { routes } from './api.js';
import { createServer, cookies, bearer, safeEqual, json, type Auth, type Req } from './http.js';
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
  const c = { cfg, secrets, db, bus, store, hosts } as Ctx;
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
  // a session that ends gives back its device locks
  bus.on('event', (ev: any) => {
    if (ev.type === 'session.upsert' && ev.data.status === 'ended') c.compute.releaseAll(ev.data.id);
  });

  const authCheck = (auth: Auth, req: Req) => {
    if (auth === 'none') return true;
    const tok = bearer(req) ?? (auth === 'hub' ? cookies(req).hub_token : undefined);
    if (!tok) return false;
    if (auth === 'hub') return safeEqual(tok, secrets.hubToken);
    if (auth === 'hook') return safeEqual(tok, secrets.hookToken);
    if (auth === 'cloudHook') return safeEqual(tok, secrets.cloudHookToken);
    if (auth === 'mcp') return safeEqual(tok, secrets.mcpToken);
    return false;
  };
  const router = routes(c);
  const secure = !!cfg.tls || cfg.publicUrl.startsWith('https:');
  router.get('/login', 'none', (req, res) => {
    const t = req.query.get('token') || '';
    if (!safeEqual(t, secrets.hubToken)) return json(res, 401, { error: 'bad token' });
    res.writeHead(302, { location: '/', 'set-cookie': `hub_token=${encodeURIComponent(t)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}` });
    res.end();
  });
  router.get('/healthz', 'none', () => ({ ok: true }));

  const staticRoot = path.resolve(HERE, '../../web/dist');
  if (!fs.existsSync(staticRoot)) L(`warning: ${staticRoot} missing; run npm run build`);
  const server = createServer({ cfg, router, authCheck, staticRoot });

  // event stream
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url || '/', 'http://x');
    const tok = cookies(req).hub_token ?? u.searchParams.get('token') ?? '';
    const term = u.pathname.match(/^\/api\/terminals\/([\w-]+)\/ws$/);
    if ((u.pathname !== '/api/events' && !term) || !safeEqual(tok, secrets.hubToken)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    // terminals: same-origin only (the cookie is SameSite=Strict; this also refuses cross-site socket hijacking)
    if (term) {
      const origin = req.headers.origin;
      if (origin && origin !== new URL(cfg.publicUrl).origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => c.terminals.attach(term[1], ws));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const since = Number(u.searchParams.get('since') || 0);
      for (const ev of bus.since(since)) ws.send(JSON.stringify(ev));
      const on = (ev: any) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(ev));
      bus.on('event', on);
      const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 25000);
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
  c.repos.start();
  c.cloud.start();
  c.apps.start();
  c.projects.start();
  c.compute.start();
  c.nodes.start();
  c.claude.recover().catch((e) => L(`claude recover: ${e.message}`));
  c.codex.recover().catch((e) => L(`codex recover: ${e.message}`));

  const shutdown = async () => {
    L('shutting down');
    c.repos.stop();
    c.cloud.stop();
    c.projects.stop();
    c.compute.stop();
    c.nodes.stop();
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
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
