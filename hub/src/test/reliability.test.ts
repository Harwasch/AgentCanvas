import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db.js';
import { EventBus } from '../events.js';
import { Store } from '../store.js';
import { CanvasService } from '../canvas.js';
import { ClaudeDriver, parseTmuxStates } from '../claude/driver.js';
import { RepoIndexer, checkoutMoved } from '../repos.js';
import { ProjectService } from '../projects.js';
import { GitHubAdapter } from '../adapters.js';

function base() {
  const db = new Db(':memory:');
  const bus = new EventBus();
  const store = new Store(db, bus);
  return { db, bus, store };
}
const session = (store: Store, id: string, o: Record<string, any> = {}) =>
  store.upsertSession({ id, vendor: 'claude', kind: 'local', host_id: 'h1', account_id: 'a', title: id, status: 'idle', meta: { tmux: id }, ...o } as any);

// ------------------------------------------------------------------ approvals across a restart
test('hub start expires approvals whose waiter lived in the old process; channel approvals stay while their session lives', () => {
  const { store } = base();
  session(store, 's-live');
  session(store, 's-ended', { status: 'ended' });
  const add = (id: string, source: any, sessionId = 's-live') => store.upsertApproval({ id, session_id: sessionId, source, status: 'pending', title: id, detail: '', data: {} });
  add('canvas', 'canvas-action');
  add('app', 'app-confirm');
  add('hook', 'claude-hook');
  add('codex', 'codex');
  add('chan-live', 'claude-channel');
  add('chan-ended', 'claude-channel', 's-ended');
  add('chan-unknown', 'claude-channel', 's-missing');
  const expired = store.expireOrphanedApprovals().sort();
  assert.deepEqual(expired, ['app', 'canvas', 'chan-ended', 'chan-unknown', 'codex', 'hook']);
  assert.deepEqual(store.pendingApprovals().map((a) => a.id), ['chan-live']);
  assert.equal(store.approval('canvas')!.status, 'expired');
});

// ------------------------------------------------------------------ confirm tier: the waiting request goes away
test('a confirm-tier approval expires when the HTTP caller disconnects, and cannot be decided afterwards', async () => {
  const { db, bus, store } = base();
  const c: any = { db, bus, store, push: { notify() {} }, cfg: { hosts: [{ id: 'h1' }], accounts: [] } };
  const cv = new CanvasService(c);
  const ac = new AbortController();
  const p = cv.call('hub_open_terminal', { host: 'h1' }, { kind: 'external', sessionId: null, label: 'test' }, ac.signal);
  const a = store.pendingApprovals()[0];
  assert.equal(a.source, 'canvas-action');
  assert.ok(a.data.expiresAt > Date.now() && a.data.expiresAt <= Date.now() + 150_000, 'expiry shown to the user, below the 180 s client timeout');
  assert.ok(cv.waiting(a.id));
  ac.abort();
  const r = await p;
  assert.equal(r.isError, true);
  assert.equal(store.approval(a.id)!.status, 'expired');
  assert.equal(cv.waiting(a.id), false);
  assert.throws(() => cv.decide(a.id, 'allow'), /no longer waiting/);
});

test('an already-aborted signal never leaves a pending approval behind', async () => {
  const { db, bus, store } = base();
  const cv = new CanvasService({ db, bus, store, push: { notify() {} }, cfg: { hosts: [{ id: 'h1' }], accounts: [] } } as any);
  const ac = new AbortController();
  ac.abort();
  const r = await cv.call('hub_open_terminal', { host: 'h1' }, { kind: 'external', sessionId: null, label: 'test' }, ac.signal);
  assert.equal(r.isError, true);
  assert.equal(store.pendingApprovals().length, 0);
});

// ------------------------------------------------------------------ Claude liveness / recovery
test('tmux states: exit 0 alive, 1 gone, anything else (or no answer) unknown', () => {
  const m = parseTmuxStates(['a', 'b', 'c', 'd'], 'a 0\nb 1\nc 127\n');
  assert.deepEqual([...m], [['a', 'alive'], ['b', 'gone'], ['c', 'unknown'], ['d', 'unknown']]);
  assert.deepEqual([...parseTmuxStates(['a'], '')], [['a', 'unknown']], 'ssh failed: no output at all');
});

