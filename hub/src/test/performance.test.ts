import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Db } from '../db.js';
import { EventBus, type HubEvent } from '../events.js';
import { Store, clipTail, OUTPUT_TAIL, TRUNCATED } from '../store.js';
import { Limiter } from '../ssh.js';
import { prune, inStateWhere } from '../retention.js';
import { CanvasService } from '../canvas.js';
import { ComputeService } from '../compute.js';
import { ClaudeDriver } from '../claude/driver.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function base(opts: { appendMs?: number; persistMs?: number } = { appendMs: 20, persistMs: 60 }) {
  const db = new Db(':memory:');
  const bus = new EventBus();
  const store = new Store(db, bus, opts);
  const events: HubEvent[] = [];
  bus.on('event', (ev: HubEvent) => events.push(ev));
  return { db, bus, store, events };
}
const RET = { messagesDays: 30, auditDays: 90, approvalsDays: 7, stateEndedDays: 7, intervalMin: 60 };
const DAY = 86_400_000;

// ------------------------------------------------------------------ streaming deltas
test('deltas: the first creates the message, the rest are coalesced into ordered message.append events with offsets', async () => {
  const { db, store, events } = base();
  store.appendDelta('m1', 's1', 'Hel', { role: 'assistant', kind: 'text' });
  store.appendDelta('m1', 's1', 'lo');
  store.appendDelta('m1', 's1', ', ');
  assert.deepEqual(events.map((e) => e.type), ['message.upsert'], 'nothing more until the coalescing window closes');
  assert.equal(events[0].data.text, 'Hel');
  await sleep(40);
  assert.deepEqual(events.slice(1).map((e) => [e.type, e.data.append, e.data.at]), [['message.append', 'lo, ', 3]]);
  store.appendDelta('m1', 's1', 'world');
  await sleep(40);
  assert.deepEqual(events.slice(2).map((e) => [e.type, e.data.append, e.data.at, e.data.seq]), [['message.append', 'world', 7, 1]]);
  // persisted by the throttled write (not per delta), and a read includes everything streamed so far
  await sleep(80);
  assert.equal(db.get("SELECT text FROM message WHERE id='m1'")!.text, 'Hello, world');
  store.appendDelta('m1', 's1', '!');
  assert.equal(store.messages('s1')[0].text, 'Hello, world!', 'a read flushes the open stream');
  // reassembling the wire events gives the stored text
  let text = '';
  for (const e of events) text = e.type === 'message.upsert' ? e.data.text : text.slice(0, e.data.at) + e.data.append;
  assert.equal(text, 'Hello, world!');
});

test('a full upsert ends the stream: pending text is published first, nothing is appended afterwards', async () => {
  const { store, events } = base();
  store.appendDelta('m2', 's1', 'a');
  store.appendDelta('m2', 's1', 'b');
  store.upsertMessage({ id: 'm2', session_id: 's1', role: 'assistant', kind: 'text', text: 'ab', data: null });
  await sleep(100);
  assert.deepEqual(events.map((e) => e.type), ['message.upsert', 'message.append'], 'the final upsert equals the streamed text: not republished');
  store.upsertMessage({ id: 'm2', session_id: 's1', role: 'assistant', kind: 'text', text: 'abc', data: null });
  assert.equal(events.at(-1)!.type, 'message.upsert');
  assert.equal(events.at(-1)!.data.text, 'abc');
});

test('an unchanged message (replay of a transcript or thread) is neither written nor republished', () => {
  const { store, events } = base();
  const m = { id: 'm3', session_id: 's1', role: 'user' as const, kind: 'text' as const, text: 'hi', data: { via: 'channel' } };
  store.upsertMessage(m);
  store.upsertMessage({ ...m });
  assert.equal(events.length, 1);
  store.upsertMessage({ ...m, data: { via: 'hook' } });
  assert.equal(events.length, 2);
});

