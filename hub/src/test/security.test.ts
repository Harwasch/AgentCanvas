import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Router, createServer, crossOriginReason, hubOrigins, essence, cookies, bearer } from '../http.js';
import { hostToken, sessionToken, hostForToken, sessionCallerReason } from '../tokens.js';
import { validRef } from '../projects.js';
import { validateManifest } from '../apps/manifest.js';
import { Db } from '../db.js';
import { AppService } from '../apps/service.js';

const CFG = { publicUrl: 'https://hub.tail1234.ts.net', listen: { host: '127.0.0.1', port: 8443 }, tls: null } as any;

test('hub origins: publicUrl and the listen address on the same port only', () => {
  const o = hubOrigins(CFG);
  assert.ok(o.has('https://hub.tail1234.ts.net'));
  assert.ok(o.has('https://127.0.0.1:8443'));
  assert.ok(!o.has('https://127.0.0.1:3000'));
  const local = hubOrigins({ publicUrl: 'https://localhost:8443', listen: { host: '0.0.0.0', port: 8443 }, tls: { cert: '', key: '' } } as any);
  assert.deepEqual([...local].sort(), ['https://127.0.0.1:8443', 'https://[::1]:8443', 'https://localhost:8443']);
});

test('cross-origin guard: Origin must be the hub, Sec-Fetch-Site same-origin or none', () => {
  const o = hubOrigins(CFG);
  assert.equal(crossOriginReason({}, o), null, 'non-browser clients send neither header');
  assert.equal(crossOriginReason({ origin: 'https://hub.tail1234.ts.net', 'sec-fetch-site': 'same-origin' }, o), null);
  assert.equal(crossOriginReason({ 'sec-fetch-site': 'none' }, o), null, 'typed URL / bookmark');
  assert.match(crossOriginReason({ origin: 'https://evil.example' }, o)!, /not this hub/);
  assert.match(crossOriginReason({ origin: 'https://other.tail1234.ts.net' }, o)!, /not this hub/);
  assert.match(crossOriginReason({ origin: 'http://localhost:5173' }, o)!, /not this hub/);
  assert.match(crossOriginReason({ origin: 'null' }, o)!, /not this hub/, 'sandboxed app frames have an opaque origin');
  assert.match(crossOriginReason({ 'sec-fetch-site': 'same-site' }, o)!, /cross-site/);
  assert.match(crossOriginReason({ 'sec-fetch-site': 'cross-site' }, o)!, /cross-site/);
});

test('content-type essence', () => {
  assert.equal(essence('application/json; charset=utf-8'), 'application/json');
  assert.equal(essence(' Application/JSON '), 'application/json');
  assert.equal(essence('text/plain;application/json'), 'text/plain');
  assert.equal(essence(undefined), '');
});

async function server() {
  const r = new Router();
  r.post('/api/x', 'hub', (req) => ({ got: req.body }));
  r.post('/hooks/x', 'hook', (req) => ({ got: req.body }));
  const authCheck = (auth: string, req: any) => {
    const tok = bearer(req) ?? (auth === 'hub' ? cookies(req).hub_token : undefined);
    return tok === 'T';
  };
  const s = createServer({ cfg: { ...CFG, publicUrl: 'http://localhost:1' }, router: r, authCheck: authCheck as any, origins: new Set(['http://localhost:1']) });
  await new Promise<void>((res) => s.listen(0, '127.0.0.1', res));
  const port = (s.address() as any).port;
  const req = (p: string, body: string, headers: Record<string, string>) => new Promise<{ status: number; text: string }>((res, rej) => {
    const q = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers }, (rs) => {
      let t = '';
      rs.on('data', (d) => (t += d));
      rs.on('end', () => res({ status: rs.statusCode!, text: t }));
    });
    q.on('error', rej);
    q.end(body);
  });
  return { s, req };
}