function claudeCtx(execOut: { code: number; stdout: string }) {
  const { db, bus, store } = base();
  const released: string[] = [];
  bus.on('event', (ev) => { if (ev.type === 'session.upsert' && ev.data.status === 'ended') released.push(ev.data.id); });
  const c: any = { db, bus, store, cfg: { claudeLivenessIntervalSec: 60 }, hosts: { exec: async () => ({ stderr: '', ...execOut }), bin: () => 'tmux', row: () => ({ status: 'online' }) } };
  const drv = new ClaudeDriver(c);
  const attached: string[] = [];
  (drv as any).attach = (id: string) => attached.push(id);
  return { store, drv, attached, released };
}

test('recover: an unreachable host (ssh exit 255) keeps its sessions; tmux "no session" ends them', async () => {
  let t = claudeCtx({ code: 255, stdout: '' });
  session(t.store, 'cc-1', { status: 'running' });
  await t.drv.recover(undefined, { startup: true });
  let s = t.store.session('cc-1')!;
  assert.equal(s.status, 'running');
  assert.equal(s.last_event, 'host offline');
  assert.equal(s.meta.hostOffline, true);
  assert.deepEqual(t.released, [], 'no lock release for a session that did not end');

  t = claudeCtx({ code: 0, stdout: 'cc-1 1\ncc-2 0\n' });
  session(t.store, 'cc-1');
  session(t.store, 'cc-2', { meta: { tmux: 'cc-2', hostOffline: true } });
  await t.drv.recover('h1');
  assert.equal(t.store.session('cc-1')!.status, 'ended');
  assert.deepEqual(t.released, ['cc-1']);
  s = t.store.session('cc-2')!;
  assert.equal(s.status, 'idle');
  assert.equal(s.meta.hostOffline, false);
  assert.deepEqual(t.attached, ['cc-2']);
});

// ------------------------------------------------------------------ repo scans
test('a repo scan nudges the project only when the checkout moved', async () => {
  const { db, bus } = base();
  let head = 'a'.repeat(40);
  const touched: string[] = [];
  const out = () => `# branch.oid ${head}\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n\u001efix\u001f1700000000\n\u001ehttps://github.com/o/r.git\n\u001e`;
  const c: any = { db, bus, hosts: { execOk: async () => out() }, projects: { touch: (id: string) => touched.push(id) } };
  const ri = new RepoIndexer(c);
  await ri.refreshPath('h1', '/code/r');
  await ri.refreshPath('h1', '/code/r');
  await ri.refreshPath('h1', '/code/r');
  assert.deepEqual(touched, ['github.com/o/r'], 'new checkout touches once; unchanged scans do not');
  head = 'b'.repeat(40);
  await ri.refreshPath('h1', '/code/r');
  assert.equal(touched.length, 2);
  assert.equal(checkoutMoved({ head: 'x', branch: 'm', ahead: 0, behind: 0, dirty: 1 }, { head: 'x', branch: 'm', ahead: 0, behind: 0, dirty: 2 }), true);
  assert.equal(checkoutMoved({ head: 'x', branch: 'm', ahead: 0, behind: 0, dirty: 1, upstream: null }, { head: 'x', branch: 'm', ahead: 0, behind: 0, dirty: 1 }), false);
});