// ------------------------------------------------------------------ command output tail
test('command output keeps only the last 64 KB behind a marker, in SQLite and on the wire', async () => {
  const { db, store, events } = base();
  const chunk = (i: number) => `${String(i).padStart(4, '0')}${'x'.repeat(1019)}\n`; // 1 KB each
  store.upsertMessage({ id: 'c1', session_id: 's1', role: 'tool', kind: 'command', text: 'make', data: { status: 'inProgress' } });
  for (let i = 0; i < 100; i++) store.appendOutput('c1', 's1', chunk(i));
  await sleep(120);
  const data = JSON.parse(db.get("SELECT data FROM message WHERE id='c1'")!.data);
  assert.ok(data.output.startsWith(TRUNCATED));
  assert.equal(data.output.length, OUTPUT_TAIL + TRUNCATED.length);
  assert.ok(data.output.endsWith(chunk(99)));
  assert.equal(data.outputLen, 100 * 1024);
  assert.equal(data.status, 'inProgress', 'other fields are kept');
  const appends = events.filter((e) => e.type === 'message.append');
  assert.equal(appends.length, 1);
  assert.equal(appends[0].data.reset, true, 'more than the tail arrived in one window: clients replace the output');
  assert.equal(appends[0].data.append, data.output);
  assert.ok(events.every((e) => JSON.stringify(e).length < OUTPUT_TAIL + 2048), 'no event carries more than the tail');
  // small appends after that are plain appends with offsets into the full output
  store.appendOutput('c1', 's1', 'tail\n');
  await sleep(40);
  assert.deepEqual([events.at(-1)!.data.append, events.at(-1)!.data.at, events.at(-1)!.data.field], ['tail\n', 100 * 1024, 'output']);
});

test('clipTail: clipping in pieces equals clipping the whole, and is idempotent', () => {
  const a = 'a'.repeat(OUTPUT_TAIL - 10), b = 'b'.repeat(500), c = 'c'.repeat(OUTPUT_TAIL + 7);
  assert.equal(clipTail(clipTail(a + b) + c), clipTail(a + b + c));
  assert.equal(clipTail(clipTail(a) + b), clipTail(a + b));
  assert.equal(clipTail(clipTail(a + b)), clipTail(a + b));
  assert.equal(clipTail('short'), 'short');
});

// ------------------------------------------------------------------ replay ring
test('the replay ring is bounded by bytes; a client whose since fell out of it gets a resync', () => {
  const bus = new EventBus({ maxBytes: 20_000 });
  for (let i = 0; i < 200; i++) bus.publish('message.append', { id: 'm', append: 'x'.repeat(400) });
  assert.ok(bus.ringBytes <= 20_000, `ring holds ${bus.ringBytes} bytes`);
  assert.ok(bus.oldest() > 1);
  assert.equal(bus.hello(1, null, 'b1').resync, true, 'events after since=1 were dropped');
  assert.equal(bus.hello(bus.seq - 3, 'b1', 'b1').resync, false);
  assert.equal(bus.hello(bus.seq - 3, 'b0', 'b1').resync, true, 'another hub run');
  assert.equal(bus.hello(bus.seq + 5, null, 'b1').resync, true);
  const missed = bus.sinceJson(bus.seq - 3);
  assert.deepEqual(missed.map((k) => JSON.parse(k.json).seq), [bus.seq - 2, bus.seq - 1, bus.seq]);
  // the count bound still applies
  const small = new EventBus({ maxEvents: 100 });
  for (let i = 0; i < 250; i++) small.publish('x', i);
  assert.ok(small.since(0).length <= 100);
  assert.equal(small.since(0).at(-1)!.data, 249);
});