test('cookie requests: cross-origin refused (403), JSON bodies need application/json (415); bearer unaffected by origin', async () => {
  const { s, req } = await server();
  try {
    const json = { 'content-type': 'application/json' };
    assert.equal((await req('/api/x', '{"a":1}', { ...json, cookie: 'hub_token=T', origin: 'http://localhost:1' })).status, 200);
    assert.equal((await req('/api/x', '{"a":1}', { ...json, cookie: 'hub_token=T', origin: 'https://evil.example' })).status, 403);
    assert.equal((await req('/api/x', '{"a":1}', { ...json, cookie: 'hub_token=T', 'sec-fetch-site': 'same-site' })).status, 403);
    // a cross-site form can only send these types; none of them is parsed as JSON any more
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain; x=application/json'])
      assert.equal((await req('/api/x', '{"a":1}', { 'content-type': ct, cookie: 'hub_token=T' })).status, 415, ct);
    assert.equal((await req('/api/x', '{"a":1}', { ...json, authorization: 'Bearer T', origin: 'https://evil.example' })).status, 200, 'bearer is not ambient');
    assert.equal((await req('/hooks/x', '{"a":1}', { 'content-type': 'text/plain', authorization: 'Bearer T' })).status, 415);
    assert.equal((await req('/api/x', '{"a":1}', { ...json, origin: 'http://localhost:1' })).status, 401);
  } finally {
    s.close();
  }
});

test('per-host and per-session tokens', () => {
  const secret = 'hook-secret';
  const a = hostToken(secret, 'mini-1');
  assert.notEqual(a, hostToken(secret, 'mini-2'));
  assert.notEqual(a, secret);
  assert.equal(hostForToken(secret, ['mini-1', 'mini-2'], a), 'mini-1');
  assert.equal(hostForToken(secret, ['mini-1', 'mini-2'], hostToken(secret, 'mini-2')), 'mini-2');
  assert.equal(hostForToken(secret, ['mini-1', 'mini-2'], secret), null, 'the shared secret itself is not a host token');
  assert.equal(hostForToken(secret, ['mini-1'], undefined), null);

  const s = { id: 'cc-1', host_id: 'mini-1', meta: { stok: true } };
  assert.equal(sessionCallerReason(secret, 'mini-1', s, sessionToken(secret, 'cc-1')), null);
  assert.match(sessionCallerReason(secret, 'mini-1', s, sessionToken(secret, 'cc-2'))!, /bad session token/, "another session's token");
  assert.match(sessionCallerReason(secret, 'mini-1', s, undefined)!, /bad session token/);
  assert.match(sessionCallerReason(secret, 'mini-1', s, '')!, /bad session token/);
  assert.match(sessionCallerReason(secret, 'mini-2', s, sessionToken(secret, 'cc-1'))!, /not on the calling host/, 'right secret, wrong host');
  assert.match(sessionCallerReason(secret, undefined, s, sessionToken(secret, 'cc-1'))!, /not on the calling host/);
  // sessions without a secret (Codex, or started before per-session secrets) keep host-level identity
  assert.equal(sessionCallerReason(secret, 'mini-1', { id: 'cx-1', host_id: 'mini-1', meta: {} }, undefined), null);
  assert.match(sessionCallerReason(secret, 'mini-2', { id: 'cx-1', host_id: 'mini-1', meta: {} }, undefined)!, /not on the calling host/);
});

test('ref validation for branch names and bases', () => {
  for (const ok of ['main', 'feature/x-1', 'claude/build-a-status_v2', 'release-1.2', 'a/b/c']) assert.equal(validRef(ok), true, ok);
  for (const bad of ['', '-x', '--upload-pack=evil', 'a..b', '/a', 'a/', 'a//b', '.hidden', 'a/.b', 'x.lock', 'a b', 'a;rm -rf ~', '$(id)', '`id`', 'a"b', "a'b", 'main~1', 'HEAD^', 'a:b', 'a\nb', 'x'.repeat(101), undefined, 3])
    assert.equal(validRef(bad), false, String(bad));
});

