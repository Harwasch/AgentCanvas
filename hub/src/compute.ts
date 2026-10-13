// Compute surfaces: live machine metrics over SSH (/proc, nvidia-smi), bench
// devices (declared in config with a probe, plus serial/CAN discovery), device
// locks arbitrated by the hub, and compute grants that let an agent session run
// commands on another host.
import crypto from 'node:crypto';
import type { Ctx } from './ctx.js';
import type { DeviceConfig } from './config.js';
import { q, rpath } from './ssh.js';
import { log } from './events.js';

const L = log('compute');
const SEP = '\u001e';

export interface Machine {
  id: string;
  label: string;
  kind: 'host' | 'cloud';
  color: string;
  status: 'online' | 'offline' | 'managed';
  cpu: { pct: number; cores: number } | null;
  mem: { usedMB: number; totalMB: number } | null;
  gpu: { name: string; utilPct: number; memUsedMB: number; memTotalMB: number }[];
  load: number | null;
  updatedAt: number;
}

export function parseMetrics(out: string, prev?: { idle: number; total: number }) {
  const [stat, nproc, mem, loadavg, gpu] = out.split(SEP);
  const f = (stat || '').trim().split(/\s+/).slice(1).map(Number);
  const idle = (f[3] || 0) + (f[4] || 0);
  const total = f.reduce((a, b) => a + (b || 0), 0);
  const pct = prev && total > prev.total ? Math.round((100 * (1 - (idle - prev.idle) / (total - prev.total))) * 10) / 10 : null;
  const mt = Number((mem || '').match(/MemTotal:\s+(\d+)/)?.[1] || 0) / 1024;
  const ma = Number((mem || '').match(/MemAvailable:\s+(\d+)/)?.[1] || 0) / 1024;
  const gpus = (gpu || '').split('\n').map((l) => l.trim()).filter((l) => l && !/not found|failed/i.test(l)).map((l) => {
    const [name, util, used, tot] = l.split(',').map((x) => x.trim());
    return { name, utilPct: Number(util) || 0, memUsedMB: Number(used) || 0, memTotalMB: Number(tot) || 0 };
  }).filter((g) => g.name && g.memTotalMB);
  return {
    sample: { idle, total },
    cpu: { pct: pct ?? 0, cores: Number(nproc) || 1 },
    mem: mt ? { usedMB: Math.round(mt - ma), totalMB: Math.round(mt) } : null,
    load: Number((loadavg || '').split(' ')[0]) || 0,
    gpu: gpus,
  };
}

export class ComputeService {
  private machines = new Map<string, Machine>();
  private samples = new Map<string, { idle: number; total: number }>();
  private devices = new Map<string, any>();
  private timers: NodeJS.Timeout[] = [];
  constructor(private c: Ctx) {}

  // ------------------------------------------------------------ machines
  listMachines() {
    return [...this.machines.values()];
  }

  async pollMachine(hostId: string) {
    const h = this.c.cfg.hosts.find((x) => x.id === hostId)!;
    const smi = this.c.hosts.bin(hostId, 'nvidiaSmi');
    const cmd = [`head -1 /proc/stat`, `printf '${SEP}'`, `nproc`, `printf '${SEP}'`, `grep -E 'MemTotal|MemAvailable' /proc/meminfo`, `printf '${SEP}'`, `cat /proc/loadavg`, `printf '${SEP}'`,
      `${q(smi)} --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null || true`].join('; ');
    const r = await this.c.hosts.exec(hostId, cmd, { timeoutMs: 10000 });
    const prev = this.machines.get(hostId);
    const base = { id: hostId, label: h.label || hostId, kind: 'host' as const, color: h.color || '#8A8F98' };
    let m: Machine;
    if (r.code !== 0) m = { ...base, status: 'offline', cpu: prev?.cpu ?? null, mem: prev?.mem ?? null, gpu: prev?.gpu ?? [], load: prev?.load ?? null, updatedAt: Date.now() };
    else {
      const p = parseMetrics(r.stdout, this.samples.get(hostId));
      this.samples.set(hostId, p.sample);
      m = { ...base, status: 'online', cpu: p.cpu, mem: p.mem, gpu: p.gpu, load: p.load, updatedAt: Date.now() };
    }
    this.machines.set(hostId, m);
    this.c.bus.publish('machine.upsert', m);
    this.updateGrantUsage(hostId, m);
  }

  // ------------------------------------------------------------ devices
  deviceId(hostId: string, local: string) {
    return `${hostId}:${local}`;
  }
  listDevices() {
    return [...this.devices.values()].map((d) => ({ ...d, lock: this.lockOf(d.id) }));
  }
  device(idv: string) {
    const d = this.devices.get(idv);
    return d ? { ...d, lock: this.lockOf(d.id) } : undefined;
  }

