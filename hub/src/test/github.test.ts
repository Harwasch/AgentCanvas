import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubAdapter } from '../adapters.js';
import { fileKind, safePath, parseSource } from '../files.js';

test('GitHub remote parsing: https, scp-style, ssh://, per-account host aliases; non-GitHub → undefined', () => {
  assert.deepEqual(GitHubAdapter.parseRemote('https://github.com/agent-hub-test/hexapod-robot.git'), { owner: 'agent-hub-test', repo: 'hexapod-robot' });
  assert.deepEqual(GitHubAdapter.parseRemote('https://github.com/o/r'), { owner: 'o', repo: 'r' });
  assert.deepEqual(GitHubAdapter.parseRemote('git@github.com:o/r.git'), { owner: 'o', repo: 'r' });
  assert.deepEqual(GitHubAdapter.parseRemote('git@github.com-work:corp/wpt.charger.git'), { owner: 'corp', repo: 'wpt.charger' });
  assert.deepEqual(GitHubAdapter.parseRemote('ssh://git@github.com/o/r.git'), { owner: 'o', repo: 'r' });
  assert.equal(GitHubAdapter.parseRemote('file:///srv/x.git'), undefined);
  assert.equal(GitHubAdapter.parseRemote('https://gitlab.com/o/r.git'), undefined);
  assert.equal(GitHubAdapter.parseRemote(null), undefined);
});

test('PR state and CI rollup', () => {
  const pr = (o: any) => ({ number: 1, title: '', state: 'open', draft: false, merged_at: null, html_url: '', head: { ref: 'x', sha: null }, base: { ref: 'main' }, ...o });
  assert.equal(GitHubAdapter.prState(pr({})), 'open');
  assert.equal(GitHubAdapter.prState(pr({ draft: true })), 'draft');
  assert.equal(GitHubAdapter.prState(pr({ state: 'closed', merged_at: '2026-01-01' })), 'merged');
  assert.equal(GitHubAdapter.prState(pr({ state: 'closed' })), 'closed');
  const run = (status: string, conclusion: string | null) => ({ status, conclusion });
  assert.deepEqual(GitHubAdapter.ciState([]), { state: 'none', total: 0, passed: 0, failed: 0 });
  assert.equal(GitHubAdapter.ciState([run('completed', 'success'), run('in_progress', null)]).state, 'pending');
  assert.equal(GitHubAdapter.ciState([run('completed', 'success'), run('completed', 'skipped')]).state, 'success');
  assert.deepEqual(GitHubAdapter.ciState([run('completed', 'success'), run('completed', 'failure'), run('queued', null)]), { state: 'failure', total: 3, passed: 1, failed: 1 });
});

test('file paths are confined to the repo; kinds by extension', () => {
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../b', 'a//b', 'a\0b']) assert.throws(() => safePath(bad));
  assert.equal(safePath('AI/reports/x.md'), 'AI/reports/x.md');
  assert.equal(fileKind('README.md'), 'doc');
  assert.equal(fileKind('AI/sim/gait.PNG'), 'image');
  assert.equal(fileKind('HW/leg/femur.stl'), 'model3d');
  assert.equal(fileKind('fw/current_loop.c'), 'code');
  assert.equal(fileKind('Makefile'), 'code');
  assert.equal(fileKind('data.bin'), 'binary');
  assert.throws(() => parseSource('{"kind":"checkout"}'));
  assert.deepEqual(parseSource({ kind: 'github', projectId: 'p', ref: 'main' }), { kind: 'github', projectId: 'p', ref: 'main' });
});