test('manifest refuses server.env names that are not shell identifiers', () => {
  const base = { id: 'x', title: 'X', version: '0.1.0', server: { command: ['python3', 's.py'], transport: 'stdio' }, ui: 'ui://x/main', lifecycle: 'on-demand', csp: { connect: [], img: [] }, tools: {}, node: { width: 300, height: 200 } };
  assert.equal(validateManifest({ ...base, server: { ...base.server, env: { GOOD_1: 'a b' } } }).ok, true);
  const r = validateManifest({ ...base, server: { ...base.server, env: { 'X=1 touch /tmp/p;Y': 'v' } } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /server\.env/);
});

// ------------------------------------------------------------------ review hash over the whole app dir
const hasGit = spawnSync('git', ['--version']).status === 0;
function localHosts() {
  const run = (cmd: string, input?: string) => {
    const r = spawnSync('bash', ['-c', cmd], { input, maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status ?? -1, stdout: r.stdout, stderr: String(r.stderr) };
  };
  return {
    exec: async (_h: string, cmd: string) => { const r = run(cmd); return { ...r, stdout: r.stdout.toString('utf8') }; },
    execBuf: async (_h: string, cmd: string) => run(cmd),
    execOk: async (_h: string, cmd: string) => { const r = run(cmd); if (r.code) throw new Error(r.stderr); return r.stdout.toString('utf8'); },
  };
}

test('review hash covers nested and untracked files; promote refuses when they change after review', { skip: !hasGit }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-review-'));
  const repo = path.join(tmp, 'repo');
  const dir = path.join(repo, 'apps', 'winch');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'server.py'), 'print(1)\n');
  fs.writeFileSync(path.join(dir, 'lib', 'drive.py'), 'SPEED = 1\n');
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const db = new Db(':memory:');
  db.upsert('app_node', { id: 'app-1', host_id: 'h', dir, title: 'Winch', manifest: JSON.stringify({ tools: {}, lifecycle: 'on-demand' }), state: 'preview', version: 1, session_id: null });
  const c: any = { db, hosts: localHosts(), cfg: { dataDir: tmp, screenshot: {}, publicUrl: 'https://x', accounts: [{ id: 'a' }] }, secrets: { hubToken: 't' }, store: { session: () => undefined }, account: () => ({}) };
  const apps = new AppService(c);

  const clean = await apps.review('app-1');
  assert.ok(clean.candidateCommit && clean.reviewHash);
  assert.deepEqual(clean.dirtyFiles, []);

  // an untracked file two levels down (the old review only looked at top-level files)
  fs.mkdirSync(path.join(dir, 'lib', 'hw'));
  fs.writeFileSync(path.join(dir, 'lib', 'hw', 'override.py'), 'MAX_TORQUE = 999\n');
  const r1 = await apps.review('app-1');
  assert.notEqual(r1.reviewHash, clean.reviewHash);
  assert.deepEqual(r1.dirtyFiles, ['lib/hw/override.py']);
  assert.ok(r1.files.includes('lib/hw/override.py'));
  assert.ok(r1.serverFiles.some((f: any) => f.path === 'lib/hw/override.py' && f.changed && f.content.includes('MAX_TORQUE')));

  // a nested tracked change after review changes the hash, and promote refuses the stale review
  fs.writeFileSync(path.join(dir, 'lib', 'drive.py'), 'SPEED = 9\n');
  const r2 = await apps.review('app-1');
  assert.notEqual(r2.reviewHash, r1.reviewHash);
  assert.deepEqual([...r2.dirtyFiles].sort(), ['lib/drive.py', 'lib/hw/override.py']);
  await assert.rejects(apps.promote('app-1', { commit: r1.candidateCommit!, grantActuate: true, commitDirty: true, reviewHash: r1.reviewHash }), /changed since you reviewed/);

  // files outside the app dir never enter the hash
  fs.writeFileSync(path.join(repo, 'README.md'), 'outside\n');
  assert.equal((await apps.review('app-1')).reviewHash, r2.reviewHash);
  await apps.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('plain HTTP is refused on non-loopback listen addresses unless https is in front', async () => {
  const { insecureHttp } = await import('../config.js');
  assert.match(insecureHttp({ tls: null, publicUrl: 'http://hub:8443', listen: { host: '0.0.0.0', port: 8443 } })!, /unencrypted/);
  assert.equal(insecureHttp({ tls: null, publicUrl: 'https://hub.tail.ts.net', listen: { host: '127.0.0.1', port: 8443 } }), null, 'tailscale serve');
  assert.equal(insecureHttp({ tls: null, publicUrl: 'http://localhost:8443', listen: { host: '127.0.0.1', port: 8443 } }), null, 'local only');
  assert.equal(insecureHttp({ tls: { cert: 'c', key: 'k' }, publicUrl: 'https://h', listen: { host: '0.0.0.0', port: 8443 } }), null);
});

test('screenshot sizes are clamped', async () => {
  const { clampDim } = await import('../apps/shot.js');
  assert.equal(clampDim(100000, 640), 2400);
  assert.equal(clampDim(1, 640), 200);
  assert.equal(clampDim('abc', 640), 640);
  assert.equal(clampDim(undefined, 420), 420);
  assert.equal(clampDim(800, 640), 800);
});