  async pollDevices(hostId: string) {
    const h = this.c.cfg.hosts.find((x) => x.id === hostId)!;
    const declared: DeviceConfig[] = h.devices || [];
    // one round trip: each probe's exit code, then serial/CAN discovery
    const probes = declared.map((d, i) => `if ${d.probe ? `( ${d.probe} )` : 'true'} >/dev/null 2>&1; then echo "P${i} 0"; else echo "P${i} 1"; fi`).join('; ');
    const disc = `printf '${SEP}'; ls /dev/serial/by-id 2>/dev/null; printf '${SEP}'; ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null; printf '${SEP}'; ip -br link 2>/dev/null | grep -E '^v?can' || true`;
    const r = await this.c.hosts.exec(hostId, `${probes || 'true'}; ${disc}`, { timeoutMs: 15000 });
    const online = r.code === 0;
    const [probeOut, byId, ttys, cans] = r.stdout.split(SEP);
    const seen = new Set<string>();
    declared.forEach((d, i) => {
      const ok = new RegExp(`^P${i} 0$`, 'm').test(probeOut || '');
      this.putDevice({
        id: this.deviceId(hostId, d.id), hostId, parentId: d.parentId ? this.deviceId(hostId, d.parentId) : null, title: d.title, kind: d.kind || '', icon: d.icon || 'USB',
        port: d.port || '', fw: d.fw || '', status: !online ? 'unknown' : ok ? 'connected' : 'missing', source: 'declared', localId: d.id,
      });
      seen.add(this.deviceId(hostId, d.id));
    });
    if (online) {
      const declaredPorts = new Set(declared.map((d) => (d.port || '').split(' ')[0]));
      const byIdNames = (byId || '').split('\n').map((s) => s.trim()).filter(Boolean);
      for (const t of (ttys || '').split(/\s+/).filter(Boolean)) {
        if (declaredPorts.has(t)) continue;
        const name = byIdNames.find((n) => n.toLowerCase().includes(t.split('/').pop()!.toLowerCase())) || t.split('/').pop()!;
        const did = this.deviceId(hostId, t.replace(/\W+/g, '_'));
        this.putDevice({ id: did, hostId, parentId: null, title: name, kind: 'Serial device', icon: 'SER', port: t, fw: '', status: 'connected', source: 'discovered', localId: t });
        seen.add(did);
      }
      for (const line of (cans || '').split('\n').filter(Boolean)) {
        const [ifn, state] = line.split(/\s+/);
        const did = this.deviceId(hostId, ifn);
        this.putDevice({ id: did, hostId, parentId: null, title: `CAN ${ifn}`, kind: 'SocketCAN interface', icon: 'CAN', port: ifn, fw: '', status: state === 'UP' || state === 'UNKNOWN' ? 'connected' : 'missing', source: 'discovered', localId: ifn });
        seen.add(did);
      }
      // discovered devices that disappeared are shown as missing until the hub restarts
      for (const d of this.devices.values()) if (d.hostId === hostId && d.source === 'discovered' && !seen.has(d.id) && d.status !== 'missing') this.putDevice({ ...d, status: 'missing' });
    }
  }

  private putDevice(d: any) {
    const prev = this.devices.get(d.id);
    const next = { ...d, updatedAt: Date.now() };
    this.devices.set(d.id, next);
    const strip = (x: any) => JSON.stringify({ ...x, updatedAt: 0 });
    if (!prev || strip(prev) !== strip(next)) this.c.bus.publish('device.upsert', { ...next, lock: this.lockOf(d.id) });
  }

  lockOf(deviceId: string): { sessionId: string; since: number } | null {
    const r = this.c.db.get('SELECT * FROM device_lock WHERE device_id=?', deviceId);
    return r ? { sessionId: r.session_id, since: r.since } : null;
  }

  /** Resolve a device given by an agent/app: full id, or host-local id on the given host. */
  resolveDevice(idv: string, hostId?: string | null) {
    if (this.devices.has(idv)) return idv;
    if (hostId && this.devices.has(this.deviceId(hostId, idv))) return this.deviceId(hostId, idv);
    throw new Error(`unknown device ${idv}`);
  }

  /** holder: a session id, "you", or null to release. Agents cannot take a lock held by someone else. */
  setLock(deviceId: string, holder: string | null, opts: { force?: boolean } = {}) {
    const cur = this.lockOf(deviceId);
    if (holder && cur && cur.sessionId !== holder && !opts.force) throw new Error(`${this.devices.get(deviceId)?.title ?? deviceId} is locked by ${this.holderLabel(cur.sessionId)}`);
    if (holder) this.c.db.upsert('device_lock', { device_id: deviceId, session_id: holder, since: cur?.sessionId === holder ? cur.since : Date.now() }, 'device_id');
    else this.c.db.run('DELETE FROM device_lock WHERE device_id=?', deviceId);
    const d = this.devices.get(deviceId);
    if (d) this.c.bus.publish('device.upsert', { ...d, lock: this.lockOf(deviceId) });
    return this.lockOf(deviceId);
  }

  holderLabel(h: string) {
    if (h === 'you') return 'you';
    const s = this.c.store.session(h);
    return s ? `${s.vendor} session "${s.title}"` : h;
  }

  /** Release every lock a session holds (session ended). */
  releaseAll(sessionId: string) {
    for (const r of this.c.db.all('SELECT device_id FROM device_lock WHERE session_id=?', sessionId)) this.setLock(r.device_id, null);
  }

