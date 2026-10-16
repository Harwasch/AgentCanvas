// Claude sessions started outside the hub (Claude Desktop, a terminal): read-only canvas nodes.
// Every claudeImportIntervalSec each online host lists the transcripts in its Claude profile dirs
// (`hub_channel.py claude-scan`). Recent ones (claudeImportDays) the hub did not start become sessions with
// meta.external; new transcript lines are read into messages. Nothing is sent to them: chat, interrupt and
// approvals stay in the app that owns them, until you take one over (ClaudeDriver.takeover, `claude --resume`).
import type { Ctx } from '../ctx.js';
import { q } from '../ssh.js';
import { newId, type Session } from '../store.js';
import { log } from '../events.js';

const L = log('claude-import');

/** One transcript as summarised on the host. */
export interface ScanRec {
  file: string;
  sessionId: string;
  mtime: number;
  size: number;
  /** complete lines in the file */
  lines: number;
  cwd: string | null;
  branch: string | null;
  /** claude-desktop, cli, sdk-… */
  entrypoint: string | null;
  title: string | null;
  firstPrompt: string | null;
}

/** a transcript written to this recently counts as a turn in progress */
export const ACTIVE_MS = 90_000;
/** lines read from an existing transcript when it first appears (older history stays in the app) */
export const FIRST_LINES = 300;

/** What to do with one scanned transcript, given the session row the hub already has for it (if any). */
export function importAction(r: ScanRec, existing: Session | undefined, since: number): 'skip' | 'new' | 'update' {
  if (!/^[0-9a-f-]{36}$/i.test(r.sessionId) || !r.cwd || !r.lines) return 'skip';
  if (existing) {
    if (!existing.meta?.external) return 'skip'; // started (or taken over) by the hub: its own tail reads it
    if (existing.meta.hidden) return 'skip'; // you removed it from the canvas
    return 'update';
  }
  return r.mtime >= since ? 'new' : 'skip';
}

export function importTitle(r: ScanRec): string {
  const t = (r.title || r.firstPrompt || '').replace(/\s+/g, ' ').trim();
  return (t || `Claude · ${r.cwd?.split('/').filter(Boolean).pop() || 'session'}`).slice(0, 80);
}

export function sourceLabel(entrypoint: string | null): string {
  if (entrypoint === 'claude-desktop') return 'Claude app';
  if (entrypoint === 'cli') return 'terminal';
  return entrypoint || 'outside the hub';
}

/** First transcript line (0-based) to read: continue after what was read, or the tail of a transcript seen for the first time. */
export function readFrom(r: ScanRec, tLines: number | undefined): number {
  return tLines != null ? Math.min(tLines, r.lines) : Math.max(0, r.lines - FIRST_LINES);
}

