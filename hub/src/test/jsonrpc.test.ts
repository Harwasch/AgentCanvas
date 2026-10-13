import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpcPeer, NdjsonDecoder, RpcError, PARKED, type RpcMessage } from '../jsonrpc.js';

function pair(opts = {}) {
  const sentA: RpcMessage[] = [];
  const a = new JsonRpcPeer((m) => sentA.push(m), opts);
  return { a, sentA };
}

test('request/response correlation by id, out of order', async () => {
  const { a, sentA } = pair();
  const p1 = a.request('thread/start', { cwd: '/x' });
  const p2 = a.request('thread/list', {});
  assert.equal(sentA.length, 2);
  a.handle({ id: sentA[1].id, result: { data: [] } });
  a.handle({ id: sentA[0].id, result: { thread: { id: 't1' } } });
  assert.deepEqual(await p1, { thread: { id: 't1' } });
  assert.deepEqual(await p2, { data: [] });
});

test('includeVersion:false omits the jsonrpc field (Codex wire format)', () => {
  const { a, sentA } = pair({ includeVersion: false });
  a.notify('initialized');
  assert.deepEqual(sentA[0], { method: 'initialized' });
  const { a: b, sentA: sb } = pair();
  b.notify('x', {});
  assert.equal(sb[0].jsonrpc, '2.0');
});

test('error responses reject with RpcError', async () => {
  const { a, sentA } = pair();
  const p = a.request('turn/start', {});
  a.handle({ id: sentA[0].id, error: { code: -32600, message: 'bad' } });
  await assert.rejects(p, (e: any) => e instanceof RpcError && e.code === -32600);
});

test('string ids from the peer are accepted', async () => {
  const sent: RpcMessage[] = [];
  const a = new JsonRpcPeer((m) => sent.push(m));
  a.onRequest = () => ({ decision: 'accept' });
  a.handle({ id: 'abc', method: 'item/commandExecution/requestApproval', params: {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent[0], { jsonrpc: '2.0', id: 'abc', result: { decision: 'accept' } });
});

test('server-initiated request can be parked and answered later', async () => {
  const sent: RpcMessage[] = [];
  const a = new JsonRpcPeer((m) => sent.push(m), { includeVersion: false });
  let parkedId: any;
  a.onRequest = (_m, _p, id) => {
    parkedId = id;
    return PARKED;
  };
  a.handle({ id: 7, method: 'item/commandExecution/requestApproval', params: {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 0);
  a.respond(parkedId, { decision: 'decline' });
  assert.deepEqual(sent[0], { id: 7, result: { decision: 'decline' } });
});

test('unknown server request gets -32601', async () => {
  const sent: RpcMessage[] = [];
  const a = new JsonRpcPeer((m) => sent.push(m));
  a.handle({ id: 1, method: 'nope' });
  await new Promise((r) => setImmediate(r));
  assert.equal(sent[0].error!.code, -32601);
});

test('notifications dispatch; garbage is rejected; close rejects pending', async () => {
  const { a } = pair();
  const got: string[] = [];
  a.onNotification = (m) => got.push(m);
  assert.equal(a.handle({ method: 'turn/started', params: {} }), true);
  assert.equal(a.handle([] as any), false);
  assert.equal(a.handle({ foo: 1 } as any), false);
  assert.deepEqual(got, ['turn/started']);
  const p = a.request('x');
  a.close('gone');
  await assert.rejects(p, /gone/);
});

test('timeouts reject and late responses are ignored', async () => {
  const { a, sentA } = pair({ timeoutMs: 10 });
  const p = a.request('slow');
  await assert.rejects(p, /timeout/);
  assert.equal(a.handle({ id: sentA[0].id, result: {} }), true);
});

test('NDJSON decoder: arbitrary chunking, CRLF, blank lines, split UTF-8, bad lines', () => {
  const got: any[] = [];
  const bad: string[] = [];
  const d = new NdjsonDecoder((m) => got.push(m), (l) => bad.push(l));
  const payload = Buffer.from('{"a":1}\r\n\n{"t":"héllo — ✓"}\nnot json\n{"b":', 'utf8');
  for (const byte of payload) d.push(Buffer.from([byte]));
  d.push('2}\n');
  assert.deepEqual(got, [{ a: 1 }, { t: 'héllo — ✓' }, { b: 2 }]);
  assert.deepEqual(bad, ['not json']);
});
