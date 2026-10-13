import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, RateLimiter, type PolicyNode } from '../apps/policy.js';
import { validateManifest } from '../apps/manifest.js';

const manifest = validateManifest({
  id: 'winch-console', title: 'Winch', version: '0.3.0', server: { command: ['python3', 'server.py'] }, ui: 'ui://winch-console/main',
  tools: { read_status: { tier: 'read' }, set_speed: { tier: 'actuate', confirm: true, maxPerMinute: 3 }, stop: { tier: 'actuate', confirm: false } },
}).manifest!;

const preview: PolicyNode = { state: 'preview', version: 1, grantedVersion: null, manifest };
const promoted: PolicyNode = { state: 'promoted', version: 2, grantedVersion: 2, manifest };
const now = 1_000_000;

test('preview blocks every actuate tool, even unconfirmed stop', () => {
  const l = new RateLimiter();
  for (const t of ['set_speed', 'stop']) {
    const d = decide(preview, 'n', t, { confirmed: true, now }, l);
    assert.equal(d.allowed, false);
    assert.equal(!d.allowed && d.code, 'preview');
  }
  assert.equal(decide(preview, 'n', 'read_status', { confirmed: false, now }, l).allowed, true);
});

test('undeclared tools are refused in every state', () => {
  const l = new RateLimiter();
  for (const n of [preview, promoted]) {
    const d = decide(n, 'n', 'format_disk', { confirmed: true, now }, l);
    assert.equal(!d.allowed && d.code, 'undeclared');
  }
});

test('promoted but not granted for this version is refused', () => {
  const d = decide({ ...promoted, version: 3 }, 'n', 'stop', { confirmed: true, now }, new RateLimiter());
  assert.equal(!d.allowed && d.code, 'not_granted');
  const d2 = decide({ ...promoted, grantedVersion: null }, 'n', 'stop', { confirmed: true, now }, new RateLimiter());
  assert.equal(!d2.allowed && d2.code, 'not_granted');
});

test('confirm required for set_speed; stop is unconfirmed by design', () => {
  const l = new RateLimiter();
  const d = decide(promoted, 'n', 'set_speed', { confirmed: false, now }, l);
  assert.equal(!d.allowed && d.code, 'needs_confirm');
  assert.equal(decide(promoted, 'n', 'set_speed', { confirmed: true, now }, l).allowed, true);
  assert.equal(decide(promoted, 'n', 'stop', { confirmed: false, now }, l).allowed, true);
});

test('rate limit per tool per node, sliding minute; refused calls do not consume budget', () => {
  const l = new RateLimiter();
  // unconfirmed attempts must not count against the limit
  for (let i = 0; i < 5; i++) decide(promoted, 'n', 'set_speed', { confirmed: false, now }, l);
  for (let i = 0; i < 3; i++) assert.equal(decide(promoted, 'n', 'set_speed', { confirmed: true, now: now + i }, l).allowed, true);
  const d = decide(promoted, 'n', 'set_speed', { confirmed: true, now: now + 10 }, l);
  assert.equal(!d.allowed && d.code, 'rate_limited');
  // other node and other tool unaffected
  assert.equal(decide(promoted, 'other', 'set_speed', { confirmed: true, now: now + 10 }, l).allowed, true);
  assert.equal(decide(promoted, 'n', 'stop', { confirmed: false, now: now + 10 }, l).allowed, true);
  // window slides
  assert.equal(decide(promoted, 'n', 'set_speed', { confirmed: true, now: now + 60_001 }, l).allowed, true);
});

test('device locks: agents must hold the lock; another holder blocks agents; the human is never blocked', () => {
  const l = new RateLimiter();
  const agent = { kind: 'agent' as const, id: 'cc-1' };
  const user = { kind: 'user' as const, id: 'hub-user' };
  const free = [{ device: 'mini-1:winch', title: 'Winch', holder: null }];
  const mine = [{ device: 'mini-1:winch', title: 'Winch', holder: 'cc-1' }];
  const other = [{ device: 'mini-1:winch', title: 'Winch', holder: 'cx-9', holderLabel: 'codex session "x"' }];
  let d = decide(promoted, 'n', 'stop', { confirmed: true, now, caller: agent, locks: free }, l);
  assert.equal(!d.allowed && d.code, 'locked');
  d = decide(promoted, 'n', 'stop', { confirmed: true, now, caller: agent, locks: other }, l);
  assert.equal(!d.allowed && d.code, 'locked');
  assert.equal(decide(promoted, 'n', 'stop', { confirmed: true, now, caller: agent, locks: mine }, l).allowed, true);
  const u = decide(promoted, 'n', 'stop', { confirmed: false, now, caller: user, locks: other }, l);
  assert.equal(u.allowed, true);
  assert.match(u.reason, /overrides lock/);
  // locks never unlock what preview forbids
  assert.equal(decide(preview, 'n', 'stop', { confirmed: true, now, caller: user, locks: mine }, l).allowed, false);
});