// ------------------------------------------------------------------ statements
test('statements are prepared once per SQL text and reused (bounded cache)', () => {
  const db = new Db(':memory:');
  const n0 = db.cachedStatements;
  for (let i = 0; i < 5; i++) db.get('SELECT ? AS v', i);
  assert.equal(db.cachedStatements, n0 + 1);
  assert.equal(db.stmt('SELECT ? AS v'), db.stmt('SELECT ? AS v'));
  assert.equal(db.get('SELECT ? AS v', 7)!.v, 7);
  for (let i = 0; i < Db.STMT_CACHE + 20; i++) db.get(`SELECT ${i} AS v`);
  assert.equal(db.cachedStatements, Db.STMT_CACHE);
});

// ------------------------------------------------------------------ retention
test('retention prunes old messages of ended sessions, old audit rows and old decided approvals; state leaves out old ended sessions', () => {
  const { db, store } = base();
  const now = Date.now();
  const sess = (id: string, status: string, age: number) => db.upsert('session', { id, vendor: 'claude', kind: 'local', status, title: id, created_at: now - age, updated_at: now - age, meta: '{}' });
  sess('old-ended', 'ended', 40 * DAY);
  sess('recent-ended', 'ended', 10 * DAY);
  sess('old-running', 'running', 40 * DAY);
  for (const s of ['old-ended', 'recent-ended', 'old-running']) db.upsert('message', { id: `m-${s}`, session_id: s, seq: 1, role: 'user', kind: 'text', text: 'x', created_at: now - 40 * DAY });
  const audit = (age: number) => db.run('INSERT INTO audit (ts, tool, allowed) VALUES (?, ?, 1)', now - age, 't');
  audit(100 * DAY); audit(10 * DAY);
  const appr = (id: string, status: string, age: number) => db.upsert('approval', { id, session_id: 'x', source: 'codex', status, created_at: now - age, resolved_at: status === 'pending' ? null : now - age });
  appr('old-allow', 'allow', 8 * DAY); appr('old-expired', 'expired', 9 * DAY); appr('new-deny', 'deny', 1 * DAY); appr('old-pending', 'pending', 30 * DAY);
  assert.deepEqual(prune(db, RET, now), { messages: 1, audit: 1, approvals: 2 });
  assert.deepEqual(db.all('SELECT id FROM message ORDER BY id').map((r) => r.id), ['m-old-running', 'm-recent-ended']);
  assert.deepEqual(db.all('SELECT id FROM approval ORDER BY id').map((r) => r.id), ['new-deny', 'old-pending']);
  assert.deepEqual(store.sessions(...inStateWhere(RET, now)).map((s) => s.id).sort(), ['old-running']);
  assert.deepEqual(store.sessions(...inStateWhere({ ...RET, stateEndedDays: 30 }, now)).map((s) => s.id).sort(), ['old-running', 'recent-ended']);
});

