// Host manager: one multiplexed SSH connection per host (ControlMaster),
// health checks, remote exec / long-lived stdio processes, and file bootstrap.
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { HubConfig, HostConfig } from './config.js';
import { expandHome } from './config.js';
import { EventBus, log } from './events.js';
import { Db } from './db.js';

const L = log('ssh');

/** POSIX single-quote a string for a remote shell. */
export function q(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Quote a remote path, expanding a leading ~ to $HOME on the remote side. */
export function rpath(p: string): string {
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return `"$HOME"/${q(p.slice(2))}`;
  return q(p);
}

/** At most `max` tasks at once; the rest wait in FIFO order. */
export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(public max: number) {}
  get running() {
    return this.active;
  }
  get waiting() {
    return this.queue.length;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    else this.active++;
    try {
      return await fn();
    } finally {
      // hand the slot straight to the next waiter (active stays the same), or free it
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** sshd refused a channel on the shared connection: too many sessions for its MaxSessions */
export const CHANNEL_REFUSED = /channel \d+: open failed|administratively prohibited|open failed: .*prohibited/i;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class HostManager {
  private controlDir: string;
  private health = new Map<string, NodeJS.Timeout>();
  private onlineFns: ((hostId: string) => void)[] = [];
  /** short execs per host share the ControlMaster's channels with long-lived relays and tails (sshd MaxSessions) */
  private limiters = new Map<string, Limiter>();
  private refusedAt = new Map<string, number>();
  constructor(private cfg: HubConfig, private db: Db, private bus: EventBus) {
    this.controlDir = expandHome(cfg.ssh.controlDir || path.join(cfg.dataDir, 'ssh-ctl'));
    fs.mkdirSync(this.controlDir, { recursive: true, mode: 0o700 });
  }

  host(id: string): HostConfig {
    const h = this.cfg.hosts.find((x) => x.id === id);
    if (!h) throw new Error(`unknown host ${id}`);
    return h;
  }

  bin(hostId: string, name: 'claude' | 'codex' | 'python' | 'git' | 'tmux' | 'nvidiaSmi'): string {
    const h = this.host(hostId);
    const o = h.bins?.[name];
    if (o) return o;
    if (name === 'claude') return this.cfg.adapters.claude.bin;
    if (name === 'codex') return this.cfg.adapters.codex.bin;
    if (name === 'python') return 'python3';
    if (name === 'nvidiaSmi') return 'nvidia-smi';
    return name;
  }

  sshArgs(h: HostConfig, extra: string[] = []): string[] {
    const a = [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${this.controlDir}/%C`,
      '-o', 'ControlPersist=10m',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ConnectTimeout=8',
      '-o', `UserKnownHostsFile=${path.join(this.cfg.dataDir, 'known_hosts')}`,
    ];
    if (this.cfg.ssh.identityFile) a.push('-i', expandHome(this.cfg.ssh.identityFile));
    if (h.port) a.push('-p', String(h.port));
    a.push(...(this.cfg.ssh.extraArgs || []), ...extra, h.target);
    return a;
  }

  limiter(hostId: string): Limiter {
    let l = this.limiters.get(hostId);
    if (!l) this.limiters.set(hostId, (l = new Limiter(Math.max(1, this.cfg.ssh.maxExecs ?? 4))));
    return l;
  }

  /** A clear log line (once a minute per host) when sshd refuses a new channel on the multiplexed connection. */
  private noteRefused(hostId: string, stderr: string) {
    const m = stderr.match(CHANNEL_REFUSED);
    if (!m) return;
    const now = Date.now();
    if (now - (this.refusedAt.get(hostId) ?? 0) < 60_000) return;
    this.refusedAt.set(hostId, now);
    L(`WARNING ${hostId}: sshd refused a new channel ("${m[0]}"). Each Claude session holds 2 channels on the shared connection; raise MaxSessions in the host's sshd_config (64 recommended, see README "Hosts") or lower ssh.maxExecs.`);
  }

  /**
   * Run a remote shell command and collect output, queued behind ssh.maxExecs others on this host. `long`: a command
   * that may run for minutes (an agent's run_on_host) takes no slot, so it cannot starve health checks and scans.
   */
  exec(hostId: string, cmd: string, opts: { input?: string; timeoutMs?: number; long?: boolean } = {}): Promise<ExecResult> {
    if (opts.long) return this.execNow(hostId, cmd, opts);
    return this.limiter(hostId).run(() => this.execNow(hostId, cmd, opts));
  }

  private execNow(hostId: string, cmd: string, opts: { input?: string; timeoutMs?: number }): Promise<ExecResult> {
    const h = this.host(hostId);
    return new Promise((resolve) => {
      const p = spawn(this.cfg.ssh.bin, [...this.sshArgs(h), '--', cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      const t = setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs ?? 30000);
      p.on('close', (code) => {
        clearTimeout(t);
        if (code) this.noteRefused(hostId, stderr);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      p.on('error', (e) => {
        clearTimeout(t);
        resolve({ code: -1, stdout, stderr: String(e) });
      });
      p.stdin.on('error', (e) => L(`${hostId} stdin: ${e.message}`)); // EPIPE: the remote side exited before reading
      if (opts.input != null) p.stdin.end(opts.input);
      else p.stdin.end();
    });
  }

  async execOk(hostId: string, cmd: string, opts: { input?: string; timeoutMs?: number } = {}): Promise<string> {
    const r = await this.exec(hostId, cmd, opts);
    if (r.code !== 0) throw new Error(`[${hostId}] ${cmd.slice(0, 120)} → exit ${r.code}: ${r.stderr.trim().slice(0, 500)}`);
    return r.stdout;
  }

  /** Run a remote command and return raw stdout bytes (file contents); queued like exec(). */
  execBuf(hostId: string, cmd: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    return this.limiter(hostId).run(() => this.execBufNow(hostId, cmd, opts));
  }

  private execBufNow(hostId: string, cmd: string, opts: { timeoutMs?: number; maxBytes?: number }): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    const h = this.host(hostId);
    const max = opts.maxBytes ?? 32 * 1024 * 1024;
    return new Promise((resolve) => {
      const p = spawn(this.cfg.ssh.bin, [...this.sshArgs(h), '--', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let n = 0;
      let stderr = '';
      p.stdout.on('data', (d: Buffer) => {
        n += d.length;
        if (n > max) p.kill('SIGKILL');
        else chunks.push(d);
      });
      p.stderr.on('data', (d) => (stderr += d));
      const t = setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs ?? 30000);
      p.on('error', (e) => (stderr += String(e)));
      p.on('close', (code) => {
        clearTimeout(t);
        if (code) this.noteRefused(hostId, stderr);
        resolve({ code: n > max ? -2 : code ?? -1, stdout: Buffer.concat(chunks), stderr: n > max ? `output larger than ${max} bytes` : stderr });
      });
    });
  }

  /** Remote command with a PTY allocated on the host (terminals). */
  spawnTty(hostId: string, cmd: string): ChildProcess {
    const h = this.host(hostId);
    return this.guard(hostId, spawn(this.cfg.ssh.bin, [...this.sshArgs(h, ['-tt']), '--', cmd], { stdio: ['pipe', 'pipe', 'pipe'] }));
  }

  /** Long-lived remote process with stdio pipes (codex proxy, channel relay, app servers, tail -F). */
  spawn(hostId: string, cmd: string): ChildProcess {
    const h = this.host(hostId);
    return this.guard(hostId, spawn(this.cfg.ssh.bin, [...this.sshArgs(h, ['-T']), '--', cmd], { stdio: ['pipe', 'pipe', 'pipe'] }));
  }

  /** A spawn failure or a write after the remote end closed (EPIPE) is logged, never thrown at the hub; 'close' still fires. */
  private guard(hostId: string, p: ChildProcess): ChildProcess {
    p.on('error', (e) => L(`${hostId} ssh: ${e.message}`));
    p.stderr?.on('data', (d) => this.noteRefused(hostId, String(d)));
    for (const s of [p.stdin, p.stdout, p.stderr]) s?.on('error', (e) => L(`${hostId} ssh stream: ${e.message}`));
    return p;
  }

  /** Copy content to a remote file (cat over the multiplexed connection; equivalent to scp). */
  async put(hostId: string, remotePath: string, content: string, mode = '600') {
    const dir = remotePath.replace(/\/[^/]+$/, '') || '~';
    await this.execOk(hostId, `mkdir -p ${rpath(dir)} && umask 077 && cat > ${rpath(remotePath)} && chmod ${mode} ${rpath(remotePath)}`, { input: content });
  }

  async check(hostId: string) {
    const t0 = Date.now();
    const r = await this.exec(hostId, 'echo ok; uname -sr; command -v tmux git python3 >/dev/null && echo tools-ok', { timeoutMs: 12000 });
    const ok = r.code === 0 && r.stdout.startsWith('ok');
    const info = { latencyMs: Date.now() - t0, uname: r.stdout.split('\n')[1] || '', toolsOk: r.stdout.includes('tools-ok'), error: ok ? undefined : r.stderr.trim().slice(0, 300) };
    const prev = this.db.get('SELECT status FROM host WHERE id=?', hostId);
    this.db.run('UPDATE host SET status=?, last_seen=?, info=? WHERE id=?', ok ? 'online' : 'offline', ok ? Date.now() : prev?.last_seen ?? null, JSON.stringify(info), hostId);
    this.bus.publish('host.upsert', this.row(hostId));
    if (!ok) L(`host ${hostId} offline: ${info.error}`);
    if (ok && prev?.status === 'offline') {
      L(`host ${hostId} back online`);
      for (const f of this.onlineFns) {
        try {
          f(hostId);
        } catch (e: any) {
          L(`online handler ${hostId}: ${e.message}`);
        }
      }
    }
    return ok;
  }

  /** Called when a host that was offline answers a health check again (sessions there are recovered). */
  onOnline(f: (hostId: string) => void) {
    this.onlineFns.push(f);
  }

  row(hostId: string) {
    const r = this.db.get('SELECT * FROM host WHERE id=?', hostId)!;
    return { ...r, roots: JSON.parse(r.roots || '[]'), bins: JSON.parse(r.bins || '{}'), info: JSON.parse(r.info || '{}') };
  }

  start() {
    for (const h of this.cfg.hosts) {
      this.db.upsert('host', { id: h.id, label: h.label || h.id, target: h.target, port: h.port || 22, color: h.color || '#8A8F98', roots: h.roots || ['~/code'], bins: h.bins || {} });
      this.check(h.id);
      this.health.set(h.id, setInterval(() => this.check(h.id), 30000));
    }
  }

  stop() {
    for (const t of this.health.values()) clearInterval(t);
    for (const h of this.cfg.hosts) {
      spawn(this.cfg.ssh.bin, [...this.sshArgs(h, ['-O', 'exit'])], { stdio: 'ignore' }).on('error', () => {});
    }
  }
}
