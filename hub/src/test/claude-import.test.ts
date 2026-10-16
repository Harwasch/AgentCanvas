import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Db } from '../db.js';
import { EventBus } from '../events.js';
import { Store } from '../store.js';
import { ClaudeDriver, ReadOnlyError } from '../claude/driver.js';
import { ClaudeImporter, importAction, importTitle, readFrom, remoteOwner, FIRST_LINES, type ScanRec } from '../claude/importer.js';
import { HOST_FILES } from '../bootstrap.js';

const UUID = '22ba2d51-da0c-47de-818f-0c866ad84bc4';
const rec = (o: Partial<ScanRec> = {}): ScanRec => ({
  file: `/h/.claude/projects/-h-code-x/${UUID}.jsonl`, sessionId: UUID, mtime: Date.now(), size: 100, lines: 3,
  cwd: '/h/code/x', branch: 'main', entrypoint: 'claude-desktop', title: null, firstPrompt: 'fix the winch', ...o,
});

test('import decision: recent and unknown → new; hub-owned, hidden, old or empty → skip; imported → update', () => {
  const since = Date.now() - 86400_000;
  assert.equal(importAction(rec(), undefined, since), 'new');
  assert.equal(importAction(rec({ mtime: since - 1 }), undefined, since), 'skip', 'older than the window');
  assert.equal(importAction(rec({ cwd: null }), undefined, since), 'skip');
  assert.equal(importAction(rec({ lines: 0 }), undefined, since), 'skip');
  assert.equal(importAction(rec({ sessionId: 'agent-1234' }), undefined, since), 'skip', 'not a session uuid');
  const hub = { meta: { tmux: 'cc-1' } } as any;
  assert.equal(importAction(rec(), hub, since), 'skip', 'started or taken over by the hub');
  assert.equal(importAction(rec(), { meta: { external: true, hidden: true } } as any, since), 'skip');
  assert.equal(importAction(rec({ mtime: since - 1 }), { meta: { external: true } } as any, since), 'update', 'already shown: keeps updating');
});

test('import title, first lines to read, GitHub owner', () => {
  assert.equal(importTitle(rec({ title: 'Benchtop  control\npanel' })), 'Benchtop control panel');
  assert.equal(importTitle(rec()), 'fix the winch');
  assert.equal(importTitle(rec({ firstPrompt: null })), 'Claude · x');
  assert.equal(readFrom(rec({ lines: 1000 }), undefined), 1000 - FIRST_LINES);
  assert.equal(readFrom(rec({ lines: 10 }), undefined), 0);
  assert.equal(readFrom(rec({ lines: 10 }), 7), 7);
  assert.equal(readFrom(rec({ lines: 10 }), 12), 10, 'a shorter file (rewritten) never reads past its end');
  assert.equal(remoteOwner('https://github.com/Ulysses-Ecosystem-Engineering/HoG-Winch.git'), 'Ulysses-Ecosystem-Engineering');
  assert.equal(remoteOwner('git@github.com:harwasch/AgentCanvas.git'), 'harwasch');
  assert.equal(remoteOwner(null), undefined);
});

const line = (o: object) => JSON.stringify(o) + '\n';
const userLine = (text: string, uuid: string) => line({ type: 'user', uuid, sessionId: UUID, message: { role: 'user', content: text } });
const asstLine = (text: string, uuid: string) => line({ type: 'assistant', uuid, sessionId: UUID, message: { role: 'assistant', content: [{ type: 'text', text }] } });

function importerCtx(transcript: string, scan: ScanRec[]) {
  const db = new Db(':memory:');
  const bus = new EventBus();
  const store = new Store(db, bus);
  const cmds: string[] = [];
  const c: any = {
    db, bus, store,
    cfg: {
      claudeImportDays: 2, claudeImportIntervalSec: 30, hosts: [{ id: 'h1' }],
      accounts: [{ id: 'personal', claude: { configDir: '~/.claude' } }, { id: 'work', claude: { configDir: '~/.claude' } }],
    },
    boot: { ensure: async () => ({ home: '/h', base: '/h/.agent-hub' }) },
    hosts: {
      row: () => ({ status: 'online' }),
      bin: () => 'python3',
      exec: async (_h: string, cmd: string) => {
        cmds.push(cmd);
        if (cmd.includes('claude-scan')) return { code: 0, stdout: JSON.stringify(scan), stderr: '' };
        const m = cmd.match(/tail -n \+(\d+) .* \| head -n (\d+)/);
        const all = transcript.split('\n').slice(0, -1);
        return { code: 0, stdout: all.slice(Number(m![1]) - 1, Number(m![1]) - 1 + Number(m![2])).map((l) => l + '\n').join(''), stderr: '' };
      },
    },
    repos: { checkoutForPath: () => ({ id: 'h1:/h/code/x', remote_url: 'https://github.com/Ulysses-Ecosystem-Engineering/x.git' }) },
    projects: { gh: { accountFor: (o: string) => (o === 'Ulysses-Ecosystem-Engineering' ? { id: 'work' } : { id: 'personal' }) } },
  };
  c.claude = new ClaudeDriver(c);
  return { c, store, cmds, imp: new ClaudeImporter(c) };
}

