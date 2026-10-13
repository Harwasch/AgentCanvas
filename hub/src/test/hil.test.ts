import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHilLine, type HilRun } from '../hil.js';
import { parseMetrics } from '../compute.js';

const blank = (): HilRun => ({ id: 'r', planId: 'p', status: 'running', pass: 0, fail: 0, left: 0, planned: 0, rows: [], log: [], startedBy: 'you', startedAt: 0, finishedAt: null, only: null });

test('HIL line protocol: plan, test start, pass/fail/skip with reasons, log lines, counters', () => {
  const r = blank();
  for (const l of ['##hil plan 3', 'bench up', '##hil test T-01 REQ-1 Flash firmware', '##hil pass T-01 812', '##hil test T-02 REQ-2 Torque hold 60 C', '  T-02: 4.1 % > 3 %',
    '##hil fail T-02 1500 torque error 4.1 % > 3 %', '##hil test T-03 REQ-3 E-stop'])
    applyHilLine(r, l);
  assert.equal(r.planned, 3);
  assert.equal(r.pass, 1);
  assert.equal(r.fail, 1);
  assert.equal(r.left, 1);
  assert.deepEqual(r.rows.map((x) => [x.id, x.status]), [['T-01', 'pass'], ['T-02', 'fail'], ['T-03', 'run']]);
  assert.equal(r.rows[1].reason, 'torque error 4.1 % > 3 %');
  assert.equal(r.rows[0].durMs, 812);
  assert.deepEqual(r.log, ['bench up', '  T-02: 4.1 % > 3 %']);
});

test('HIL: verdict without a test line, rerun of a row, garbage and blank lines', () => {
  const r = blank();
  applyHilLine(r, '##hil pass T-09 x');
  assert.equal(r.rows[0].status, 'pass');
  assert.equal(r.rows[0].durMs, null);
  applyHilLine(r, '##hil test T-09 REQ-9 again');
  assert.equal(r.rows[0].status, 'run');
  applyHilLine(r, '##hil bogus');
  applyHilLine(r, '   ');
  assert.equal(r.rows.length, 1);
  assert.equal(r.planned, 1);
});

test('machine metrics: CPU % from /proc/stat deltas, meminfo, loadavg, nvidia-smi csv', () => {
  const S = '\u001e';
  const a = parseMetrics(`cpu  100 0 100 800 0 0 0 0 0 0${S}8\n${S}MemTotal: 16384000 kB\nMemAvailable: 8192000 kB\n${S}0.52 0.40 0.30 1/200 999\n${S}`);
  assert.equal(a.cpu.cores, 8);
  assert.deepEqual(a.mem, { usedMB: 8000, totalMB: 16000 });
  assert.equal(a.load, 0.52);
  assert.deepEqual(a.gpu, []);
  const b = parseMetrics(`cpu  150 0 150 900 0 0 0 0 0 0${S}8${S}MemTotal: 16384000 kB\nMemAvailable: 8192000 kB${S}0.5${S}NVIDIA RTX A5000 (simulated), 54, 6960, 24564\n`, a.sample);
  assert.equal(b.cpu.pct, 50);
  assert.deepEqual(b.gpu, [{ name: 'NVIDIA RTX A5000 (simulated)', utilPct: 54, memUsedMB: 6960, memTotalMB: 24564 }]);
});
