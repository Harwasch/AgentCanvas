// Hardware-in-the-loop runs: a plan declared per host in config runs over SSH
// while the hub holds the plan's device locks. Progress comes from the hub HIL
// line protocol on stdout:
//   ##hil plan <count>
//   ##hil test <id> <req> <name…>
//   ##hil pass|fail|skip <id> <ms> [reason…]
// Every other line is log output.
import crypto from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { Ctx } from './ctx.js';
import type { HilPlanConfig } from './config.js';
import { q, rpath } from './ssh.js';
import { j } from './db.js';
import { log } from './events.js';

const L = log('hil');

export interface HilRow {
  id: string;
  req: string;
  name: string;
  status: 'pending' | 'run' | 'pass' | 'fail' | 'skip';
  durMs: number | null;
  reason?: string;
}
export interface HilRun {
  id: string;
  planId: string;
  status: 'running' | 'passed' | 'failed' | 'aborted';
  pass: number;
  fail: number;
  left: number;
  planned: number;
  rows: HilRow[];
  log: string[];
  startedBy: string;
  startedAt: number;
  finishedAt: number | null;
  only: string[] | null;
}

/** Apply one output line to a run (pure; unit-tested). */
export function applyHilLine(run: HilRun, line: string): HilRun {
  const m = line.match(/^##hil\s+(\w+)\s*(.*)$/);
  if (!m) {
    if (line.trim()) run.log = [...run.log, line].slice(-200);
    return run;
  }
  const [, verb, rest] = m;
  const parts = rest.split(/\s+/);
  const counts = () => {
    run.pass = run.rows.filter((r) => r.status === 'pass').length;
    run.fail = run.rows.filter((r) => r.status === 'fail').length;
    run.left = Math.max(0, run.planned - run.pass - run.fail - run.rows.filter((r) => r.status === 'skip').length);
  };
  if (verb === 'plan') run.planned = Math.max(0, Number(parts[0]) || 0);
  else if (verb === 'test' && parts[0]) {
    const [tid, req, ...name] = parts;
    const prev = run.rows.find((r) => r.id === tid);
    if (prev) Object.assign(prev, { status: 'run', durMs: null });
    else run.rows = [...run.rows, { id: tid, req: req || '', name: name.join(' '), status: 'run', durMs: null }];
  } else if ((verb === 'pass' || verb === 'fail' || verb === 'skip') && parts[0]) {
    const [tid, ms, ...reason] = parts;
    let row = run.rows.find((r) => r.id === tid);
    if (!row) {
      row = { id: tid, req: '', name: tid, status: 'pending', durMs: null };
      run.rows = [...run.rows, row];
    }
    row.status = verb;
    row.durMs = Number.isFinite(Number(ms)) ? Number(ms) : null;
    if (reason.length) row.reason = reason.join(' ');
  }
  if (run.rows.length > run.planned) run.planned = run.rows.length;
  counts();
  return run;
}

export class HilService {
  private procs = new Map<string, { proc: ChildProcess; locks: string[]; run: HilRun }>();
  constructor(private c: Ctx) {}

  plans() {
    const out: any[] = [];
    for (const h of this.c.cfg.hosts)
      for (const p of h.hil || [])
        out.push({ id: `${h.id}:${p.id}`, title: p.title, hostId: h.id, devices: (p.devices || []).map((d) => `${h.id}:${d}`), plan: p.plan ?? null, setup: p.setup || [] });
    return out;
  }
  private plan(planId: string): { host: string; p: HilPlanConfig } {
    const [host, pid] = planId.split(':');
    const p = this.c.cfg.hosts.find((h) => h.id === host)?.hil?.find((x) => x.id === pid);
    if (!p) throw new Error(`unknown HIL plan ${planId}`);
    return { host, p };
  }
  runs() {
    return this.c.db.all('SELECT data FROM hil_run ORDER BY started_at DESC LIMIT 50').map((r) => j<HilRun>(r.data, null));
  }
  run(rid: string) {
    return j<HilRun>(this.c.db.get('SELECT data FROM hil_run WHERE id=?', rid)?.data, null);
  }
  private save(run: HilRun) {
    this.c.db.upsert('hil_run', { id: run.id, plan_id: run.planId, data: run, started_at: run.startedAt });
    this.c.bus.publish('hil.upsert', run);
  }

  /** startedBy: "you" or a session id. Takes the plan's device locks for the run's duration. */
  async start(planId: string, startedBy: string, only: string[] | null = null): Promise<HilRun> {
    const { host, p } = this.plan(planId);
    if ([...this.procs.keys()].some((k) => this.run(k)?.planId === planId)) throw new Error('this plan is already running');
    const devices = (p.devices || []).map((d) => `${host}:${d}`);
    const taken: string[] = [];
    try {
      for (const d of devices) {
        const cur = this.c.compute.lockOf(d);
        if (cur && cur.sessionId !== startedBy) throw new Error(`${this.c.compute.device(d)?.title ?? d} is locked by ${this.c.compute.holderLabel(cur.sessionId)}`);
        if (!cur) {
          this.c.compute.setLock(d, startedBy);
          taken.push(d);
        }
      }
    } catch (e) {
      taken.forEach((d) => this.c.compute.setLock(d, null));
      throw e;
    }
    const run: HilRun = { id: `hil-${crypto.randomBytes(4).toString('hex')}`, planId, status: 'running', pass: 0, fail: 0, left: 0, planned: 0, rows: [], log: [], startedBy, startedAt: Date.now(), finishedAt: null, only };
    this.save(run);
    const env = only?.length ? `HIL_ONLY=${q(only.join(','))} ` : '';
    const proc = this.c.hosts.spawn(host, `cd ${rpath(p.cwd || '~')} && ${env}exec ${p.command}`);
    this.procs.set(run.id, { proc, locks: taken, run });
    let buf = '';
    let pending: NodeJS.Timeout | undefined;
    const flush = () => {
      pending = undefined;
      this.save(run);
    };
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        applyHilLine(run, buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
      if (!pending) pending = setTimeout(flush, 200);
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', (d) => applyHilLine(run, `[stderr] ${String(d).trim()}`));
    proc.on('close', (code) => {
      if (pending) clearTimeout(pending);
      if (buf.trim()) applyHilLine(run, buf);
      for (const r of run.rows) if (r.status === 'run') r.status = run.status === 'aborted' ? 'skip' : 'fail';
      if (run.status !== 'aborted') run.status = code === 0 && run.fail === 0 && run.rows.length > 0 ? 'passed' : 'failed';
      run.pass = run.rows.filter((r) => r.status === 'pass').length;
      run.fail = run.rows.filter((r) => r.status === 'fail').length;
      run.left = 0;
      run.finishedAt = Date.now();
      const h = this.procs.get(run.id);
      this.procs.delete(run.id);
      h?.locks.forEach((d) => this.c.compute.setLock(d, null));
      this.save(run);
      L(`${run.id} ${planId}: ${run.status} (${run.pass} pass, ${run.fail} fail)`);
      this.c.push.notify({ title: `HIL ${run.status}`, body: `${p.title}: ${run.pass} passed, ${run.fail} failed`, tag: run.id, url: '/' });
      if (startedBy !== 'you') {
        const s = this.c.store.session(startedBy);
        if (s && s.kind === 'local' && s.status !== 'ended') {
          const msg = `HIL run ${run.id} (${p.title}) ${run.status}: ${run.pass} passed, ${run.fail} failed${run.fail ? ` — ${run.rows.filter((r) => r.status === 'fail').map((r) => `${r.id} ${r.reason ?? ''}`).join('; ')}` : ''}.`;
          (s.vendor === 'claude' ? this.c.claude.send(s.id, msg) : this.c.codex.send(s.id, msg)).catch(() => {});
        }
      }
    });
    return run;
  }

  abort(rid: string) {
    const h = this.procs.get(rid);
    if (!h) throw new Error('run is not active');
    h.run.status = 'aborted';
    this.save(h.run);
    h.proc.stdin?.end();
    h.proc.kill('SIGTERM');
  }

  rerunFailed(rid: string, startedBy = 'you') {
    const run = this.run(rid);
    if (!run) throw new Error('unknown run');
    const failed = run.rows.filter((r) => r.status === 'fail').map((r) => r.id);
    if (!failed.length) throw new Error('nothing failed in that run');
    return this.start(run.planId, startedBy, failed);
  }
}