// ------------------------------------------------------------------ ssh exec limiter
test('the per-host limiter runs at most N execs at once and starts the rest in order', async () => {
  const lim = new Limiter(2);
  let active = 0, peak = 0;
  const started: number[] = [];
  const gates: (() => void)[] = [];
  const task = (i: number) => lim.run(async () => {
    started.push(i);
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((r) => gates.push(r));
    active--;
    return i;
  });
  const all = Promise.all([0, 1, 2, 3, 4].map(task));
  await sleep(5);
  assert.deepEqual(started, [0, 1]);
  assert.equal(lim.waiting, 3);
  gates.shift()!();
  await sleep(5);
  assert.deepEqual(started, [0, 1, 2]);
  while (gates.length || started.length < 5) { gates.shift()?.(); await sleep(2); }
  assert.deepEqual(await all, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.equal(lim.running, 0);
  // a failing task frees its slot
  await assert.rejects(lim.run(async () => { throw new Error('boom'); }));
  assert.equal(lim.running, 0);
});

// ------------------------------------------------------------------ view reports
test('canvas tools act on the visible (then focused, then newest) view report', async () => {
  const { db, bus, store } = base();
  const cv = new CanvasService({ db, bus, store, cfg: { hosts: [], accounts: [] } } as any);
  const rep = (id: string, o: Record<string, unknown>) => cv.report(id, { mode: id, nodes: [], selected: [], focusId: null, ...o } as any);
  rep('desk', { pageVisible: true, focused: true });
  await sleep(2);
  rep('bg-tab', { pageVisible: false });
  assert.equal(cv.view()!.mode, 'desk', 'a newer report from a hidden page loses');
  await sleep(2);
  rep('phone', { pageVisible: true, focused: false });
  assert.equal(cv.view()!.mode, 'desk', 'focused beats unfocused');
  await sleep(2);
  rep('phone', { pageVisible: true, focused: true });
  assert.equal(cv.view()!.mode, 'phone', 'same rank: the newest');
  await sleep(2);
  rep('old-pwa', {});
  assert.equal(cv.view()!.mode, 'phone', 'a report without flags counts as visible, unfocused');
});

// ------------------------------------------------------------------ grants
test('a metrics tick republishes a grant only when its usage changed', () => {
  const { db, bus, store, events } = base();
  const cs = new ComputeService({ db, bus, store, hosts: { host() {} }, push: { notify() {} }, cfg: { hosts: [] } } as any);
  const g = cs.createGrant({ sessionId: 's', hostId: 'h', resources: 'gpu', purpose: 'p', status: 'active' })!;
  const m = { id: 'h', gpu: [{ name: 'g', utilPct: 1, memUsedMB: 1024, memTotalMB: 8192 }] } as any;
  (cs as any).machines.set('h', m);
  const n0 = events.length;
  (cs as any).updateGrantUsage('h', m);
  (cs as any).updateGrantUsage('h', m);
  assert.equal(events.length - n0, 1, 'usage went from unknown to 1 GB: one publish');
  (cs as any).updateGrantUsage('h', m);
  assert.equal(events.length - n0, 1);
  m.gpu[0].memUsedMB = 2048;
  (cs as any).updateGrantUsage('h', m);
  assert.equal(events.length - n0, 2);
  assert.equal(events.at(-1)!.data.id, g.id);
  assert.equal(events.at(-1)!.data.usedGB, 2);
});

// ------------------------------------------------------------------ Claude transcript tail
test('reattaching a Claude session tails the transcript after the lines already read', async () => {
  const { db, bus, store, events } = base();
  const cmds: string[] = [];
  const procs: any[] = [];
  const hosts = {
    bin: (_h: string, b: string) => b,
    spawn: (_h: string, cmd: string) => {
      const p: any = new EventEmitter();
      p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.stdin = { writable: false };
      p.kill = () => {};
      cmds.push(cmd); procs.push(p);
      return p;
    },
  };
  const c: any = { db, bus, store, hosts, cfg: {}, push: { notify() {} } };
  store.upsertSession({ id: 'cc-1', vendor: 'claude', kind: 'local', host_id: 'h', account_id: 'a', title: 't', status: 'idle', meta: { tmux: 'cc-1', transcript: '/t.jsonl', tLines: 5 } } as any);
  const drv = new ClaudeDriver(c);
  drv.attach('cc-1');
  const tail = cmds.findIndex((x) => x.startsWith('tail '));
  assert.match(cmds[tail], /^tail -n \+6 -F -- /);
  const line = (uuid: string, text: string) => JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: text }, timestamp: 't' }) + '\n';
  const n0 = events.length;
  procs[tail].stdout.emit('data', line('u6', 'six') + line('u7', 'sev'));
  procs[tail].stdout.emit('data', line('u8', 'eight').slice(0, 10)); // a partial line is not counted
  assert.equal(events.filter((e, i) => i >= n0 && e.type === 'message.upsert').length, 2);
  assert.equal(events.filter((e, i) => i >= n0 && e.type === 'session.upsert').length, 0, 'the position is saved quietly');
  (drv as any).saveTranscriptPos('cc-1');
  assert.equal(store.session('cc-1')!.meta.tLines, 7);
  clearTimeout((drv as any).live.get('cc-1')?.tSave);
  (drv as any).live.get('cc-1').closed = true;
});