/** GitHub owner in a remote URL (https or scp-style), for picking the account a session belongs to. */
export function remoteOwner(url: string | null | undefined): string | undefined {
  return url?.match(/github\.com[:/]+([^/]+)\//i)?.[1];
}

export class ClaudeImporter {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(private c: Ctx) {}

  start() {
    const sec = this.c.cfg.claudeImportIntervalSec;
    if (!sec || this.c.cfg.claudeImportDays <= 0) return;
    const tick = () => this.scanAll().catch((e) => L(`scan: ${e.message}`));
    setTimeout(tick, 8000);
    this.timer = setInterval(tick, sec * 1000);
  }
  stop() {
    clearInterval(this.timer);
  }

  async scanAll() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const h of this.c.cfg.hosts) {
        if ((this.c.hosts.row(h.id) as any)?.status === 'offline') continue;
        await this.scanHost(h.id).catch((e) => L(`${h.id}: ${e.message}`));
      }
    } finally {
      this.busy = false;
    }
  }

  async scanHost(hostId: string) {
    const info = await this.c.boot.ensure(hostId);
    // profile dir on this host → the accounts that use it (several accounts may share one login)
    const dirs = new Map<string, string[]>();
    for (const a of this.c.cfg.accounts) {
      const d = (a.claude?.configDir || '~/.claude').replace(/\/+$/, '');
      const abs = d.startsWith('~/') ? `${info.home}/${d.slice(2)}` : d;
      dirs.set(abs, [...(dirs.get(abs) || []), a.id]);
    }
    const since = Date.now() - this.c.cfg.claudeImportDays * 86400_000;
    const py = q(this.c.hosts.bin(hostId, 'python'));
    for (const [dir, accounts] of dirs) {
      const r = await this.c.hosts.exec(hostId, `${py} ${q(info.base + '/hub_channel.py')} claude-scan ${q(dir + '/projects')} ${Math.floor(since)}`, { timeoutMs: 30000 });
      if (r.code !== 0) throw new Error(`claude-scan exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
      const recs: ScanRec[] = JSON.parse(r.stdout || '[]');
      for (const rec of recs) await this.ingest(hostId, accounts, rec, since).catch((e) => L(`${hostId} ${rec.sessionId}: ${e.message}`));
    }
  }

  private accountFor(accounts: string[], checkout?: any): string {
    const owner = remoteOwner(checkout?.remote_url);
    const a = owner ? this.c.projects.gh.accountFor(owner) : undefined;
    return a && accounts.includes(a.id) ? a.id : accounts[0];
  }

  private async ingest(hostId: string, accounts: string[], r: ScanRec, since: number) {
    const existing = this.c.store.sessionByNative(r.sessionId);
    const act = importAction(r, existing, since);
    if (act === 'skip') return;
    const active = Date.now() - r.mtime < ACTIVE_MS;
    const status = active ? 'running' : 'idle';
    if (act === 'update' && existing!.meta.size === r.size && existing!.meta.mtime === r.mtime) {
      if (existing!.status !== status) this.c.store.setStatus(existing!.id, status);
      return;
    }
    const co = this.c.repos.checkoutForPath(hostId, r.cwd!);
    const id = existing?.id ?? newId('cc-');
    const from = readFrom(r, existing?.meta.tLines);
    let read = from;
    if (r.lines > from) {
      // only complete lines, at most 4 MB per pass; the rest is read on the next scan
      const out = await this.c.hosts.exec(hostId, `tail -n +${from + 1} -- ${q(r.file)} | head -n ${r.lines - from} | head -c 4000000`, { timeoutMs: 30000 });
      if (out.code !== 0) throw new Error(`reading transcript: ${out.stderr.trim().slice(0, 200)}`);
      if (!existing) this.upsert(id, hostId, accounts, r, co, status, from);
      const lines = out.stdout.split('\n');
      lines.pop(); // after the last newline: empty, or a line cut by the byte cap
      for (const line of lines) {
        read++;
        try {
          this.c.claude.onTranscript(id, line);
        } catch (e: any) {
          L(`${id}: transcript line: ${e.message}`);
        }
      }
    }
    this.upsert(id, hostId, accounts, r, co, status, read, existing);
    if (!existing) L(`${id}: imported ${r.sessionId} (${sourceLabel(r.entrypoint)}) on ${hostId} in ${r.cwd}`);
  }

  private upsert(id: string, hostId: string, accounts: string[], r: ScanRec, co: any, status: 'running' | 'idle', tLines: number, existing?: Session) {
    this.c.store.upsertSession({
      id, vendor: 'claude', kind: 'local', host_id: hostId,
      account_id: existing?.account_id ?? this.accountFor(accounts, co),
      checkout_id: co?.id ?? null, cwd: r.cwd, branch: r.branch, native_id: r.sessionId,
      title: importTitle(r), status,
      last_event: active(status) ? `active in the ${sourceLabel(r.entrypoint)}` : `started in the ${sourceLabel(r.entrypoint)}`,
      meta: { external: true, source: r.entrypoint, transcript: r.file, tLines, size: tLines >= r.lines ? r.size : -1, mtime: r.mtime },
    });
  }
}

const active = (s: string) => s === 'running';
