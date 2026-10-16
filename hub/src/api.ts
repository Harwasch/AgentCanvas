// HTTP routes: PWA API, hook intake (local + cloud), hub MCP tool endpoint.
import type { Ctx } from './ctx.js';
import { inStateWhere } from './retention.js';
import { Router, HttpError, json, closeSignal, HELD } from './http.js';
import { parseHook } from './claude/payloads.js';
import { cspHeader } from './apps/manifest.js';
import { AppError } from './apps/service.js';
import type { Caller } from './apps/policy.js';
import { log } from './events.js';
import { routesV2 } from './api2.js';
import { spawnSession, sendToSession } from './nodes.js';
import { layoutEntry, mergeSize, type CanvasCaller } from './canvas.js';
import { sessionCallerReason } from './tokens.js';
import { ReadOnlyError } from './claude/driver.js';

const L = log('api');

export const CANVAS_INSTRUCTIONS =
  'Agent Hub canvas tools. Call canvas_snapshot first to see node ids, positions (canvas units) and the user\'s selection; ' +
  'hub_overview lists hosts, accounts, projects, checkouts and sessions. Arranging, notes, files and to-dos apply live and the user can undo them. ' +
  'hub_* actions (start sessions, message agents, run HIL, create branches, open terminals) wait for the user to confirm in the hub.';