// ------------------------------------------------------------------ GitHub
function projectCtx() {
  const { db, bus, store } = base();
  db.upsert('repo', { id: 'github.com/o/r', remote_url: 'https://github.com/o/r.git', name: 'r' });
  const c: any = {
    db, bus, store,
    cfg: { accounts: [{ id: 'p', gh: { configDir: '/x', owners: ['o'] } }], githubPollIntervalSec: 60 },
    repos: { row: (r: any) => r },
    hosts: { exec: async () => ({ code: 0, stdout: '', stderr: '' }) },
  };
  const ps = new ProjectService(c);
  const calls: string[] = [];
  let down = false;
  const pulls = [{ number: 7, title: 'PR', state: 'open', draft: false, merged_at: null, html_url: 'u', head: { ref: 'claude/x', sha: 's2' }, base: { ref: 'main' } }];
  const api = async (_a: string, ep: string) => {
    calls.push(ep.split('?')[0]);
    if (down) throw new Error('gh api: HTTP 502');
    if (/\/branches/.test(ep)) return /page=1(&|$)/.test(ep) ? [{ name: 'main', commit: { sha: 's1' } }, { name: 'claude/x', commit: { sha: 's2' } }] : [];
    if (/\/pulls\/7\/reviews/.test(ep)) return [{ state: 'APPROVED' }];
    if (/\/pulls/.test(ep)) return /state=open/.test(ep) && /page=1(&|$)/.test(ep) ? pulls : [];
    if (/check-runs/.test(ep)) return { check_runs: [{ status: 'completed', conclusion: 'success', html_url: 'ci' }] };
    if (/\/status/.test(ep)) return { state: 'failure', statuses: [{ state: 'failure', target_url: 'st' }] };
    if (/\/commits/.test(ep)) return [{ sha: 's2', commit: { message: 'm', author: { name: 'n', date: '2026-01-01' } } }];
    if (/\/compare\//.test(ep)) return { ahead_by: 1, behind_by: 0 };
    if (/\/git\/trees\//.test(ep)) return { tree: [{ type: 'blob', path: 'apps/dash/app.json' }] };
    if (/\/contents\//.test(ep)) return Buffer.from(JSON.stringify({ id: 'dash', title: 'Dash' }));
    return { default_branch: 'main' };
  };
  (ps.gh as any).api = api;
  return { db, ps, calls, setDown: (v: boolean) => (down = v) };
}

test('GitHub: CI merges check runs with commit statuses; trees are fetched once per sha', async () => {
  const t = projectCtx();
  await t.ps.refresh('github.com/o/r');
  const b = t.ps.branch('github.com/o/r#claude/x');
  assert.deepEqual({ state: b.ci.state, total: b.ci.total, passed: b.ci.passed, failed: b.ci.failed }, { state: 'failure', total: 2, passed: 1, failed: 1 });
  assert.equal(b.pr.number, 7);
  assert.deepEqual(b.apps, [{ path: 'apps/dash', id: 'dash', title: 'Dash' }]);
  const trees = () => t.calls.filter((x) => x.includes('/git/trees/')).length;
  assert.equal(trees(), 2, 'main and claude/x (neither checked out)');
  await t.ps.refresh('github.com/o/r');
  assert.equal(trees(), 2, 'same remote shas: app lists come from the cache');
});

test('GitHub: a failed list call keeps the last known branches, PR and CI, and marks the project stale', async () => {
  const t = projectCtx();
  await t.ps.refresh('github.com/o/r');
  const before = t.ps.branch('github.com/o/r#claude/x');
  const okAt = t.ps.project('github.com/o/r').githubAt;
  t.setDown(true);
  await t.ps.refresh('github.com/o/r');
  const after = t.ps.branch('github.com/o/r#claude/x');
  assert.ok(after, 'branch node kept');
  assert.deepEqual(after.pr, before.pr);
  assert.deepEqual(after.ci, before.ci);
  assert.deepEqual(after.apps, before.apps);
  assert.equal(after.remoteSha, 's2');
  const p = t.ps.project('github.com/o/r');
  assert.match(p.githubError, /502/);
  assert.equal(p.githubAt, okAt, 'stale since the last successful poll');
  assert.equal(t.db.all('SELECT id FROM branch').length, 2);
});

test('GitHub list paging stops at a short page and at the cap', async () => {
  const { ps } = projectCtx();
  const seen: string[] = [];
  (ps.gh as any).api = async (_a: string, ep: string) => {
    seen.push(ep);
    return Array.from({ length: 100 }, (_, i) => i);
  };
  const all = await ps.gh.list('p', GitHubAdapter.branches('o', 'r'), 3);
  assert.equal(all.length, 300);
  assert.deepEqual(seen.map((e) => e.match(/page=(\d+)$/)?.[1]), ['1', '2', '3']);
  (ps.gh as any).api = async (_a: string, ep: string) => (/page=1$/.test(ep) ? Array.from({ length: 100 }) : [1, 2]);
  assert.equal((await ps.gh.list('p', GitHubAdapter.branches('o', 'r'), 10)).length, 102);
  assert.equal(GitHubAdapter.ciState([], [{ state: 'pending' }]).state, 'pending');
  assert.equal(GitHubAdapter.ciState([{ status: 'completed', conclusion: 'success' }], [{ state: 'success' }]).state, 'success');
});