test('importer: a Claude app session becomes a read-only node under the repo owner\'s account, with its messages', async () => {
  const t = userLine('fix the winch', 'u1') + asstLine('On it.', 'a1') + asstLine('Done.', 'a2');
  const { store, cmds, imp } = importerCtx(t, [rec({ lines: 3, mtime: Date.now() - 600_000 })]);
  await imp.scanAll();
  const s = store.sessionByNative(UUID)!;
  assert.ok(s, 'imported');
  assert.equal(s.meta.external, true);
  assert.equal(s.meta.source, 'claude-desktop');
  assert.equal(s.account_id, 'work', 'Ulysses repo → work account, though both accounts share ~/.claude');
  assert.equal(s.checkout_id, 'h1:/h/code/x');
  assert.equal(s.status, 'idle', 'not written to in the last 90 s');
  assert.equal(s.meta.tLines, 3);
  assert.deepEqual(store.messages(s.id).map((m) => [m.role, m.text]), [['user', 'fix the winch'], ['assistant', 'On it.'], ['assistant', 'Done.']]);
  assert.match(cmds[0], /hub_channel\.py' claude-scan '\/h\/\.claude\/projects' \d+$/, 'one scan per shared profile dir');
  assert.equal(cmds.filter((x) => x.includes('claude-scan')).length, 1);

  // unchanged file: no re-read
  const n = cmds.length;
  await imp.scanAll();
  assert.equal(cmds.length, n + 1, 'only the scan ran');
});

test('importer: new lines are appended, a hub-owned or hidden session is left alone', async () => {
  let t = userLine('fix the winch', 'u1');
  const scan = [rec({ lines: 1, size: 10 })];
  const { store, imp } = importerCtx('', scan);
  const ctx = (imp as any).c;
  ctx.hosts.exec = async (_h: string, cmd: string) => {
    if (cmd.includes('claude-scan')) return { code: 0, stdout: JSON.stringify(scan), stderr: '' };
    const m = cmd.match(/tail -n \+(\d+) .* \| head -n (\d+)/)!;
    const all = t.split('\n').slice(0, -1);
    return { code: 0, stdout: all.slice(Number(m[1]) - 1, Number(m[1]) - 1 + Number(m[2])).map((l) => l + '\n').join(''), stderr: '' };
  };
  await imp.scanAll();
  const id = store.sessionByNative(UUID)!.id;
  assert.equal(store.session(id)!.status, 'running', 'written to just now');
  t += asstLine('Winch fixed.', 'a1');
  scan[0] = rec({ lines: 2, size: 20 });
  await imp.scanAll();
  assert.deepEqual(store.messages(id).map((m) => m.text), ['fix the winch', 'Winch fixed.']);
  assert.equal(store.session(id)!.meta.tLines, 2);

  // you hid it: later activity does not bring it back
  await ctx.claude.stop(id);
  assert.equal(store.session(id)!.status, 'ended');
  t += asstLine('More.', 'a2');
  scan[0] = rec({ lines: 3, size: 30 });
  await imp.scanAll();
  assert.equal(store.messages(id).length, 2);
});

test('read-only: chat, interrupt and settings are refused; recovery and liveness ignore imported sessions', async () => {
  const { c, store } = importerCtx('', []);
  store.upsertSession({ id: 'cc-ext', vendor: 'claude', kind: 'local', host_id: 'h1', account_id: 'personal', title: 'x', status: 'idle', native_id: UUID, meta: { external: true } } as any);
  await assert.rejects(c.claude.send('cc-ext', 'hi'), ReadOnlyError);
  await assert.rejects(c.claude.interrupt('cc-ext'), ReadOnlyError);
  await assert.rejects(c.claude.settings('cc-ext', { model: 'opus' }), ReadOnlyError);
  c.hosts.exec = async () => ({ code: 0, stdout: '', stderr: '' }); // tmux would say "gone" for everything
  await c.claude.recover('h1');
  assert.equal(store.session('cc-ext')!.status, 'idle', 'not ended: it has no tmux of ours');
});

test('take over: `claude --resume <uuid>` in the same row, which stops being read-only and keeps its transcript position', async () => {
  const { c, store } = importerCtx('', []);
  store.upsertSession({
    id: 'cc-ext', vendor: 'claude', kind: 'local', host_id: 'h1', account_id: 'work', checkout_id: 'h1:/h/code/x', cwd: '/h/code/x', branch: 'main',
    title: 'Benchtop control panel', status: 'idle', native_id: UUID, meta: { external: true, source: 'claude-desktop', transcript: `/h/.claude/projects/-h-code-x/${UUID}.jsonl`, tLines: 175 },
  } as any);
  const ran: string[] = [];
  c.secrets = { hookToken: 'k' };
  c.account = (id: string) => c.cfg.accounts.find((a: any) => a.id === id);
  c.hosts.bin = (_h: string, b: string) => (b === 'claude' ? '/h/.local/bin/claude' : b);
  c.hosts.put = async () => {};
  c.hosts.execOk = async (_h: string, cmd: string) => { ran.push(cmd); return ''; };
  c.claude.attach = () => {};
  c.claude.afterLaunch = async () => {};
  await assert.rejects(c.claude.takeover('nope'), /only sessions started outside the hub/);
  const s = await c.claude.takeover('cc-ext');
  assert.equal(s.id, 'cc-ext', 'same canvas node');
  assert.equal(s.meta.external, false);
  assert.equal(s.meta.tLines, 175, 'the hub tail continues after the imported lines');
  assert.equal(s.meta.transcript, `/h/.claude/projects/-h-code-x/${UUID}.jsonl`);
  assert.equal(s.title, 'Benchtop control panel');
  assert.match(ran[0], new RegExp(`--resume \\S*${UUID}`), 'resumes the same Claude session id');
  assert.match(ran[0], /new-session -d -s 'cc-ext'/);
  assert.equal(store.sessionByNative(UUID)!.id, 'cc-ext');
});

test('hub_channel.py claude-scan: recent top-level transcripts only, with title, cwd, branch, origin and complete lines', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cscan-'));
  const proj = path.join(root, 'projects', '-h-code-x');
  fs.mkdirSync(path.join(proj, UUID, 'subagents'), { recursive: true });
  const meta = { cwd: '/h/code/x', gitBranch: 'dev', entrypoint: 'claude-desktop', sessionId: UUID };
  fs.writeFileSync(path.join(proj, `${UUID}.jsonl`),
    line({ type: 'mode', sessionId: UUID }) +
    line({ type: 'user', ...meta, isMeta: true, message: { content: '<command-name>/clear</command-name>' } }) +
    line({ type: 'user', ...meta, message: { content: [{ type: 'text', text: 'fix the winch' }] } }) +
    line({ type: 'custom-title', customTitle: 'Winch fix', sessionId: UUID }) +
    '{"type":"assistant","partial');
  fs.writeFileSync(path.join(proj, UUID, 'subagents', 'agent-1.jsonl'), line({ type: 'user', ...meta }));
  const old = path.join(proj, '11111111-1111-1111-1111-111111111111.jsonl');
  fs.writeFileSync(old, line({ type: 'user', ...meta }));
  const t = Date.now() / 1000 - 5 * 86400;
  fs.utimesSync(old, t, t);
  const out = JSON.parse(execFileSync('python3', [path.join(HOST_FILES, 'hub_channel.py'), 'claude-scan', path.join(root, 'projects'), String(Date.now() - 2 * 86400_000)], { env: { PATH: process.env.PATH!, HOME: root } }).toString());
  assert.equal(out.length, 1, 'old and subagent transcripts are left out');
  assert.equal(out[0].sessionId, UUID);
  assert.equal(out[0].lines, 4, 'a half-written last line is not counted');
  assert.deepEqual([out[0].cwd, out[0].branch, out[0].entrypoint, out[0].title, out[0].firstPrompt], ['/h/code/x', 'dev', 'claude-desktop', 'Winch fix', 'fix the winch']);
  assert.equal(JSON.parse(execFileSync('python3', [path.join(HOST_FILES, 'hub_channel.py'), 'claude-scan', path.join(root, 'nope'), '0']).toString()).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
