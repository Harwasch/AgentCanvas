import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, checkUiOrigins, cspHeader } from '../apps/manifest.js';

const WINCH = {
  id: 'winch-console', title: 'Winch console', version: '0.3.0', runsOn: 'minipc-a', account: 'personal',
  server: { command: ['uv', 'run', 'server.py'], transport: 'stdio' },
  ui: 'ui://winch-console/main', lifecycle: 'always-on', csp: { connect: [], img: [] },
  tools: { read_status: { tier: 'read' }, set_speed: { tier: 'actuate', confirm: true, maxPerMinute: 10 }, stop: { tier: 'actuate', confirm: false } },
  node: { width: 640, height: 420 },
};

test('the architecture doc example validates', () => {
  const r = validateManifest(WINCH);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.manifest!.tools.stop.confirm, false, 'stop stays unconfirmed by design');
  assert.equal(r.manifest!.tools.set_speed.maxPerMinute, 10);
});

test('every tool needs a tier', () => {
  const r = validateManifest({ ...WINCH, tools: { ...WINCH.tools, jog: { confirm: true } } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /tools\.jog\.tier/);
});

test('invalid tier value is rejected', () => {
  const r = validateManifest({ ...WINCH, tools: { stop: { tier: 'admin' } } });
  assert.equal(r.ok, false);
});

test('actuate without explicit confirm defaults to confirm=true', () => {
  const r = validateManifest({ ...WINCH, tools: { set_speed: { tier: 'actuate' } } });
  assert.equal(r.ok, true);
  assert.equal(r.manifest!.tools.set_speed.confirm, true);
  assert.ok(r.warnings.some((w) => w.includes('set_speed')));
});

test('unknown keys and wrong ui namespace are errors', () => {
  assert.equal(validateManifest({ ...WINCH, privileged: true }).ok, false);
  assert.equal(validateManifest({ ...WINCH, ui: 'ui://other-app/main' }).ok, false);
  assert.equal(validateManifest({ ...WINCH, ui: 'https://evil.example/ui' }).ok, false);
});

test('csp entries must be bare https/wss origins', () => {
  assert.equal(validateManifest({ ...WINCH, csp: { connect: ['https://api.example.com'], img: [] } }).ok, true);
  assert.equal(validateManifest({ ...WINCH, csp: { connect: ['*'], img: [] } }).ok, false);
  assert.equal(validateManifest({ ...WINCH, csp: { connect: ['http://api.example.com'], img: [] } }).ok, false);
  assert.equal(validateManifest({ ...WINCH, csp: { connect: ['https://api.example.com/path'], img: [] } }).ok, false);
});

test('bad lifecycle, version, id, sizes', () => {
  assert.equal(validateManifest({ ...WINCH, lifecycle: 'forever' }).ok, false);
  assert.equal(validateManifest({ ...WINCH, version: 'v1' }).ok, false);
  assert.equal(validateManifest({ ...WINCH, id: 'Winch Console' }).ok, false);
  assert.equal(validateManifest({ ...WINCH, node: { width: 10, height: 420 } }).ok, false);
  assert.equal(validateManifest({ ...WINCH, server: { command: [] } }).ok, false);
});

test('static UI-only apps: uiFile, no server, no tools', () => {
  const s = { id: 'notes', title: 'Notes', version: '1.0.0', ui: 'ui://notes/main', uiFile: 'index.html', lifecycle: 'static' };
  assert.equal(validateManifest(s).ok, true);
  assert.equal(validateManifest({ ...s, tools: { x: { tier: 'read' } } }).ok, false);
  assert.equal(validateManifest({ ...s, uiFile: '../../etc/passwd' }).ok, false);
});

test('non-object input', () => {
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest([]).ok, false);
  assert.equal(validateManifest('{}').ok, false);
});

test('UI origin check flags undeclared external loads', () => {
  const csp = { connect: ['https://api.example.com'], img: ['https://img.example.com'] };
  assert.deepEqual(checkUiOrigins('<img src="https://img.example.com/a.png"><script>fetch("https://api.example.com/x")</script>', csp), []);
  const errs = checkUiOrigins('<script src="https://cdn.evil.example/x.js"></script><link href="https://fonts.example/f.css" rel=stylesheet><style>@import "https://x.example/y.css";</style><script>new WebSocket("wss://ws.example")</script>', csp);
  assert.equal(errs.length, 4, errs.join('\n'));
  assert.deepEqual(checkUiOrigins('<a href="https://docs.example.com">docs</a><img src="data:image/png;base64,AA">', csp), []);
  assert.equal(checkUiOrigins('<img src="//cdn.evil.example/x.png">', csp).length, 1);
});

test('wildcard subdomain origin matches subdomains only', () => {
  const csp = { connect: ['https://*.example.com'], img: [] };
  assert.deepEqual(checkUiOrigins('<script src="https://a.example.com/x.js"></script>', csp), []);
  assert.equal(checkUiOrigins('<script src="https://example.com.evil.net/x.js"></script>', csp).length, 1);
});

test('CSP header is deny-by-default', () => {
  const h = cspHeader({ connect: [], img: [] });
  assert.match(h, /default-src 'none'/);
  assert.match(h, /connect-src 'none'/);
});
