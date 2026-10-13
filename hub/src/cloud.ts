// Cloud adapters: spawn, steer and poll vendor-cloud sessions by running the
// official CLIs on the hub itself, under the account profile, in a scratch
// clone per repo. Claude progress arrives through repo HTTP hooks (/hooks/cloud);
// Codex progress is polled with `codex cloud list --json`.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './ctx.js';
import { ClaudeAdapter, CodexAdapter, type CodexCloudTask } from './adapters.js';
import { newId, type Session } from './store.js';
import { expandHome } from './config.js';
import type { HookEvent } from './claude/payloads.js';
import { log } from './events.js';

const L = log('cloud');

function run(bin: string, args: string[], o: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd: o.cwd, env: { ...process.env, ...o.env }, timeout: o.timeoutMs ?? 120000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export class CloudService {
  private timer?: NodeJS.Timeout;
  constructor(private c: Ctx) {}

  private profile(accountId: string) {
    const a = this.c.account(accountId);
    const base = path.join(this.c.cfg.dataDir, 'profiles', accountId);
    return {
      claudeConfigDir: expandHome(a.hub?.claudeConfigDir || path.join(base, 'claude')),
      codexHome: expandHome(a.hub?.codexHome || path.join(base, 'codex')),
      scratch: expandHome(a.hub?.scratchDir || path.join(base, 'scratch')),
    };
  }

  /** Scratch clone of the checkout's repo on the hub, at the requested branch. */
  private async scratch(accountId: string, checkoutId: string, branch?: string | null) {
    const co = this.c.repos.checkout(checkoutId);
    if (!co) throw new Error('unknown checkout');
    if (!co.remote_url) throw new Error('checkout has no remote; cloud sessions clone from the remote');
    const dir = path.join(this.profile(accountId).scratch, co.repoName);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const acct = this.c.account(accountId);
    const gitEnv = { GIT_AUTHOR_NAME: acct.git?.name || 'agent-hub', GIT_AUTHOR_EMAIL: acct.git?.email || 'hub@localhost', GIT_COMMITTER_NAME: acct.git?.name || 'agent-hub', GIT_COMMITTER_EMAIL: acct.git?.email || 'hub@localhost' };
    if (!fs.existsSync(path.join(dir, '.git'))) {
      const r = await run('git', ['clone', '-q', co.remote_url, dir], { env: gitEnv });
      if (r.code) throw new Error(`git clone failed: ${r.stderr}`);
    } else await run('git', ['-C', dir, 'fetch', '-q', 'origin'], { env: gitEnv });
    const br = branch || co.branch || 'main';
    const has = await run('git', ['-C', dir, 'rev-parse', '--verify', '-q', `origin/${br}`]);
    if (has.code === 0) await run('git', ['-C', dir, 'checkout', '-q', '-B', br, `origin/${br}`]);
    else await run('git', ['-C', dir, 'checkout', '-q', '-B', br]);
    return { dir, co, branch: br };
  }

  // ------------------------------------------------------------ Claude cloud
  async startClaude(o: { accountId: string; checkoutId: string; branch?: string | null; environment?: string; prompt: string }): Promise<Session> {
    const { dir, co, branch } = await this.scratch(o.accountId, o.checkoutId, o.branch);
    const env = { CLAUDE_CONFIG_DIR: this.profile(o.accountId).claudeConfigDir };
    const r = await run(this.c.cfg.adapters.claude.cloudBin, ClaudeAdapter.cloudStartArgs(o.prompt), { cwd: dir, env });
    const parsed = ClaudeAdapter.parseCloudStart(r.stdout + '\n' + r.stderr);
    if (r.code || !parsed) throw new Error(`claude --cloud failed (${r.code}): ${(r.stderr || r.stdout).slice(0, 400)}`);
    L(`claude cloud ${parsed.sessionId} for ${co.repoName}@${branch}`);
    const s = this.c.store.upsertSession({
      id: newId('ccc-'), vendor: 'claude', kind: 'cloud', host_id: null, account_id: o.accountId, checkout_id: o.checkoutId, cwd: null, branch,
      native_id: parsed.sessionId, native_url: parsed.url, title: o.prompt.slice(0, 60), status: 'running', last_event: 'created', model: null, effort: null,
      meta: { environment: o.environment || 'Default', cloudStatus: 'running', repo: co.repoName },
    });
    this.c.store.upsertMessage({ id: `ccm-${s.id}-0`, session_id: s.id, role: 'user', kind: 'text', text: o.prompt, data: null });
    return s;
  }

  async sendClaude(id: string, text: string) {
    const s = this.c.store.session(id)!;
    const env = { CLAUDE_CONFIG_DIR: this.profile(s.account_id).claudeConfigDir };
    const r = await run(this.c.cfg.adapters.claude.cloudBin, ClaudeAdapter.cloudSendArgs(s.native_id!, text), { env });
    const p = ClaudeAdapter.parseCloudSend(r.stdout);
    if (!p.ok) throw new Error(`claude -p --cloud failed: ${p.error || r.stderr.slice(0, 300)}`);
    this.c.store.upsertMessage({ id: `ccm-${id}-${Date.now()}`, session_id: id, role: 'user', kind: 'text', text, data: { queued: true } });
    this.c.store.upsertSession({ id, status: 'running', last_event: 'message queued', meta: { cloudStatus: 'running' } });
  }

  /** Repo hooks from cloud sessions (Bearer = cloud-environment network secret). */
  onCloudHook(h: HookEvent) {
    let s = this.c.store.sessionByNative(h.sessionId);
    if (!s) {
      // a cloud session started natively on a repo with hub hooks: list it
      s = this.c.store.upsertSession({
        id: newId('ccc-'), vendor: 'claude', kind: 'cloud', host_id: null, account_id: this.c.cfg.accounts[0]?.id ?? 'unknown', checkout_id: null, cwd: h.cwd ?? null,
        branch: null, native_id: h.sessionId, native_url: h.sessionId.startsWith('session_') ? `https://claude.ai/code/${h.sessionId}` : null,
        title: (h.prompt || 'Claude cloud session').slice(0, 60), status: 'running', last_event: 'seen via hooks', model: null, effort: null, meta: { startedNatively: true },
      });
    }
    const id = s.id;
    switch (h.event) {
      case 'UserPromptSubmit':
        this.c.store.upsertSession({ id, status: 'running', last_event: 'prompt', meta: { cloudStatus: 'running' } });
        break;
      case 'PostToolUse':
        this.c.store.upsertMessage({ id: `cch-${id}-${h.toolUseId || Date.now()}`, session_id: id, role: 'tool', kind: 'tool', text: `${h.toolName} ${JSON.stringify(h.toolInput).slice(0, 200)}`, data: { via: 'hook' } });
        this.c.store.upsertSession({ id, last_event: `tool ${h.toolName}` });
        break;
      case 'Stop':
        if (h.lastAssistantMessage) this.c.store.upsertMessage({ id: `ccs-${id}-${Date.now()}`, session_id: id, role: 'assistant', kind: 'text', text: h.lastAssistantMessage, data: { via: 'hook' } });
        this.c.store.upsertSession({ id, status: 'idle', last_event: 'turn finished', meta: { cloudStatus: 'idle' } });
        this.c.push.notify({ title: 'Claude cloud session finished a turn', body: s.title, tag: id, url: `/?focus=${id}` });
        break;
    }
  }

  // ------------------------------------------------------------ Codex cloud
  async startCodex(o: { accountId: string; checkoutId: string; branch?: string | null; environment: string; prompt: string; attempts?: number }): Promise<Session> {
    if (!o.environment) throw new Error('Codex cloud needs an environment (--env)');
    const { dir, co, branch } = await this.scratch(o.accountId, o.checkoutId, o.branch);
    const env = { CODEX_HOME: this.profile(o.accountId).codexHome };
    const r = await run(this.c.cfg.adapters.codex.cloudBin, CodexAdapter.cloudExecArgs({ env: o.environment, attempts: o.attempts, branch, prompt: o.prompt }), { cwd: dir, env });
    const parsed = CodexAdapter.parseCloudExec(r.stdout);
    if (r.code || !parsed) throw new Error(`codex cloud exec failed (${r.code}): ${(r.stderr || r.stdout).slice(0, 400)}`);
    L(`codex cloud ${parsed.taskId} for ${co.repoName}@${branch}`);
    const s = this.c.store.upsertSession({
      id: newId('cxc-'), vendor: 'codex', kind: 'cloud', host_id: null, account_id: o.accountId, checkout_id: o.checkoutId, cwd: null, branch,
      native_id: parsed.taskId, native_url: parsed.url, title: o.prompt.slice(0, 60), status: 'pending', last_event: 'created', model: null, effort: null,
      meta: { environment: o.environment, attempts: o.attempts ?? 1, cloudStatus: 'pending', repo: co.repoName },
    });
    this.c.store.upsertMessage({ id: `cxm-${s.id}-0`, session_id: s.id, role: 'user', kind: 'text', text: o.prompt, data: null });
    setTimeout(() => this.pollCodex().catch(() => {}), 1000);
    return s;
  }

  /** Poll `codex cloud list --json` per account; lists tasks started anywhere (web, Slack, GitHub). */
  async pollCodex() {
    const accounts = new Set(this.c.cfg.accounts.filter((a) => a.codex || a.hub?.codexHome).map((a) => a.id));
    for (const acc of accounts) {
      const env = { CODEX_HOME: this.profile(acc).codexHome };
      const r = await run(this.c.cfg.adapters.codex.cloudBin, CodexAdapter.cloudListArgs(20), { env, timeoutMs: 30000 });
      if (r.code) continue;
      let tasks: CodexCloudTask[];
      try {
        tasks = CodexAdapter.parseCloudList(r.stdout).tasks;
      } catch (e: any) {
        L(`codex cloud list (${acc}): ${e.message}`);
        continue;
      }
      for (const t of tasks) {
        const s = this.c.store.sessionByNative(t.id);
        const status = (['pending', 'ready', 'applied', 'error'].includes(t.status) ? t.status : 'pending') as Session['status'];
        const diff = t.summary?.files_changed ? `+${t.summary.lines_added}/-${t.summary.lines_removed} · ${t.summary.files_changed} files` : 'no diff yet';
        if (!s) {
          this.c.store.upsertSession({
            id: newId('cxc-'), vendor: 'codex', kind: 'cloud', host_id: null, account_id: acc, checkout_id: null, cwd: null, branch: null,
            native_id: t.id, native_url: t.url, title: t.title, status, last_event: 'listed', model: null, effort: null,
            meta: { environment: t.environment_label ?? t.environment_id, cloudStatus: t.status, diffSummary: diff, startedNatively: true },
          });
        } else if (s.status !== status || s.meta.diffSummary !== diff) {
          this.c.store.upsertSession({ id: s.id, status, last_event: `cloud ${t.status}`, meta: { cloudStatus: t.status, diffSummary: diff } });
          if (status === 'ready' && s.status !== 'ready') this.c.push.notify({ title: 'Codex cloud task ready', body: `${s.title} (${diff})`, tag: s.id, url: `/?focus=${s.id}` });
          if (status === 'error' && s.status !== 'error') this.c.push.notify({ title: 'Codex cloud task failed', body: s.title, tag: s.id, url: `/?focus=${s.id}` });
        }
      }
    }
  }

  /** Status + diff for one task (diff shown as a message). */
  async refreshCodex(id: string) {
    const s = this.c.store.session(id)!;
    const env = { CODEX_HOME: this.profile(s.account_id).codexHome };
    const st = await run(this.c.cfg.adapters.codex.cloudBin, CodexAdapter.cloudStatusArgs(s.native_id!), { env });
    this.c.store.upsertSession({ id, last_event: st.stdout.split('\n')[0] || st.stderr.trim() });
    const d = await run(this.c.cfg.adapters.codex.cloudBin, CodexAdapter.cloudDiffArgs(s.native_id!), { env });
    if (d.code === 0 && d.stdout.trim())
      this.c.store.upsertMessage({ id: `cxd-${id}`, session_id: id, role: 'tool', kind: 'tool', text: 'diff', data: { diff: d.stdout } });
    await this.pollCodex();
  }

  start() {
    const tick = () => this.pollCodex().catch((e) => L(`poll: ${e.message}`));
    this.timer = setInterval(tick, this.c.cfg.cloudPollIntervalSec * 1000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
