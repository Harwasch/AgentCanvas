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
const browser = await chromium.launch({ executablePath: CFG.screenshot.chromiumPath || undefined, args: ['--no-sandbox'] });
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
      await until(async () => (await state()).sessions.find((s) => s.id === id && s.status === 'idle'), `${k} idle after first turn`, 45000);
      const msgs = await api('GET', `/api/sessions/${id}/messages`);
      if (!msgs.some((m) => m.role === 'assistant' && m.kind === 'text' && m.text)) throw new Error(`${k}: no assistant reply`);
    }
    const s = await state();
    const cc = s.sessions.filter((x) => [S.cc1.id, S.cc2.id].includes(x.id));
    if (!cc.every((x) => x.native_url?.startsWith('https://claude.ai/code/session_'))) throw new Error('Claude sessions missing Remote Control URL');
    if (!cc.every((x) => x.meta.channel === 'connected')) throw new Error('Claude channel not connected');
    return `codex ${S.cx1.native_id.slice(0, 8)}…/${S.cx2.native_id.slice(0, 8)}…, claude ${cc.map((x) => x.native_url.split('/').pop().slice(0, 14)).join(', ')}`;
  });
  await page.screenshot({ path: path.join(SHOTS, 'desktop-canvas-sessions.png') });

  async function openNode(id) {
    const n = sessionNode(id);
    await n.scrollIntoViewIfNeeded().catch(() => {});
    if (!(await n.locator('[data-testid="chat-input"]').count())) await n.locator('[data-testid="node-expand"]').first().click();
    await n.locator('[data-testid="chat-input"]').waitFor({ timeout: 10000 });
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
  async function focusApp() {
    await appNode().scrollIntoViewIfNeeded().catch(() => {});
    await appNode().click({ position: { x: 60, y: 14 } });
    await frame().locator('#set').waitFor({ timeout: 15000 });
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

  await check('web push sent for approvals (VAPID, aes128gcm)', async () => {
    if (!pushes.length) throw new Error('no push delivered to the subscription endpoint');
    const p = pushes[0];
    if (!/^vapid t=/.test(p.auth) || p.encoding !== 'aes128gcm') throw new Error(`unexpected push request ${JSON.stringify(p)}`);
    return `${pushes.length} pushes`;
  });

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
process.exit(failed.length || results.length < 13 ? 1 : 0);