export function routes(c: Ctx): Router {
  const r = new Router();
  const need = (v: any, name: string) => {
    if (v === undefined || v === null || v === '') throw new HttpError(400, `${name} is required`);
    return v;
  };
  const session = (id: string) => {
    const s = c.store.session(id);
    if (!s) throw new HttpError(404, 'unknown session');
    return s;
  };
  /** sessions started outside the hub are shown, not driven, until taken over */
  const readOnly = (s: { meta?: any }) => {
    if (s.meta?.external) throw new HttpError(409, new ReadOnlyError().message);
  };

  // ------------------------------------------------------------- state
  r.get('/api/state', 'hub', () => ({
    seq: c.bus.seq,
    boot: c.bootId,
    hosts: c.cfg.hosts.map((h) => c.hosts.row(h.id)),
    accounts: c.cfg.accounts.map((a) => ({ id: a.id, label: a.label || a.id, color: a.color || '#8A8F98', github: a.gh?.owners || [], cloud: { claudeEnvironments: a.cloud?.claudeEnvironments || [], codexEnvironments: a.cloud?.codexEnvironments || [] } })),
    checkouts: c.db.all('SELECT * FROM checkout ORDER BY host_id, path').map((x) => c.repos.row(x)),
    // ended sessions older than retention.stateEndedDays are left out (GET /api/sessions/archive lists them)
    sessions: c.store.sessions(...inStateWhere(c.cfg.retention)),
    approvals: c.store.pendingApprovals(),
    nodes: c.apps.nodes(),
    usage: c.usage.list(),
    layout: Object.fromEntries(c.db.all('SELECT * FROM layout').map((l) => [l.node_id, layoutEntry(l)])),
    config: { publicUrl: c.cfg.publicUrl, vapidPublicKey: c.push.publicKey },
    projects: c.projects.projects(),
    branches: c.projects.branches(),
    machines: c.compute.listMachines(),
    devices: c.compute.listDevices(),
    cnodes: c.nodes.all(),
    todos: c.nodes.todos(),
    grants: c.compute.grants(),
    hil: { plans: c.hil.plans(), runs: c.hil.runs() },
  }));

  // ------------------------------------------------------------- sessions
  /** ended sessions no longer in /api/state, newest first (?before=<updated_at ms>&limit=) */
  r.get('/api/sessions/archive', 'hub', (req) => {
    const [where, cutoff] = inStateWhere(c.cfg.retention);
    const before = Math.min(Number(req.query.get('before')) || cutoff, cutoff);
    const limit = Math.max(1, Math.min(500, Number(req.query.get('limit')) || 100));
    return c.db
      .all(`SELECT * FROM session WHERE NOT (${where}) AND updated_at < ? ORDER BY updated_at DESC LIMIT ?`, cutoff, before, limit)
      .map((x) => ({ ...x, meta: JSON.parse(x.meta || '{}') }));
  });
  r.post('/api/sessions', 'hub', async (req) => {
    try {
      return await spawnSession(c, req.body || {});
    } catch (e: any) {
      throw new HttpError(/required|unknown/.test(e.message) ? 400 : 500, e.message);
    }
  });
  r.get('/api/sessions/:id/messages', 'hub', async (req) => {
    const s = session(req.params.id);
    if (s.vendor === 'codex' && s.kind === 'local') await c.codex.attach(s.id).catch((e) => L(`attach ${s.id}: ${e.message}`));
    return c.store.messages(s.id);
  });
  r.post('/api/sessions/:id/send', 'hub', async (req) => {
    const s = session(req.params.id);
    const text = need(req.body?.text, 'text');
    readOnly(s);
    if (s.kind === 'cloud' && s.vendor === 'codex') throw new HttpError(409, 'Codex cloud tasks cannot be continued outside ChatGPT; open it there');
    await sendToSession(c, s, text);
    return { ok: true };
  });
  r.post('/api/sessions/:id/interrupt', 'hub', async (req) => {
    const s = session(req.params.id);
    if (s.kind === 'cloud') throw new HttpError(409, 'cloud sessions cannot be interrupted from the hub');
    readOnly(s);
    if (s.vendor === 'claude') await c.claude.interrupt(s.id);
    else await c.codex.interrupt(s.id);
    return { ok: true };
  });
  r.post('/api/sessions/:id/settings', 'hub', async (req) => {
    const s = session(req.params.id);
    if (s.kind === 'cloud') throw new HttpError(409, 'not supported for cloud sessions');
    readOnly(s);
    if (s.vendor === 'claude') await c.claude.settings(s.id, req.body || {});
    else await c.codex.settings(s.id, req.body || {});
    return c.store.session(s.id);
  });
  r.post('/api/sessions/:id/stop', 'hub', async (req) => {
    const s = session(req.params.id);
    if (s.kind === 'cloud') c.store.setStatus(s.id, 'ended', 'hidden in hub');
    else if (s.vendor === 'claude') await c.claude.stop(s.id);
    else await c.codex.stop(s.id);
    return { ok: true };
  });
  // a Claude session started outside the hub (Claude app, terminal): continue it here with `claude --resume`
  r.post('/api/sessions/:id/takeover', 'hub', async (req) => {
    const s = session(req.params.id);
    if (!s.meta?.external) throw new HttpError(409, 'only sessions started outside the hub can be taken over');
    if ((c.hosts.row(s.host_id!) as any)?.status === 'offline') throw new HttpError(409, `${s.host_id} is offline`);
    return await c.claude.takeover(s.id);
  });
  r.post('/api/sessions/:id/refresh', 'hub', async (req) => {
    const s = session(req.params.id);
    if (s.kind === 'cloud' && s.vendor === 'codex') await c.cloud.refreshCodex(s.id);
    if (s.checkout_id) await c.repos.refreshCheckout(s.checkout_id);
    return c.store.session(s.id);
  });

  // ------------------------------------------------------------- approvals
  r.post('/api/approvals/:id', 'hub', async (req) => {
    const a = c.store.approval(req.params.id);
    if (!a) throw new HttpError(404, 'unknown approval');
    if (a.status !== 'pending') throw new HttpError(409, `approval already ${a.status}`);
    const d = req.body?.decision;
    if (!['allow', 'deny', 'allowSession'].includes(d)) throw new HttpError(400, 'decision must be allow|deny|allowSession');
    // an approval whose waiter is gone (the tool call ended, the hub restarted, the connection dropped) would do nothing
    const gone = (why: string): never => {
      c.store.upsertApproval({ id: a.id, status: 'expired' });
      throw new HttpError(409, `no longer waiting: ${why}`);
    };
    const s = c.store.session(a.session_id);
    if (a.source === 'canvas-action' && !c.canvas.waiting(a.id)) gone('the tool call that asked has ended');
    if (a.source === 'app-confirm' && !c.apps.confirmWaiting(a.id)) gone('the app call that asked has ended');
    if (a.source === 'claude-hook' && !c.claude.holding(a.id)) gone('Claude stopped waiting for this answer');
    if (a.source === 'codex' && !c.codex.canDecide(a)) gone('the Codex connection that asked was lost; the daemon re-sends it on reconnect');
    if (a.source === 'claude-channel') {
      if (!s || s.status === 'ended' || s.status === 'error') gone('the session has ended');
      if (!c.claude.channelUp(a.session_id)) throw new HttpError(409, 'channel is not connected; answer in the native app or the terminal');
    }
    if (a.source === 'codex') await c.codex.decide(a.id, d);
    else if (a.source === 'app-confirm') c.apps.decideConfirm(a.id, d === 'deny' ? 'deny' : 'allow');
    else if (a.source === 'canvas-action') c.canvas.decide(a.id, d === 'deny' ? 'deny' : 'allow');
    else await c.claude.decide(a.id, d === 'deny' ? 'deny' : 'allow');
    return c.store.approval(a.id);
  });

  // ------------------------------------------------------------- repos
  r.get('/api/checkouts/:id/files', 'hub', (req) => c.repos.files(req.params.id));
  r.get('/api/checkouts/:id/file', 'hub', (req) => c.repos.file(req.params.id, need(req.query.get('path'), 'path')));
  r.post('/api/checkouts/:id/refresh', 'hub', async (req) => {
    await c.repos.refreshCheckout(req.params.id);
    return c.repos.checkout(req.params.id);
  });

  // ------------------------------------------------------------- apps
  const user: Caller = { kind: 'user', id: 'hub-user', label: 'you' };
  const node = (id: string) => {
    const n = c.apps.row(id);
    if (!n) throw new HttpError(404, 'unknown app node');
    return n;
  };
  r.post('/api/apps/publish', 'hub', async (req) => {
    const b = req.body || {};
    const res = await c.apps.publish({ hostId: need(b.hostId, 'hostId'), dir: need(b.dir, 'dir'), sessionId: b.sessionId ?? null, caller: user });
    if (res.errors.length) throw new HttpError(422, res.errors.join('; '));
    return res.node;
  });
  r.post('/api/apps/:id/call', 'hub', async (req, res) => {
    node(req.params.id);
    const b = req.body || {};
    const out = await c.apps.call(req.params.id, need(b.tool, 'tool'), b.arguments ?? {}, user, !!b.confirmed);
    if (!out.ok) return json(res, 409, { code: out.code, reason: out.reason });
    return out.result;
  });
  r.post('/api/apps/:id/resource', 'hub', async (req) => {
    node(req.params.id);
    return c.apps.resource(req.params.id, need(req.body?.uri, 'uri'));
  });
  r.get('/api/apps/:id/review', 'hub', (req) => {
    node(req.params.id);
    return c.apps.review(req.params.id);
  });
  r.post('/api/apps/:id/promote', 'hub', async (req) => {
    node(req.params.id);
    try {
      const b = req.body || {};
      return await c.apps.promote(req.params.id, { commit: need(b.commit, 'commit'), grantActuate: !!b.grantActuate, commitDirty: !!b.commitDirty, reviewHash: b.reviewHash });
    } catch (e: any) {
      throw new HttpError(409, e.message);
    }
  });
  r.post('/api/apps/:id/reload', 'hub', async (req) => {
    node(req.params.id);
    const out = await c.apps.reload(req.params.id);
    if (out.errors.length) throw new HttpError(422, out.errors.join('; '));
    return out.node;
  });
  r.del('/api/apps/:id', 'hub', (req) => {
    node(req.params.id);
    c.apps.unpublish(req.params.id);
    return { ok: true };
  });
  r.get('/api/apps/:id/ui', 'hub', (req, res) => {
    const u = c.apps.ui(req.params.id);
    if (!u) throw new HttpError(404, 'no UI yet');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // CSP sandbox: even opened top-level, the app document gets an opaque origin, never the hub's
      'content-security-policy': `${cspHeader(u.manifest.csp)}; sandbox allow-scripts allow-forms`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'SAMEORIGIN',
    });
    res.end(u.html);
  });
  // ui/message from an app view: promoted apps only (the PWA asks you first), labelled as coming from the app
  r.post('/api/apps/:id/message', 'hub', async (req) => {
    const n = node(req.params.id);
    if (n.state !== 'promoted') throw new HttpError(409, 'preview apps cannot message their agent; promote the app first');
    const s = n.session_id ? c.store.session(n.session_id) : undefined;
    if (!s) throw new HttpError(409, 'the app has no agent session');
    const text = String(need(req.body?.text, 'text')).slice(0, 8000);
    await sendToSession(c, s, `[message from app "${n.title}" (${n.id}), sent with the user's approval]\n${text}`);
    return { ok: true };
  });
  r.get('/api/apps/:id/thumbnail.png', 'hub', (req, res) => {
    const png = c.apps.thumbnail(req.params.id);
    if (!png) throw new HttpError(404, 'no thumbnail');
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
    res.end(png);
  });
  r.get('/api/audit', 'hub', (req) => {
    const n = req.query.get('node');
    const rows = n ? c.db.all('SELECT * FROM audit WHERE app_node_id=? ORDER BY id DESC LIMIT 500', n) : c.db.all('SELECT * FROM audit ORDER BY id DESC LIMIT 500');
    return rows.map((a) => ({ ...a, allowed: !!a.allowed, args: JSON.parse(a.args || '{}') }));
  });

  // ------------------------------------------------------------- layout, push
  r.post('/api/layout', 'hub', (req) => {
    const b = req.body || {};
    const row: Record<string, unknown> = { node_id: need(b.nodeId, 'nodeId'), x: Number(b.x) || 0, y: Number(b.y) || 0, w: b.w ?? null, h: b.h ?? null, collapsed: b.collapsed ? 1 : 0 };
    if (b.size !== undefined) {
      // user-resized sizes merge per state (c = collapsed, x = expanded); null clears one
      const prev = c.db.get('SELECT sz FROM layout WHERE node_id=?', row.node_id);
      row.sz = JSON.stringify(mergeSize(prev?.sz ? JSON.parse(prev.sz) : {}, b.size));
    }
    c.db.upsert('layout', row, 'node_id');
    const saved = c.db.get('SELECT * FROM layout WHERE node_id=?', row.node_id)!;
    c.bus.publish('layout.upsert', { nodeId: saved.node_id, ...layoutEntry(saved) });
    return { ok: true };
  });
  r.get('/api/push/vapid', 'hub', () => ({ publicKey: c.push.publicKey }));
  r.post('/api/push/subscribe', 'hub', (req) => {
    c.push.subscribe(req.body?.subscription);
    return { ok: true };
  });
  r.post('/api/push/test', 'hub', () => {
    c.push.notify({ title: 'Agent Hub', body: 'Test notification', url: '/' });
    return { ok: true, subscribers: c.db.get('SELECT COUNT(*) n FROM push_sub')?.n };
  });
  r.get('/api/push/log', 'hub', () => c.push.sent);

  // ------------------------------------------------------------- hooks
  r.post('/hooks/claude', 'hook', (req, res) => {
    const p = parseHook(req.body);
    if (!p.ok) return json(res, 400, { error: p.error });
    // a host token only speaks for sessions on that host, and a session launched with a secret must send it
    const hs = c.store.sessionByNative(p.hook.sessionId);
    const why = hs && sessionCallerReason(c.secrets.hookToken, req.authHost, hs, req.headers['x-hub-session-token']);
    if (why) {
      L(`hook ${p.hook.event} refused: ${why}`);
      return json(res, 403, { error: why });
    }
    if (c.claude.onHook(p.hook, res) === HELD) return HELD;
    return json(res, 200, {});
  });
  r.post('/hooks/cloud', 'cloudHook', (req, res) => {
    const p = parseHook(req.body);
    if (!p.ok) return json(res, 400, { error: p.error });
    c.cloud.onCloudHook(p.hook);
    return json(res, 200, {});
  });

  // ------------------------------------------------------------- hub MCP tools (from hosts)
  r.post('/api/mcp/tools/:tool', 'hook', async (req, res) => {
    // a confirm-tier call waits for you; if hub_channel.py gives up (its 180 s timeout) the approval expires with it
    const signal = closeSignal(res);
    const args = req.body?.arguments || {};
    const ctx = req.body?.context || {};
    const tool = req.params.tool;
    const text = (t: string) => ({ type: 'text', text: t });
    const err = (t: string) => ({ isError: true, content: [text(t)] });
    // the host comes from the token, never the body
    const hostId = req.authHost!;
    if (ctx.hostId && ctx.hostId !== hostId) throw new HttpError(403, `token is for ${hostId}, not ${ctx.hostId}`);
    // resolve the calling session: Claude passes HUB_SESSION_ID + its HUB_SESSION_TOKEN; Codex calls are matched by host + cwd
    let s = ctx.hubSessionId ? c.store.session(String(ctx.hubSessionId)) : undefined;
    if (ctx.hubSessionId) {
      if (!s) throw new HttpError(403, `unknown session ${ctx.hubSessionId}`);
      const why = sessionCallerReason(c.secrets.hookToken, hostId, s, ctx.hubSessionToken);
      if (why) {
        L(`tool ${tool} refused: ${why}`);
        throw new HttpError(403, why);
      }
    } else {
      // host-level identity (Codex passes no session id): only Codex sessions on the token's host
      const cands = c.store.sessions("host_id=? AND kind='local' AND status!='ended' AND vendor='codex'", hostId);
      s = cands.filter((x) => x.cwd && ctx.cwd && (ctx.cwd === x.cwd || ctx.cwd.startsWith(x.cwd + '/'))).sort((a, b) => b.updated_at - a.updated_at)[0] ?? cands.sort((a, b) => b.updated_at - a.updated_at)[0];
    }
    const agent: Caller = { kind: 'agent', id: s?.id ?? 'unknown', label: s ? `${s.vendor} ${s.title}` : `agent on ${hostId}` };
    const assistant = s?.meta?.role === 'assistant';
    if (c.canvas.has(tool)) {
      const caller: CanvasCaller = { kind: assistant ? 'assistant' : 'agent', sessionId: s?.id ?? null, label: assistant ? 'Claude' : s ? `${s.vendor} · ${s.title}` : `agent on ${hostId}` };
      return c.canvas.call(tool, args, caller, signal);
    }
    // the canvas assistant never drives hardware or apps directly: those go through the confirm-tier hub_* tools
    if (assistant && ['app_call', 'acquire_device', 'run_on_host', 'run_hil', 'request_compute'].includes(tool))
      return err(`${tool} is not available to the canvas assistant${tool === 'run_hil' ? '; use hub_run_hil (the user confirms it)' : ''}`);
    try {
      switch (tool) {
        case 'publish_app': {
          const p = String(need(args.path, 'path'));
          const base = s?.cwd ?? ctx.cwd;
          const dir = p.startsWith('/') ? p : `${base}/${p}`.replace(/\/\.\//g, '/');
          c.apps.cancelPending(hostId, dir);
          const out = await c.apps.publish({ hostId, dir, sessionId: s?.id ?? null, title: args.title, caller: agent });
          if (out.errors.length) return err(`publish_app refused:\n- ${out.errors.join('\n- ')}${out.warnings.length ? `\nwarnings:\n- ${out.warnings.join('\n- ')}` : ''}`);
          const n = out.node;
          const lines = [
            `node ${n.id} (${n.manifest.id} v${n.version}) published · tier: ${n.state === 'promoted' ? 'actuate (pinned)' : 'read-only (preview)'}`,
            `preview: ${c.cfg.publicUrl.replace(/\/$/, '')}/?focus=${n.id}`,
            `server: ${n.status}`,
            out.warnings.length ? `warnings:\n- ${out.warnings.join('\n- ')}` : 'warnings: none',
            out.consoleErrors.length ? `console errors:\n- ${out.consoleErrors.join('\n- ')}` : 'console errors: none',
            out.serverLog.length ? `server log (tail):\n${out.serverLog.slice(-5).join('\n')}` : '',
            n.previewOf ? `note: ${n.previewOf} is promoted; this is a new preview version beside the pinned one. Promotion and actuate grants happen only in the hub, by the user.` : 'Promotion and actuate grants happen only in the hub, by the user.',
          ].filter(Boolean);
          const content: any[] = [text(lines.join('\n'))];
          if (out.screenshot) content.push({ type: 'image', data: out.screenshot.toString('base64'), mimeType: 'image/png' });
          return { content, structuredContent: { nodeId: n.id, previewUrl: `${c.cfg.publicUrl}/?focus=${n.id}`, tier: n.state === 'promoted' ? 'actuate' : 'read', errors: [], consoleErrors: out.consoleErrors, warnings: out.warnings } };
        }
        case 'app_status': {
          const n = c.apps.resolve(String(need(args.id, 'id')), s?.id);
          const st = c.apps.status(n.id);
          return { content: [text(JSON.stringify(st, null, 2))], structuredContent: st };
        }
        case 'screenshot_app': {
          const n = c.apps.resolve(String(need(args.id, 'id')), s?.id);
          const size = args.width && args.height ? { width: Number(args.width), height: Number(args.height) } : undefined;
          const shot = await c.apps.screenshot(n.id, size);
          return { content: [{ type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' }, text(shot.consoleErrors.length ? `console errors:\n- ${shot.consoleErrors.join('\n- ')}` : 'no console errors')] };
        }
        case 'unpublish_app': {
          const n = c.apps.resolve(String(need(args.id, 'id')), s?.id);
          if (n.state === 'promoted') return err('promoted apps can only be removed by the user in the hub');
          c.apps.unpublish(n.id);
          return { content: [text(`removed ${n.id} and stopped its server`)] };
        }
        case 'app_call': {
          const n = c.apps.resolve(String(need(args.id, 'id')), s?.id);
          const out = await c.apps.call(n.id, String(need(args.tool, 'tool')), args.arguments ?? {}, agent, false, signal);
          if (!out.ok) return err(`blocked by hub (${out.code}): ${out.reason}`);
          return out.result;
        }
        // ---- v2 agent tools: canvas nodes, devices, compute, HIL
        case 'request_review':
        case 'suggest_followup':
        case 'add_todo':
        case 'acquire_device':
        case 'release_device':
        case 'request_compute':
        case 'run_on_host':
        case 'run_hil': {
          if (!s) return err(`${tool} needs a session started from the hub (could not tell which session is calling)`);
          if (tool === 'request_review') {
            const n = await c.nodes.requestReview(s, { path: String(need(args.path, 'path')), title: args.title, note: args.note, promote_to: args.promote_to, checklist: Array.isArray(args.checklist) ? args.checklist : [], kind: args.kind });
            return { content: [text(`review requested: node ${n.id} for ${n.data.path} @ ${String(n.data.sha).slice(0, 8)}. The user's decision (approve / request changes) will arrive as a message in this session.`)], structuredContent: { nodeId: n.id } };
          }
          if (tool === 'suggest_followup') {
            const n = c.nodes.suggest(s, { title: String(need(args.title, 'title')), prompt: String(args.prompt || args.title), rationale: args.rationale, vendor: args.vendor, host: args.host, account: args.account });
            return { content: [text(`suggestion ${n.id} placed on the canvas; the user can launch it as a new session`)], structuredContent: { nodeId: n.id } };
          }
          if (tool === 'add_todo') {
            const n = c.nodes.agentTodo(s, String(need(args.text, 'text')), args.project);
            return { content: [text(`to-do added (${n.data.todoId})`)], structuredContent: { todoId: n.data.todoId } };
          }
          if (tool === 'acquire_device' || tool === 'release_device') {
            const dev = c.compute.resolveDevice(String(need(args.id, 'id')), s.host_id);
            if (tool === 'acquire_device') {
              const lock = c.compute.setLock(dev, s.id);
              return { content: [text(`locked ${c.compute.device(dev)?.title ?? dev} for this session; release it when done`)], structuredContent: { device: dev, lock } };
            }
            const cur = c.compute.lockOf(dev);
            if (cur && cur.sessionId !== s.id) return err(`you do not hold the lock on ${dev}`);
            c.compute.setLock(dev, null);
            return { content: [text(`released ${dev}`)] };
          }
          if (tool === 'request_compute') {
            const g = c.compute.createGrant({ sessionId: s.id, hostId: String(need(args.host, 'host')), resources: String(args.resources || 'shell'), purpose: String(args.purpose || ''), quotaGB: args.quota_gb ?? null, status: 'requested' });
            return { content: [text(`grant ${g.id} requested on ${g.hostId}; it becomes usable with run_on_host once the user approves it in the hub`)], structuredContent: { grantId: g.id, status: g.status } };
          }
          if (tool === 'run_on_host') {
            const out = await c.compute.runOnHost(s.id, String(need(args.grant_id, 'grant_id')), String(need(args.command, 'command')), args.cwd);
            return { content: [text(`exit ${out.exitCode}\n${out.output}`)], isError: out.exitCode !== 0, structuredContent: out };
          }
          const plan = c.hil.plans().find((p) => p.id === args.plan || p.id === `${s.host_id}:${args.plan}`);
          if (!plan) return err(`unknown HIL plan ${args.plan}; plans: ${c.hil.plans().map((p) => p.id).join(', ') || 'none'}`);
          const run = await c.hil.start(plan.id, s.id, Array.isArray(args.only) ? args.only : null);
          return { content: [text(`HIL run ${run.id} started on ${plan.hostId} (${plan.title}); results will arrive as a message in this session`)], structuredContent: { runId: run.id } };
        }
        case 'list_devices': {
          const devs = c.compute.listDevices().filter((d) => !s?.host_id || d.hostId === s.host_id || args.all);
          const plans = c.hil.plans();
          return { content: [text(JSON.stringify({ devices: devs.map((d) => ({ id: d.id, title: d.title, kind: d.kind, status: d.status, lock: d.lock })), hilPlans: plans.map((p) => ({ id: p.id, title: p.title, devices: p.devices })) }, null, 2))] };
        }
        default:
          throw new HttpError(404, `unknown hub tool ${tool}`);
      }
    } catch (e: any) {
      if (e instanceof HttpError && e.status === 404) throw e;
      return err(e instanceof AppError ? e.errors.join('; ') : String(e.message || e));
    }
  });

  // ------------------------------------------------------------- canvas tools, Ask Claude, external MCP
  r.get('/api/mcp/tools', 'hook', () => ({ tools: c.canvas.tools() }));
  r.post('/api/canvas/view', 'hub', (req) => {
    c.canvas.report(String(req.body?.clientId || 'default'), req.body || {});
    return { ok: true };
  });
  r.get('/api/canvas/batches', 'hub', () => c.canvas.batchesList());
  r.post('/api/usage/refresh', 'hub', async () => { await c.usage.refresh(); return c.usage.list(); });
  // your own edits: Delete / Backspace on the selection, and many positions at once (freeze on first drag, Tidy)
  r.post('/api/canvas/remove', 'hub', (req) => c.canvas.userRemove(Array.isArray(req.body?.ids) ? req.body.ids : [], !!req.body?.stop));
  r.post('/api/layout/bulk', 'hub', (req) => c.canvas.bulkLayout(req.body?.entries || [], { undoable: !!req.body?.undoable, label: req.body?.label ? String(req.body.label).slice(0, 80) : undefined }));
  r.post('/api/sessions/:id/visibility', 'hub', (req) => {
    const s = session(req.params.id);
    return c.store.upsertSession({ id: s.id, meta: { hidden: !!req.body?.hidden } });
  });
  r.post('/api/canvas/undo/:id', 'hub', (req) => {
    try {
      return c.canvas.undo(req.params.id);
    } catch (e: any) {
      throw new HttpError(/unknown/.test(e.message) ? 404 : 409, e.message);
    }
  });
  r.post('/api/assistant/start', 'hub', async (req) => {
    const hostId = need(req.body?.hostId, 'hostId');
    const accountId = need(req.body?.accountId, 'accountId');
    try {
      c.account(accountId);
      c.hosts.host(hostId);
      const info = await c.boot.ensure(hostId);
      return await c.claude.start({ hostId, accountId, cwd: info.home, title: 'Canvas assistant', role: 'assistant', prompt: req.body?.prompt ? String(req.body.prompt) : undefined });
    } catch (e: any) {
      throw new HttpError(/unknown|required/i.test(e.message) ? 400 : 500, e.message);
    }
  });
  // Streamable-HTTP MCP endpoint for Claude Code / Claude Desktop on your own machines (bearer: the MCP token)
  r.post('/mcp', 'mcp', async (req, res) => {
    const m = req.body || {};
    const reply = (result: any) => json(res, 200, { jsonrpc: '2.0', id: m.id, result });
    const fail = (code: number, message: string) => json(res, 200, { jsonrpc: '2.0', id: m.id ?? null, error: { code, message } });
    if (Array.isArray(m)) return fail(-32600, 'batches are not supported');
    if (m.id === undefined || m.id === null) { res.writeHead(202); res.end(); return; } // notifications
    switch (m.method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-hub', version: '0.2.0' },
          instructions: CANVAS_INSTRUCTIONS,
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: c.canvas.tools() });
      case 'tools/call': {
        const name = String(m.params?.name || '');
        if (!c.canvas.has(name)) return fail(-32602, `unknown tool ${name}`);
        const who = String(req.headers['x-hub-client'] || 'Claude (external)').slice(0, 40);
        return reply(await c.canvas.call(name, m.params?.arguments || {}, { kind: 'external', sessionId: null, label: who }, closeSignal(res)));
      }
      default:
        return fail(-32601, `method not found: ${m.method}`);
    }
  });
  r.get('/mcp', 'mcp', (_req, res) => { res.writeHead(405, { allow: 'POST' }); res.end(); });

  routesV2(c, r);
  return r;
}

