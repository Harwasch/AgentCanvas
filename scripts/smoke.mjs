#!/usr/bin/env node
// Smoke test against the stubs: run after `npm run build` and `sudo bash scripts/setup-test-env.sh`.
//   node scripts/smoke.mjs            (resets the test env, starts the hub, drives the PWA)
// Exits non-zero on the first failed check. Screenshots land in docs/screenshots/.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/hub.config.json'), 'utf8'));
const BASE = CFG.publicUrl.replace(/\/$/, '');
const SHOTS = path.join(ROOT, 'docs/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const LOG = path.join(CFG.dataDir, 'smoke-hub.log');
const results = [];
const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);

async function check(name, fn) {
  const s = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - s, detail });
    say(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - s, detail: e.message });
    await page?.screenshot({ path: path.join(CFG.dataDir, 'smoke-failure.png') }).catch(() => {});
    say(`✗ ${name} — ${e.message}`);
    throw e;
  }
}
async function until(fn, what, timeoutMs = 30000, every = 300) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timeout waiting for ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

// ------------------------------------------------------------------ env + hub
say('setting up test env (idempotent) and resetting state');
execFileSync('bash', [path.join(ROOT, 'scripts/setup-test-env.sh')], { stdio: 'inherit' });
execFileSync('bash', [path.join(ROOT, 'scripts/reset-test-env.sh')], { stdio: 'inherit' });
const hubOut = fs.openSync(LOG, 'w');
const hub = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'hub/dist/index.js'), path.join(ROOT, 'config/hub.config.json')], {
  stdio: ['ignore', hubOut, hubOut],
  env: { ...process.env, NODE_EXTRA_CA_CERTS: CFG.tls?.ca || '' },
});
process.on('exit', () => hub.kill());
const secrets = () => JSON.parse(fs.readFileSync(path.join(CFG.dataDir, 'secrets.json'), 'utf8'));
const agent = new https.Agent({ rejectUnauthorized: false });
async function api(method, p, body) {
  const r = await fetchish(method, BASE + p, body, { authorization: `Bearer ${secrets().hubToken}` });
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status} ${r.text.slice(0, 200)}`);
  return r.text ? JSON.parse(r.text) : null;
}
function fetchish(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = https.request(url, { method, agent, headers: { ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    req.on('error', reject);
    req.end(data);
  });
}
await until(async () => (await fetchish('GET', `${BASE}/healthz`)).status === 200, 'hub /healthz', 20000);
say(`hub up (log: ${LOG})`);

// cloud environment secret for the stub clouds (the user sets this in claude.ai's environment settings)
for (const a of CFG.accounts) {
  const d = path.join(a.hub.claudeConfigDir, 'stub-cloud');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'environments.json'), JSON.stringify({ Default: { HUB_CLOUD_HOOK_TOKEN: secrets().cloudHookToken, NODE_EXTRA_CA_CERTS: CFG.tls?.ca || '' } }));
}

// fake web-push service: proves the hub sends VAPID-signed, encrypted pushes on approvals
const pushes = [];
const pushSrv = https.createServer({ cert: fs.readFileSync(CFG.tls.cert), key: fs.readFileSync(CFG.tls.key) }, (req, res) => {
  let n = 0;
  req.on('data', (d) => (n += d.length));
  req.on('end', () => {
    pushes.push({ path: req.url, auth: req.headers.authorization || '', encoding: req.headers['content-encoding'], bytes: n });
    res.writeHead(201);
    res.end();
  });
});
await new Promise((r) => pushSrv.listen(8444, '127.0.0.1', r));
const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
await api('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://localhost:8444/push/smoke', keys: { p256dh: ecdh.getPublicKey('base64url'), auth: crypto.randomBytes(16).toString('base64url') } } });

// ------------------------------------------------------------------ browser
// a self-signed cert blocks service-worker registration unless the browser trusts it (production: tailscale serve)
const browser = await chromium.launch({ executablePath: CFG.screenshot.chromiumPath || undefined, args: ['--no-sandbox', '--ignore-certificate-errors'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.message));
const T = (id) => page.locator(`[data-testid="${id}"]`);
const sessionNode = (id) => page.locator(`[data-testid="session-node"][data-session-id="${id}"]`);
const state = () => api('GET', '/api/state');

try {
  await check('PWA loads over HTTPS (login, manifest, service worker)', async () => {
    const r = await page.goto(`${BASE}/login?token=${encodeURIComponent(secrets().hubToken)}`);
    if (!page.url().startsWith('https://')) throw new Error('not https');
    if (r.status() >= 400) throw new Error(`status ${r.status()}`);
    await T('tab-canvas').waitFor({ timeout: 15000 });
    const manifest = await page.evaluate(async () => {
      const l = document.querySelector('link[rel="manifest"]');
      return l ? (await fetch(l.href)).json() : null;
    });
    if (!manifest?.name) throw new Error('no web app manifest');
    const sw = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.active?.scriptURL));
    if (!sw?.endsWith('/sw.js')) throw new Error(`service worker not active (${sw})`);
    return `manifest "${manifest.name}", SW ${new URL(sw).pathname}`;
  });

  await check('hosts online and repos indexed', async () => {
    const s = await until(async () => {
      const s = await state();
      return s.hosts.every((h) => h.status === 'online') && s.checkouts.length >= 2 && s;
    }, 'hosts + checkouts', 30000);
    return s.checkouts.map((c) => `${c.host_id}:${c.repoName}@${c.branch}`).join(', ');
  });

  // ---------------------------------------------------------------- spawn 4 local sessions from the dialog
  async function spawnFromDialog({ vendor, where, account = 'personal', checkout, prompt, env, attempts }) {
    const before = new Set((await state()).sessions.map((s) => s.id));
    await T('add-button').click();
    await T('spawn-vendor').selectOption(vendor);
    await T('spawn-where').selectOption(where);
    await T('spawn-account').selectOption(account);
    if (checkout) await T('spawn-checkout').selectOption(checkout);
    if (env) await T('spawn-env').selectOption(env);
    if (attempts) await T('spawn-attempts').selectOption(String(attempts)).catch(() => T('spawn-attempts').fill(String(attempts)));
    await T('spawn-prompt').fill(prompt);
    await T('spawn-submit').click();
    const s = await until(async () => (await state()).sessions.find((x) => !before.has(x.id)), `new ${vendor} session`, 60000);
    return s;
  }
  const co1 = 'mini-1:/home/hosta/code/hexapod-robot';
  const co2 = 'mini-2:/home/hostb/code/wpt-charger';
  const S = {};
  await check('start Codex thread + Claude session on each host from the hub', async () => {
    S.cx1 = await spawnFromDialog({ vendor: 'codex', where: 'mini-1', checkout: co1, prompt: 'Summarize the winch firmware layout' });
    S.cc1 = await spawnFromDialog({ vendor: 'claude', where: 'mini-1', checkout: co1, prompt: 'Hello from the hub on mini-1' });
    S.cx2 = await spawnFromDialog({ vendor: 'codex', where: 'mini-2', account: 'work', checkout: co2, prompt: 'Explain the coil sweep script' });
    S.cc2 = await spawnFromDialog({ vendor: 'claude', where: 'mini-2', account: 'work', checkout: co2, prompt: 'Hello from the hub on mini-2' });
    for (const k of ['cx1', 'cc1', 'cx2', 'cc2']) {
      const id = S[k].id;
      await until(async () => (await api('GET', `/api/sessions/${id}/messages`)).some((m) => m.role === 'assistant' && m.kind === 'text' && m.text), `${k}: assistant reply to the first prompt`, 45000);
      await until(async () => (await state()).sessions.find((s) => s.id === id && s.status === 'idle'), `${k} idle after first turn`, 20000);
    }
    const s = await state();
    const cc = s.sessions.filter((x) => [S.cc1.id, S.cc2.id].includes(x.id));
    if (!cc.every((x) => x.native_url?.startsWith('https://claude.ai/code/session_'))) throw new Error('Claude sessions missing Remote Control URL');
    if (!cc.every((x) => x.meta.channel === 'connected')) throw new Error('Claude channel not connected');
    return `codex ${S.cx1.native_id.slice(0, 8)}…/${S.cx2.native_id.slice(0, 8)}…, claude ${cc.map((x) => x.native_url.split('/').pop().slice(0, 14)).join(', ')}`;
  });
  await page.screenshot({ path: path.join(SHOTS, 'desktop-canvas-sessions.png') });

  // the canvas is transform-based: focus a node the way a user does (Sessions tab → row pans + expands it)
  async function openNode(id) {
    await T('tab-sessions').click();
    await page.locator(`[data-testid="session-row"][data-session-id="${id}"]`).click();
    const n = sessionNode(id);
    await n.locator('[data-testid="chat-input"]').waitFor({ timeout: 10000 });
    await page.waitForTimeout(400); // pan animation
    return n;
  }
  async function chat(id, text) {
    const n = await openNode(id);
    await n.locator('[data-testid="chat-input"]').fill(text);
    await n.locator('[data-testid="chat-send"]').click();
    return n;
  }

  await check('chat from the canvas (Claude mini-1 and Codex mini-2)', async () => {
    let n = await chat(S.cc1.id, 'What branch are we on?');
    await n.locator('[data-testid="msg"][data-role="assistant"]', { hasText: 'What branch are we on?' }).first().waitFor({ timeout: 20000 });
    n = await chat(S.cx2.id, 'Name the coil parameters');
    await n.locator('[data-testid="msg"][data-role="assistant"]', { hasText: 'Name the coil parameters' }).first().waitFor({ timeout: 20000 });
    return 'replies rendered in both nodes';
  });

  await check('approve one tool call (Codex command approval, mini-1)', async () => {
    const n = await chat(S.cx1.id, 'run the tests');
    await n.locator('[data-testid="approval-allow"]').first().waitFor({ timeout: 20000 });
    await n.locator('[data-testid="approval-allow"]').first().click();
    await n.locator('[data-testid="msg"][data-role="assistant"]', { hasText: '2 passed' }).first().waitFor({ timeout: 20000 });
    return 'npm test approved in the hub → ran on the daemon';
  });

  await check('approve one tool call (Claude via channel permission relay, mini-2)', async () => {
    const n = await chat(S.cc2.id, 'run the test suite');
    await n.locator('[data-testid="approval-allow"]').first().waitFor({ timeout: 20000 });
    await n.locator('[data-testid="approval-allow"]').first().click();
    await n.locator('[data-testid="msg"][data-role="assistant"]', { hasText: 'Tests pass' }).first().waitFor({ timeout: 20000 });
    return 'Bash permission answered through claude/channel/permission';
  });

  await check('interrupt one turn (Claude mini-2 and Codex mini-1)', async () => {
    let n = await chat(S.cc2.id, 'write a long essay about winches');
    await n.locator('[data-testid="msg"][data-role="assistant"]', { hasText: 'step 2 of 15' }).first().waitFor({ timeout: 20000 });
    await n.locator('[data-testid="chat-interrupt"]').click();
    await n.locator('[data-testid="msg"]', { hasText: 'interrupted' }).first().waitFor({ timeout: 15000 });
    n = await chat(S.cx1.id, 'write a slow long answer');
    await until(async () => (await state()).sessions.find((s) => s.id === S.cx1.id && s.status === 'running'), 'codex running', 10000);
    await sleep(1500);
    await n.locator('[data-testid="chat-interrupt"]').click();
    await n.locator('[data-testid="msg"]', { hasText: 'Turn interrupted' }).first().waitFor({ timeout: 15000 });
    return 'Escape via tmux (Claude), turn/interrupt (Codex)';
  });

  await check('repo panel shows branch, HEAD and dirty state', async () => {
    await T('tab-repos').click();
    await page.locator('text=hexapod-robot').first().click();
    await T('repo-branch').waitFor({ timeout: 10000 });
    const [branch, head, dirty] = await Promise.all(['repo-branch', 'repo-head', 'repo-dirty'].map((x) => T(x).innerText()));
    const co = (await state()).checkouts.find((c) => c.id === co1);
    if (!branch.includes(co.branch)) throw new Error(`branch "${branch}" ≠ ${co.branch}`);
    if (!head.includes(co.head.slice(0, 7))) throw new Error(`head "${head}" lacks ${co.head.slice(0, 7)}`);
    if (!dirty.match(/\d+\s*dirty|clean/i) || (co.dirty > 0 && !dirty.includes(String(co.dirty)))) throw new Error(`dirty "${dirty}" vs ${co.dirty}`);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-repo-panel.png') });
    await T('tab-canvas').click();
    return `${branch.trim()} · ${head.trim()} · ${dirty.trim()}`;
  });

  await check('spawn Claude cloud session + Codex cloud task; status on canvas', async () => {
    S.ccc = await spawnFromDialog({ vendor: 'claude', where: 'cloud', checkout: co1, prompt: 'Tidy the README for the winch rig' });
    S.cxc = await spawnFromDialog({ vendor: 'codex', where: 'cloud', checkout: co1, env: 'env_hexapod', attempts: 2, prompt: 'Add CAN fixture tests' });
    await until(async () => (await state()).sessions.find((s) => s.id === S.ccc.id && s.status === 'idle'), 'claude cloud turn finished via hooks', 30000);
    await until(async () => (await state()).sessions.find((s) => s.id === S.cxc.id && s.status === 'ready'), 'codex cloud task ready via polling', 30000);
    await sessionNode(S.ccc.id).waitFor({ timeout: 5000 });
    await sessionNode(S.cxc.id).waitFor({ timeout: 5000 });
    await until(async () => (await sessionNode(S.cxc.id).getAttribute('data-status')) === 'ready', 'codex cloud node shows ready', 10000);
    await until(async () => (await sessionNode(S.ccc.id).getAttribute('data-status')) === 'idle', 'claude cloud node shows idle', 10000);
    const s = await state();
    const a = s.sessions.find((x) => x.id === S.ccc.id);
    const b = s.sessions.find((x) => x.id === S.cxc.id);
    return `${a.native_url} (idle), ${b.native_url.split('/').pop().slice(0, 18)}… (ready, ${b.meta.diffSummary})`;
  });
  await page.screenshot({ path: path.join(SHOTS, 'desktop-canvas-cloud.png') });

  let nodeId;
  await check('winch console: publish_app from the agent, node renders beside its session, screenshot returned', async () => {
    await chat(S.cc1.id, 'Build the simulated winch console app and publish it');
    const n = await until(async () => (await state()).nodes.find((x) => x.appId === 'winch-console' && x.sessionId === S.cc1.id), 'app node', 60000);
    nodeId = n.id;
    const msgs = await until(async () => {
      const m = await api('GET', `/api/sessions/${S.cc1.id}/messages`);
      return m.find((x) => x.role === 'tool' && x.text.includes('published')) && m;
    }, 'publish_app result in transcript', 60000);
    const res = msgs.find((x) => x.role === 'tool' && x.text.includes('published')).text;
    if (/screenshot failed/.test(res)) throw new Error(`screenshot failed: ${res}`);
    const thumb = await fetchish('GET', `${BASE}/api/apps/${nodeId}/thumbnail.png`, undefined, { authorization: `Bearer ${secrets().hubToken}` });
    if (thumb.status !== 200) throw new Error('no thumbnail');
    await page.locator(`[data-testid="app-node"][data-node-id="${nodeId}"]`).waitFor({ timeout: 10000 });
    if (n.state !== 'preview') throw new Error(`state ${n.state}`);
    return `${nodeId} preview v${n.version}, "${res.split('\n')[0]}"`;
  });

  const appNode = () => page.locator(`[data-testid="app-node"][data-node-id="${nodeId}"]`);
  const frame = () => appNode().frameLocator('iframe');
  // deep link, as in publish_app's preview URL and push notifications
  async function focusApp() {
    await page.goto(`${BASE}/?focus=${nodeId}`);
    await appNode().waitFor({ timeout: 15000 });
    await frame().locator('#set').waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    // Playwright maps mouse coordinates into an iframe without the canvas's CSS scale, so zoom the
    // camera to 100% around the (centered) node before clicking inside the app; real clicks don't need this
    await page.evaluate(() => {
      const view = globalThis.__view;
      const v = view.get();
      const cx = v.w / 2, cy = (v.h - 50) / 2, k = 1 / v.z;
      view.set({ z: 1, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k });
    });
    await page.waitForTimeout(300);
  }

  await check('preview blocks actuate (set_speed and stop) and audits the refusal', async () => {
    await focusApp();
    await frame().locator('#speed').filter({ hasText: /\d/ }).waitFor({ timeout: 10000 });
    await frame().locator('#set').click();
    await frame().locator('#msg', { hasText: /blocked by hub.*preview/i }).waitFor({ timeout: 10000 });
    await frame().locator('#stop').click();
    await frame().locator('#msg', { hasText: /blocked by hub/i }).waitFor({ timeout: 10000 });
    const audit = await api('GET', `/api/audit?node=${nodeId}`);
    const refused = audit.filter((a) => !a.allowed && a.reason.includes('preview'));
    if (refused.length < 2) throw new Error(`expected 2 refusals in audit, got ${refused.length}`);
    await appNode().screenshot({ path: path.join(SHOTS, 'app-node-preview-blocked.png') });
    return `${refused.length} refusals audited`;
  });

  await check('Promote (review → commit & pin → grant actuate), then confirm + audit', async () => {
    await appNode().locator('[data-testid="app-promote"]').click();
    await T('promote-grant').click();
    await until(async () => (await appNode().getAttribute('data-state')) === 'promoted', 'node promoted', 30000);
    const n = (await state()).nodes.find((x) => x.id === nodeId);
    if (n.grantedVersion !== n.version || !n.pinnedCommit) throw new Error('grant/pin missing');
    await focusApp();
    await frame().locator('#sp').fill('0.8');
    await frame().locator('#set').click();
    await T('confirm-dialog').waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(SHOTS, 'desktop-app-confirm.png') });
    await T('confirm-yes').click();
    await frame().locator('#msg', { hasText: /setpoint 0\.80/ }).waitFor({ timeout: 10000 });
    await frame().locator('#stop').click(); // unconfirmed by design
    await frame().locator('#msg', { hasText: /stopping/ }).waitFor({ timeout: 10000 });
    const audit = await api('GET', `/api/audit?node=${nodeId}`);
    const ok = audit.find((a) => a.tool === 'set_speed' && a.allowed && a.caller.startsWith('user:'));
    const pin = audit.find((a) => a.tool === '(promote)');
    if (!ok || !pin) throw new Error('missing audit entries');
    await T('tab-audit').click();
    await page.locator('text=set_speed').first().waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(SHOTS, 'desktop-audit.png') });
    await T('tab-canvas').click();
    return `pinned ${n.pinnedCommit.slice(0, 8)}, set_speed allowed after confirm (${ok.reason}), stop unconfirmed`;
  });


  // =============================================================== v2: GitHub, files, all node types
  const P1 = 'github.com/agent-hub-test/hexapod-robot';
  const focus = async (id) => {
    await page.goto(`${BASE}/?focus=${encodeURIComponent(id)}`);
    await page.waitForTimeout(700);
  };
  const H = (id) => page.locator(`[data-testid="${id}"]`);

  await check('project + branch nodes with GitHub PR and CI (gh)', async () => {
    const br = await until(async () => (await state()).branches.find((b) => b.id === `${P1}#feat/winch-console` && b.pr && b.ci), 'branch with PR+CI', 30000);
    await focus(br.id);
    const node = page.locator(`[data-testid="branch-node"][data-branch-id="${br.id}"]`);
    await node.waitFor({ timeout: 10000 });
    const pr = await node.locator('[data-testid="branch-pr"]').innerText();
    const ci = await node.locator('[data-testid="branch-ci"]').innerText();
    if (!pr.includes('18')) throw new Error(`PR chip "${pr}"`);
    if (!/pending|running|2\s*\/\s*3/i.test(ci)) throw new Error(`CI chip "${ci}"`);
    await page.locator(`[data-testid="project-node"][data-project-id="${P1}"]`).waitFor({ timeout: 5000 });
    await page.screenshot({ path: path.join(SHOTS, 'v2-project-branch.png') });
    return `PR #${br.pr.number} ${br.pr.state} (${br.pr.reviews.approved} approved), CI ${br.ci.state} ${br.ci.passed}/${br.ci.total}`;
  });

  await check('new branch from the canvas → worktree on mini-1, pushed, branch node appears', async () => {
    await focus(P1);
    await page.locator(`[data-testid="project-node"][data-project-id="${P1}"] [data-testid="new-branch"]`).first().click();
    await H('branch-name').fill('feat/smoke-branch');
    await H('branch-goal').fill('Branch created by the smoke test');
    await H('branch-push').check();
    await H('branch-submit').click();
    const b = await until(async () => (await state()).branches.find((x) => x.id === `${P1}#feat/smoke-branch` && x.checkouts.length && x.pushed), 'branch with worktree + pushed', 60000);
    await page.locator(`[data-testid="branch-node"][data-branch-id="${b.id}"]`).waitFor({ timeout: 15000 });
    return `${b.checkouts[0]} · pushed`;
  });

  let imgNode, docNode;
  await check('any file as a node: quick open → image and markdown nodes render', async () => {
    await page.goto(`${BASE}/`);
    await H('add-menu-button').click();
    await H('add-file').click();
    await H('quick-open').waitFor({ timeout: 10000 });
    const opts = await H('qo-source').locator('option').allTextContents();
    const ix = opts.findIndex((o) => /hexapod/.test(o) && /mini-1/.test(o) && !/worktrees/.test(o));
    if (ix >= 0) await H('qo-source').selectOption({ index: ix });
    await H('qo-input').fill('gait_sweep');
    await page.locator('[data-testid="qo-item"][data-path="AI/sim/gait/gait_sweep.png"]').waitFor({ timeout: 10000 });
    await H('qo-input').press('Enter');
    imgNode = await until(async () => (await state()).cnodes.find((n) => n.type === 'file' && n.data.path === 'AI/sim/gait/gait_sweep.png'), 'image file node', 15000);
    await focus(imgNode.id);
    const img = page.locator(`[data-testid="file-node"][data-node-id="${imgNode.id}"] img`).first();
    await img.waitFor({ timeout: 10000 });
    await until(() => img.evaluate((e) => e.complete && e.naturalWidth > 0), 'image decoded', 10000);
    // markdown from GitHub (main) through the API
    docNode = await api('POST', '/api/cnodes', { type: 'file', data: { source: { kind: 'github', projectId: P1, ref: 'main' }, path: 'SYS/vv/actuator_test_plan.md' } });
    await focus(docNode.id);
    await page.locator(`[data-testid="file-node"][data-node-id="${docNode.id}"]`).getByText('Actuator V&V test plan').first().waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(SHOTS, 'v2-file-nodes.png') });
    return `${imgNode.data.kind} @ ${String(imgNode.data.sha).slice(0, 8)}, doc from GitHub @ ${String(docNode.data.sha).slice(0, 8)}`;
  });

  await check('pinned file shows "Newer version" after a commit; Get latest re-pins', async () => {
    const fnode = await api('POST', '/api/cnodes', { type: 'file', data: { source: { kind: 'checkout', checkoutId: co1 }, path: 'docs/architecture.md' } });
    execFileSync('ssh', ['-i', CFG.ssh.identityFile, '-o', 'BatchMode=yes', 'hosta@localhost', 'cd code/hexapod-robot && echo "Updated by the smoke test." >> docs/architecture.md && git commit -qam "docs: architecture note" && git rev-parse HEAD']);
    await api('POST', `/api/checkouts/${encodeURIComponent(co1)}/refresh`);
    await focus(fnode.id);
    const n = page.locator(`[data-testid="file-node"][data-node-id="${fnode.id}"]`).locator('xpath=..'); // pin chip sits above the node
    await n.locator('[data-testid="file-newer"]').waitFor({ timeout: 40000 });
    await n.locator('[data-testid="file-latest"]').click();
    await until(async () => (await state()).cnodes.find((x) => x.id === fnode.id && !x.data.newer && x.data.sha !== fnode.data.sha), 're-pinned', 15000);
    return `${String(fnode.data.sha).slice(0, 8)} → newer commit detected → re-pinned`;
  });

  await check('note and to-do list nodes (create, edit, toggle, dispatch to an agent)', async () => {
    await page.goto(`${BASE}/`);
    await H('add-menu-button').click();
    await H('add-note').click();
    const note = await until(async () => (await state()).cnodes.find((n) => n.type === 'note'), 'note node', 10000);
    await focus(note.id);
    await page.locator('[data-testid="note-node"] [data-testid="note-text"]').first().fill('Fab quote due Friday.');
    await until(async () => (await state()).cnodes.find((n) => n.id === note.id && n.data.text === 'Fab quote due Friday.'), 'note saved', 10000);
    await H('add-menu-button').click();
    await H('add-todos').click();
    const list = await until(async () => (await state()).cnodes.find((n) => n.type === 'todos'), 'to-do list', 10000);
    await focus(list.id);
    const ln = page.locator('[data-testid="todos-node"]').first();
    await ln.locator('[data-testid="todo-input"]').fill('Order PCAN cable');
    await ln.locator('[data-testid="todo-add"]').click();
    const t = await until(async () => (await state()).todos.find((x) => x.text === 'Order PCAN cable'), 'to-do saved', 10000);
    await ln.locator(`[data-testid="todo-item"][data-todo-id="${t.id}"] [data-testid="todo-toggle"]`).click();
    await until(async () => (await state()).todos.find((x) => x.id === t.id && x.done), 'to-do done', 10000);
    const t2 = await api('POST', '/api/todos', { text: 'Summarize the CAN fixtures', scope: list.data.scope });
    const s = await api('POST', `/api/todos/${t2.id}/dispatch`, { vendor: 'codex', where: 'mini-1', accountId: 'personal', checkoutId: co1 });
    await until(async () => (await state()).todos.find((x) => x.id === t2.id && x.dispatchedSessionId === s.id), 'dispatched', 10000);
    return `note saved, to-do toggled, dispatched to ${s.id}`;
  });

  let reviewId;
  await check('agent-created review, suggestion and to-do; review decision goes back to the agent; suggestion launches', async () => {
    await chat(S.cc1.id, 'Write the thermal derating report for rev B');
    const rv = await until(async () => (await state()).cnodes.find((n) => n.type === 'review' && n.parentId === S.cc1.id), 'review node', 40000);
    reviewId = rv.id;
    await until(async () => (await state()).cnodes.find((n) => n.type === 'suggest' && n.parentId === S.cc1.id), 'suggestion node', 10000);
    await until(async () => (await state()).cnodes.find((n) => n.type === 'htodo' && n.parentId === S.cc1.id), 'agent to-do', 10000);
    await focus(rv.id);
    const rn = page.locator(`[data-testid="review-node"][data-node-id="${rv.id}"]`);
    await rn.waitFor({ timeout: 10000 });
    await rn.locator('[data-testid="review-check"]').first().click();
    await rn.locator('[data-testid="review-comment-input"]').fill('Label the axis: ambient or case?');
    await rn.locator('[data-testid="review-comment-input"]').press('Enter');
    await rn.locator('[data-testid="review-note"]').fill('Mark the 2 oz curve as an estimate');
    await page.screenshot({ path: path.join(SHOTS, 'v2-review.png') });
    await rn.locator('[data-testid="review-changes"]').click();
    await until(async () => (await api('GET', `/api/sessions/${S.cc1.id}/messages`)).some((m) => m.role === 'user' && /CHANGES REQUESTED/.test(m.text) && /ambient or case/.test(m.text)), 'decision delivered to the agent', 20000);
    const sg = (await state()).cnodes.find((n) => n.type === 'suggest' && n.parentId === S.cc1.id);
    await focus(sg.id);
    await page.locator('[data-testid="suggest-node"] [data-testid="suggest-launch"]').first().click();
    const launched = await until(async () => (await state()).cnodes.find((n) => n.id === sg.id && n.data.status === 'launched' && n.data.sessionId), 'suggestion launched', 30000);
    return `review → changes requested (with comment) delivered; suggestion → ${launched.data.sessionId}`;
  });

  await check('compute cluster: machines with live metrics, devices with locks', async () => {
    const m = await until(async () => (await state()).machines.find((x) => x.id === 'mini-2' && x.cpu && x.gpu.length), 'mini-2 metrics + GPU', 20000);
    await focus('mini-1');
    await page.locator('[data-testid="machine-node"][data-host-id="mini-1"]').first().waitFor({ timeout: 10000 });
    await page.locator('[data-testid="machine-node"][data-host-id="mini-1"] [data-testid="machine-cpu"]').first().waitFor({ timeout: 10000 });
    const dev = page.locator('[data-testid="device-node"][data-device-id="mini-1:pcan"]').first();
    await dev.waitFor({ timeout: 10000 });
    if ((await dev.getAttribute('data-status')) !== 'connected') throw new Error('PCAN not connected');
    await dev.locator('[data-testid="device-lock"]').selectOption(S.cx1.id);
    await until(async () => (await state()).devices.find((d) => d.id === 'mini-1:pcan' && d.lock?.sessionId === S.cx1.id), 'lock assigned', 10000);
    await page.screenshot({ path: path.join(SHOTS, 'v2-compute.png') });
    await dev.locator('[data-testid="device-lock"]').selectOption('');
    await until(async () => (await state()).devices.find((d) => d.id === 'mini-1:pcan' && !d.lock), 'lock released', 10000);
    return `mini-2 cpu ${m.cpu.pct}% · ${m.gpu[0].name} ${m.gpu[0].memUsedMB}/${m.gpu[0].memTotalMB} MB; PCAN lock assigned + released`;
  });

  await check('HIL run: locks the plan devices, streams rows, 11 pass / 1 fail, re-run failed', async () => {
    await focus('mini-1:actuator-vv');
    const hn = page.locator('[data-testid="hil-node"][data-plan-id="mini-1:actuator-vv"]').first();
    await hn.waitFor({ timeout: 10000 });
    await hn.locator('[data-testid="hil-run"]').click();
    await until(async () => (await state()).devices.filter((d) => d.lock?.sessionId === 'you').length === 3, 'plan devices locked', 10000);
    const run = await until(async () => (await state()).hil.runs.find((r) => r.planId === 'mini-1:actuator-vv' && r.status !== 'running'), 'run finished', 60000);
    if (run.pass !== 11 || run.fail !== 1) throw new Error(`${run.pass} pass / ${run.fail} fail`);
    await hn.locator('[data-testid="hil-row"][data-status="fail"]').first().waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(SHOTS, 'v2-hil.png') });
    await hn.locator('[data-testid="hil-rerun"]').click();
    const rr = await until(async () => (await state()).hil.runs.find((r) => r.id !== run.id && r.only?.includes('T-07') && r.status !== 'running'), 're-run finished', 30000);
    if ((await state()).devices.some((d) => d.lock?.sessionId === 'you')) throw new Error('locks not released');
    return `${run.pass}/${run.pass + run.fail} pass (T-07 overshoot); re-run of ${rr.only.join(',')} → ${rr.status}`;
  });

  await check('compute grant: agent requests, you approve on the grant node, agent runs on the host', async () => {
    const tool = async (name, args) => {
      const r = await fetchish('POST', `${BASE}/api/mcp/tools/${name}`, { arguments: args, context: { hubSessionId: S.cc1.id, hostId: 'mini-1', cwd: '/home/hosta/code/hexapod-robot', vendor: 'claude' } }, { authorization: `Bearer ${secrets().hookToken}` });
      return JSON.parse(r.text);
    };
    const req = await tool('request_compute', { host: 'mini-2', resources: '1× GPU · 24 GB', purpose: 'Offload FEA solver to GPU' });
    const gid = req.structuredContent.grantId;
    const denied = await tool('run_on_host', { grant_id: gid, command: 'whoami' });
    if (!denied.isError) throw new Error('ran before approval');
    await focus(S.cc1.id);
    const gn = page.locator('[data-testid="grant-node"]').first();
    await gn.waitFor({ timeout: 10000 });
    await gn.getByRole('button', { name: /approve/i }).click();
    await until(async () => (await state()).grants.find((g) => g.id === gid && g.status === 'active'), 'grant active', 10000);
    const ok = await tool('run_on_host', { grant_id: gid, command: 'whoami' });
    if (ok.isError || !/hostb/.test(ok.content[0].text)) throw new Error(`run_on_host: ${ok.content[0].text}`);
    return `grant ${gid} approved; run_on_host → ${ok.content[0].text.split('\n')[1]}`;
  });

  await check('terminal node: real shell over SSH (tmux), typed command echoes', async () => {
    await focus('mini-2');
    await page.locator('[data-testid="machine-node"][data-host-id="mini-2"] [data-testid="terminal-open"]').first().click();
    const tn = await until(async () => (await state()).cnodes.find((n) => n.type === 'terminal' && n.data.hostId === 'mini-2'), 'terminal node', 15000);
    await focus(tn.id);
    const term = page.locator(`[data-testid="terminal-node"][data-node-id="${tn.id}"]`);
    await term.locator('.xterm').waitFor({ timeout: 15000 });
    await page.waitForTimeout(1200);
    await term.locator('.xterm').click();
    await page.keyboard.type('echo smoke-$((40+2)) $(whoami)');
    await page.keyboard.press('Enter');
    await until(async () => /smoke-42 hostb/.test(await term.locator('.xterm-rows').innerText()), 'terminal output', 15000);
    await page.screenshot({ path: path.join(SHOTS, 'v2-terminal.png') });
    return 'smoke-42 hostb';
  });

  await check('scan pushed branches: Claude cloud result branch + app found on it', async () => {
    const s = await spawnFromDialog({ vendor: 'claude', where: 'cloud', checkout: co1, prompt: 'Build a status dashboard app for the rig' });
    const b = await until(async () => (await state()).branches.find((x) => x.name.startsWith('claude/build-a-status') && x.apps.length && x.cloud?.sessionId === s.id), 'claude/* branch with app', 60000);
    await focus(b.id);
    await page.locator(`[data-testid="branch-node"][data-branch-id="${b.id}"]`).getByText('Cloud status board').first().waitFor({ timeout: 10000 });
    return `${b.name} → apps ${b.apps.map((a) => a.path).join(', ')}, linked to ${s.id}`;
  });

  // ---- canvas tools: external MCP, Ask Claude (live edits + undo), confirm tier
  const mcp = (method, params, tok = secrets().mcpToken) =>
    fetchish('POST', `${BASE}/mcp`, { jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params }, tok ? { authorization: `Bearer ${tok}` } : {});
  const mcpCall = async (name, args = {}) => {
    const r = JSON.parse((await mcp('tools/call', { name, arguments: args })).text);
    if (r.error) throw new Error(r.error.message);
    if (r.result?.isError) throw new Error(r.result.content?.[0]?.text);
    return r.result;
  };
  const snapshot = async () => JSON.parse((await mcpCall('canvas_snapshot')).content[0].text);
  const posOf = (ids) => Promise.all(ids.map((id) => page.locator(`[data-node-key="${id}"]`).evaluate((el) => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) }))));

  await check('canvas MCP for Claude Code / Desktop: /mcp with its own token, stdio bridge, snapshot of what the PWA shows', async () => {
    if ((await mcp('tools/list', {}, '')).status !== 401) throw new Error('/mcp answered without a token');
    if ((await mcp('tools/list', {}, secrets().hubToken)).status !== 401) throw new Error('/mcp accepted the PWA token');
    const init = JSON.parse((await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } })).text);
    if (!init.result?.capabilities?.tools) throw new Error(`initialize: ${JSON.stringify(init).slice(0, 200)}`);
    const names = JSON.parse((await mcp('tools/list', {})).text).result.tools.map((t) => t.name);
    for (const n of ['canvas_snapshot', 'canvas_arrange', 'canvas_add_note', 'hub_spawn_session']) if (!names.includes(n)) throw new Error(`tools/list lacks ${n}`);
    await page.goto(`${BASE}/`);
    await T('tab-canvas').waitFor({ timeout: 15000 });
    const snap = await until(async () => { const j = await snapshot(); return j.nodes?.length > 5 && j.reportedSecondsAgo < 30 && j; }, 'a fresh view report from the PWA', 20000);
    // Claude Desktop: the same script the hub copies to hosts, run on your machine with --external
    const out = execFileSync('python3', [path.join(ROOT, 'host-files/hub_channel.py'), '--external'], {
      input: [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'desktop', version: '1' } } }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }].map((m) => JSON.stringify(m)).join('\n') + '\n',
      env: { ...process.env, HUB_MCP_URL: `${BASE}/mcp`, HUB_MCP_TOKEN: secrets().mcpToken, HUB_CA_FILE: CFG.tls?.ca || '' }, timeout: 30000,
    }).toString().trim().split('\n').map((l) => JSON.parse(l));
    const listed = out.find((m) => m.id === 2)?.result?.tools?.length || 0;
    if (!listed) throw new Error(`stdio bridge: ${JSON.stringify(out).slice(0, 200)}`);
    return `${names.length} tools; snapshot ${snap.nodes.length} nodes (${snap.layoutMode}); stdio bridge lists ${listed}`;
  });

  let pick = [];
  await check('Ask Claude: assistant on mini-1 arranges the selected nodes live (glow + Undo pill), adds a note; Undo reverts', async () => {
    await T('ask-button').click();
    await T('ask-panel').waitFor({ timeout: 5000 });
    await T('ask-host').selectOption('mini-1');
    pick = (await snapshot()).nodes.filter((n) => ['note', 'todos', 'file'].includes(n.kind)).slice(0, 3).map((n) => n.id);
    if (pick.length < 2) throw new Error('need two note/file/to-do nodes on the canvas');
    await mcpCall('canvas_select', { ids: pick }); // also proves canvas.ui reaches the PWA
    await until(async () => (await page.locator('[data-selected="1"]').count()) === pick.length, 'selection from canvas_select', 8000);
    await until(async () => (await snapshot()).selected.length === pick.length, 'selection reported back', 8000);
    const layoutOf = async () => { const l = (await state()).layout; return JSON.stringify(pick.map((id) => l[id] ? [l[id].x, l[id].y] : null)); };
    const before = await layoutOf();
    await T('ask-input').fill('Arrange the selected nodes in a column and add a note');
    await T('ask-send').click();
    const asst = await until(async () => (await state()).sessions.find((x) => x.meta?.role === 'assistant' && x.status !== 'ended'), 'assistant session', 30000);
    await T('change-pill').waitFor({ timeout: 90000 });
    const glowing = await page.locator('.node.glow').count();
    const note = await until(async () => (await state()).cnodes.find((n) => n.type === 'note' && n.data.title === 'Arranged by Claude'), 'note from Claude', 30000);
    await page.waitForTimeout(600);
    const after = await posOf(pick);
    if (!after.every((p) => Math.abs(p.left - after[0].left) < 1)) throw new Error(`not a column: ${JSON.stringify(after)}`);
    if (!glowing) throw new Error('changed nodes did not glow');
    await until(async () => (await page.locator('[data-testid="ask-panel"] [data-testid="msg"]').allInnerTexts()).some((t) => /Arranged \d+ nodes/.test(t)), 'assistant reply in the panel', 30000);
    await page.screenshot({ path: path.join(SHOTS, 'ask-claude.png') });
    await T('change-undo').click();
    await until(async () => !(await state()).cnodes.find((n) => n.id === note.id), 'undo removes the note', 10000);
    const back = await until(async () => { const b = await layoutOf(); return b === before && b; }, `undo restores saved positions ${before}`, 10000);
    void back;
    return `${asst.id} on ${asst.host_id}: ${pick.length} nodes → column (${glowing} glowing) + note; undo restored both`;
  });

  await check('Ask Claude confirm tier: starting a session waits for Allow in the panel, then runs', async () => {
    await mcpCall('canvas_select', { ids: [] });
    await T('ask-input').fill('Start a codex session on mini-2 to tally fixture files smoke-77');
    await T('ask-send').click();
    const card = page.locator('[data-testid="ask-panel"] [data-testid="approval-card"]');
    await card.waitFor({ timeout: 60000 });
    const ap = await until(async () => Object.values((await state()).approvals).find((a) => a.source === 'canvas-action' && a.status === 'pending'), 'pending canvas-action approval', 5000);
    await sleep(1500);
    if ((await state()).sessions.some((x) => x.vendor === 'codex' && /smoke-77/.test(x.title))) throw new Error('session started before you allowed it');
    await card.locator('[data-testid="approval-allow"]').click();
    const s = await until(async () => (await state()).sessions.find((x) => x.vendor === 'codex' && x.host_id === 'mini-2' && /smoke-77/.test(x.title)), 'codex session after Allow', 60000);
    await until(async () => (await page.locator('[data-testid="ask-panel"] [data-testid="msg"]').allInnerTexts()).some((t) => /Started it/.test(t)), 'assistant reply', 30000);
    await T('ask-close').click();
    return `approval ${ap.id} → ${s.id} on mini-2`;
  });

  await check('web push sent for approvals (VAPID, aes128gcm)', async () => {
    if (!pushes.length) throw new Error('no push delivered to the subscription endpoint');
    const p = pushes[0];
    if (!/^vapid t=/.test(p.auth) || p.encoding !== 'aes128gcm') throw new Error(`unexpected push request ${JSON.stringify(p)}`);
    return `${pushes.length} pushes`;
  });

  await page.locator('button', { hasText: /^Fit$/ }).first().click().catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-1440x900.png') });
  await check('phone layout 390×844', async () => {
    const m = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await m.addCookies((await ctx.cookies()).filter((c) => c.name === 'hub_token'));
    const p = await m.newPage();
    await p.goto(BASE + '/');
    await p.locator('[data-testid="tab-canvas"]').waitFor({ timeout: 15000 });
    await p.waitForTimeout(1500);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await p.screenshot({ path: path.join(SHOTS, 'phone-390x844.png') });
    await m.close();
    if (overflow > 1) throw new Error(`horizontal overflow ${overflow}px`);
    return 'no horizontal scroll';
  });
} catch {
  // fall through to the report
} finally {
  await browser.close().catch(() => {});
  pushSrv.close();
  hub.kill();
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`).join('\n'));
if (consoleErrors.length) console.log(`\nbrowser console errors (${consoleErrors.length}):\n  ${[...new Set(consoleErrors)].slice(0, 10).join('\n  ')}`);
fs.writeFileSync(path.join(SHOTS, 'smoke-result.json'), JSON.stringify({ at: new Date().toISOString(), results, consoleErrors: [...new Set(consoleErrors)] }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed; hub log ${LOG}`);
process.exit(failed.length || results.length < 25 ? 1 : 0);
