import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { claudeHookSettings, HOST_FILES } from '../bootstrap.js';

test('hooks are command hooks through hub_channel.py (HTTP hooks cannot reach tailnet addresses)', () => {
  const s = claudeHookSettings('/usr/bin/python3', '/home/h/.agent-hub/hub_channel.py');
  for (const [ev, groups] of Object.entries(s.hooks)) {
    const h = groups[0].hooks[0];
    assert.equal(h.type, 'command', ev);
    assert.match(h.command, /^'\/usr\/bin\/python3' '\/home\/h\/\.agent-hub\/hub_channel\.py' hook \d+$/);
    // the script gives up before Claude does
    assert.equal(h.command.endsWith(` hook ${h.timeout - 5}`), true, ev);
  }
  assert.equal(s.hooks.PermissionRequest[0].hooks[0].timeout, 130);
  assert.ok(s.permissions.allow.every((n: string) => n.startsWith('mcp__hub__')));
});

function runHook(env: Record<string, string>, payload: object): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('python3', [path.join(HOST_FILES, 'hub_channel.py'), 'hook', '5'], { env: { PATH: process.env.PATH!, HOME: env.HOME, ...env } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(JSON.stringify(payload));
  });
}

test('hub_channel.py hook: forwards payload and both tokens, prints the answer; failures exit 1, never 2', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hookhome-'));
  const seen: any[] = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, stok: req.headers['x-hub-session-token'], body: JSON.parse(b) });
      if (req.headers.authorization !== 'Bearer host-tok') return res.writeHead(403).end('no');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    const ok = await runHook({ HOME: home, HUB_URL: url, HUB_HOOK_TOKEN: 'host-tok', HUB_SESSION_TOKEN: 'sess-tok' }, { hook_event_name: 'PermissionRequest', session_id: 'u1' });
    assert.equal(ok.code, 0);
    assert.equal(JSON.parse(ok.out).hookSpecificOutput.decision.behavior, 'allow');
    assert.deepEqual(seen[0], { url: '/hooks/claude', auth: 'Bearer host-tok', stok: 'sess-tok', body: { hook_event_name: 'PermissionRequest', session_id: 'u1' } });

    const refused = await runHook({ HOME: home, HUB_URL: url, HUB_HOOK_TOKEN: 'wrong' }, { hook_event_name: 'Stop', session_id: 'u1' });
    assert.equal(refused.code, 1);
    assert.equal(seen[1].stok, undefined);
    assert.match(refused.err, /hub hook 403/);
  } finally {
    srv.close();
  }
  const down = await runHook({ HOME: home, HUB_URL: url, HUB_HOOK_TOKEN: 'host-tok' }, { hook_event_name: 'Stop', session_id: 'u1' });
  assert.equal(down.code, 1);
  assert.match(down.err, /hub unreachable/);
  fs.rmSync(home, { recursive: true, force: true });
});