  // ------------------------------------------------------------ grants
  grantView(r: any) {
    if (!r) return undefined;
    const m = this.machines.get(r.host_id);
    const usedGB = m?.gpu?.length ? Math.round((m.gpu.reduce((a, g) => a + g.memUsedMB, 0) / 1024) * 10) / 10 : null;
    return { id: r.id, sessionId: r.session_id, hostId: r.host_id, resources: r.resources, purpose: r.purpose, quotaGB: r.quota_gb, usedGB, status: r.status, createdAt: r.created_at };
  }
  grants() {
    return this.c.db.all('SELECT * FROM grant_ ORDER BY created_at').map((r) => this.grantView(r));
  }
  grant(gid: string) {
    return this.grantView(this.c.db.get('SELECT * FROM grant_ WHERE id=?', gid));
  }
  createGrant(o: { sessionId: string; hostId: string; resources: string; purpose: string; quotaGB?: number | null; status: 'requested' | 'active' }) {
    this.c.hosts.host(o.hostId);
    const g = { id: `grant-${crypto.randomBytes(4).toString('hex')}`, session_id: o.sessionId, host_id: o.hostId, resources: o.resources, purpose: o.purpose, quota_gb: o.quotaGB ?? null, status: o.status, created_at: Date.now() };
    this.c.db.upsert('grant_', g);
    const v = this.grant(g.id)!;
    this.grantUsage.set(v.id, v.usedGB);
    this.c.bus.publish('grant.upsert', v);
    if (o.status === 'requested') this.c.push.notify({ title: 'Compute requested', body: `${this.holderLabel(o.sessionId)} asks for ${o.resources} on ${o.hostId}: ${o.purpose}`, tag: g.id, url: `/?focus=${o.sessionId}` });
    return v;
  }
  setGrant(gid: string, status: 'active' | 'revoked') {
    if (!this.grant(gid)) throw new Error('unknown grant');
    this.c.db.run('UPDATE grant_ SET status=? WHERE id=?', status, gid);
    const v = this.grant(gid)!;
    this.grantUsage.set(v.id, v.usedGB);
    this.c.bus.publish('grant.upsert', v);
    return v;
  }
  /** last usedGB published per grant: a metrics tick republishes a grant only when its usage changed */
  private grantUsage = new Map<string, number | null>();
  private updateGrantUsage(hostId: string, _m: Machine) {
    for (const r of this.c.db.all("SELECT * FROM grant_ WHERE host_id=? AND status='active'", hostId)) {
      const v = this.grantView(r)!;
      if (this.grantUsage.has(v.id) && this.grantUsage.get(v.id) === v.usedGB) continue;
      this.grantUsage.set(v.id, v.usedGB);
      this.c.bus.publish('grant.upsert', v);
    }
  }

  /** Agent runs a command on a granted host (its own user, its own cwd); output is returned and audited. */
  async runOnHost(sessionId: string, grantId: string, command: string, cwd?: string) {
    const g = this.grant(grantId);
    if (!g || g.sessionId !== sessionId) throw new Error('no such grant for this session');
    if (g.status !== 'active') throw new Error(`grant is ${g.status}; it must be approved in the hub first`);
    const t0 = Date.now();
    const r = await this.c.hosts.exec(g.hostId, `cd ${cwd ? rpath(cwd) : '"$HOME"'} && ${command}`, { timeoutMs: 10 * 60_000, long: true });
    const out = (r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')).slice(-20000);
    this.c.db.run('INSERT INTO audit (ts, app_node_id, tool, tier, caller, args, allowed, reason, result) VALUES (?,?,?,?,?,?,?,?,?)',
      Date.now(), grantId, '(run_on_host)', 'compute', `agent:${this.holderLabel(sessionId)}`, JSON.stringify({ host: g.hostId, command, cwd }), 1, `grant ${grantId} · exit ${r.code} · ${Date.now() - t0} ms`, out.slice(-1000));
    return { exitCode: r.code, output: out };
  }

  // ------------------------------------------------------------ lifecycle
  start() {
    for (const cloud of [{ id: 'claude-cloud', label: 'Claude cloud', color: '#E0896B' }, { id: 'codex-cloud', label: 'Codex cloud', color: '#A48BFA' }]) {
      const m: Machine = { ...cloud, kind: 'cloud', status: 'managed', cpu: null, mem: null, gpu: [], load: null, updatedAt: Date.now() };
      this.machines.set(cloud.id, m);
    }
    const tickM = () => this.c.cfg.hosts.forEach((h) => this.pollMachine(h.id).catch((e) => L(`metrics ${h.id}: ${e.message}`)));
    const tickD = () => this.c.cfg.hosts.forEach((h) => this.pollDevices(h.id).catch((e) => L(`devices ${h.id}: ${e.message}`)));
    tickM();
    setTimeout(tickM, 1500); // second sample gives CPU %
    tickD();
    this.timers.push(setInterval(tickM, this.c.cfg.metricsIntervalSec * 1000), setInterval(tickD, Math.max(10, this.c.cfg.metricsIntervalSec * 3) * 1000));
  }
  stop() {
    this.timers.forEach(clearInterval);
  }
}
