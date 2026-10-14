// One adapter per agent vendor. Every invocation of a vendor CLI is built and
// every vendor output is parsed here, so swapping the stubs for the real
// binaries is a config change (adapters.*.bin) and CLI drift is fixed in one file.
import { q, rpath } from './ssh.js';

export interface ClaudeLaunch {
  bin: string;
  hubId: string;
  sessionUuid: string;
  rcName: string;
  settingsFile: string; // remote path
  mcpConfigFile: string; // remote path
  resume?: boolean;
  model?: string;
}

/** footer of the real TUI's selection dialogs */
const DIALOG_RE = /Enter to confirm · Esc to cancel/;

export const ClaudeAdapter = {
  /** Interactive launch inside tmux (doc: claude --remote-control '<hubId> · <repo>' --session-id <uuid> --dangerously-load-development-channels server:hub). */
  launchCommand(o: ClaudeLaunch): string {
    const a = [
      q(o.bin),
      '--remote-control', q(o.rcName),
      o.resume ? '--resume' : '--session-id', q(o.sessionUuid),
      '--settings', rpath(o.settingsFile),
      '--mcp-config', rpath(o.mcpConfigFile),
      '--dangerously-load-development-channels', 'server:hub',
    ];
    if (o.model) a.push('--model', q(o.model));
    return a.join(' ');
  },
  interruptKeys: ['Escape'],
  modelKeys: (m: string) => `/model ${m}`,
  /** 2.1.29x: `/model` mid-conversation asks to confirm (cache re-read); "Yes, switch" is preselected */
  modelConfirm: { re: /Switch model\?/, keys: ['Enter'] },
  effortKeys: (e: string) => `/effort ${e}`,
  /** Prompts shown once per host/profile that the hub answers through tmux. */
  startupPrompts: [
    { re: /Loading development channels|I am using this for local development/i, keys: ['Enter'], name: 'dev-channel warning' },
    { re: /Enable Remote Control\? \(y\/n\)/i, keys: ['y', 'Enter'], name: 'remote-control enable' },
    { re: /Do you trust the files in this folder|Trust .*\? \[y\/N\]/i, keys: ['Enter'], name: 'workspace trust' },
    // v2.1.296: "❯ No, exit" is listed first and preselected, so Enter alone would exit
    { re: /Is this a project you created or one you trust/i, keys: ['Down', 'Enter'], name: 'workspace trust (2.1.29x)' },
    // one-time promo; the fullscreen renderer would change what the hub scrapes from the pane
    { re: /Try the new fullscreen renderer\?/i, keys: ['Down', 'Enter'], name: 'fullscreen renderer: not now' },
  ],
  /** A selection dialog is open (startup prompt, picker); the pane is not at the input prompt. */
  dialogOpen: (paneTail: string) => DIALOG_RE.test(paneTail),
  /**
   * Idle input prompt visible: stub prints "❯"; the real TUI (2.1.29x) draws "❯ " with an optional placeholder
   * between two ─ rules. Dialog options ("❯ 1. …") are not ruled off like that.
   */
  isReady: (paneTail: string) =>
    !DIALOG_RE.test(paneTail) &&
    (/^\s*(❯|>|│\s*>)\s*(│\s*)?$/m.test(paneTail) || /^\s*─{3,}.*\n❯ .*\n\s*─{3,}/m.test(paneTail)),
  /** Remote Control session URL as printed in the pane. */
  parseRemoteControlUrl(pane: string): string | undefined {
    const m = pane.match(/https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+)/);
    return m ? `https://claude.ai/code/${m[1]}` : undefined;
  },
  /**
   * Shell env prefix for the session's profile. Setting CLAUDE_CONFIG_DIR at all moves the state file from
   * ~/.claude.json to $CLAUDE_CONFIG_DIR/.claude.json, so for the default ~/.claude it is unset instead:
   * the session then shares the user's own setup (onboarding, trusted folders, MCP servers).
   */
  configDirEnv(home: string, configDir: string): string {
    const norm = (p: string) => p.replace(/\/+$/, '');
    return norm(configDir) === `${norm(home)}/.claude` ? 'unset CLAUDE_CONFIG_DIR; export ' : `export CLAUDE_CONFIG_DIR=${q(configDir)} `;
  },
  transcriptPath(configDir: string, cwd: string, uuid: string) {
    return `${configDir.replace(/\/$/, '')}/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-').slice(0, 200)}/${uuid}.jsonl`;
  },

  // ---- cloud (run on the hub, in a scratch checkout, under the account's CLAUDE_CONFIG_DIR)
  cloudStartArgs: (task: string) => ['--cloud', task],
  /** `claude --cloud` stdout format is undocumented: take the first session_… id and claude.ai URL anywhere in the output. */
  parseCloudStart(stdout: string): { sessionId: string; url: string } | undefined {
    const url = stdout.match(/https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+)/);
    const id = url?.[1] || stdout.match(/\b(session_[A-Za-z0-9]{10,})\b/)?.[1];
    if (!id) return undefined;
    return { sessionId: id, url: `https://claude.ai/code/${id}` };
  },
  cloudSendArgs: (id: string, msg: string) => ['-p', msg, '--cloud', id, '--output-format', 'json'],
  parseCloudSend(stdout: string): { ok: boolean; sessionId?: string; url?: string; error?: string } {
    try {
      const o = JSON.parse(stdout.trim().split('\n').pop() || '{}');
      return { ok: !!o.ok, sessionId: o.session_id, url: o.url, error: o.error };
    } catch {
      return { ok: false, error: `unparseable output: ${stdout.slice(0, 200)}` };
    }
  },
};

export interface CodexCloudTask {
  id: string;
  url: string;
  title: string;
  status: 'pending' | 'ready' | 'applied' | 'error' | string;
  updated_at: string;
  environment_id: string | null;
  environment_label: string | null;
  summary: { files_changed: number; lines_added: number; lines_removed: number };
  attempt_total: number | null;
}

export const CodexAdapter = {
  daemonStart: (bin: string, codexHome: string) => `CODEX_HOME=${rpath(codexHome)} ${q(bin)} app-server daemon start`,
  proxy: (bin: string, codexHome: string) => `CODEX_HOME=${rpath(codexHome)} exec ${q(bin)} app-server proxy`,
  /** daemon start prints one JSON object line */
  parseLifecycle(stdout: string): { status: string; socketPath?: string; pid?: number } | undefined {
    for (const line of stdout.trim().split('\n').reverse()) {
      try {
        const o = JSON.parse(line);
        if (o && typeof o.status === 'string') return o;
      } catch {}
    }
    return undefined;
  },
  clientInfo: { name: 'agent_hub', title: 'Agent Hub', version: '0.1.0' },
  /** [mcp_servers.hub] block written into each account's config.toml */
  mcpConfigBlock(pythonBin: string, scriptPath: string) {
    return [
      '# >>> agent-hub (managed; do not edit between markers)',
      '[mcp_servers.hub]',
      `command = ${JSON.stringify(pythonBin)}`,
      `args = [${JSON.stringify(scriptPath)}, "--mcp-only"]`,
      'startup_timeout_sec = 20',
      'tool_timeout_sec = 180',
      '# <<< agent-hub',
    ].join('\n');
  },

  // ---- cloud (run on the hub under the account's CODEX_HOME)
  cloudExecArgs: (o: { env: string; attempts?: number; branch?: string; prompt: string }) => [
    'cloud', 'exec', '--env', o.env, ...(o.attempts ? ['--attempts', String(o.attempts)] : []), ...(o.branch ? ['--branch', o.branch] : []), '--', o.prompt,
  ],
  parseCloudExec(stdout: string): { taskId: string; url: string } | undefined {
    const m = stdout.match(/https:\/\/chatgpt\.com\/codex\/tasks\/([A-Za-z0-9_-]+)/);
    return m ? { taskId: m[1], url: m[0] } : undefined;
  },
  cloudListArgs: (limit = 20, cursor?: string) => ['cloud', 'list', '--json', '--limit', String(limit), ...(cursor ? ['--cursor', cursor] : [])],
  parseCloudList(stdout: string): { tasks: CodexCloudTask[]; cursor: string | null } {
    const o = JSON.parse(stdout);
    if (!o || !Array.isArray(o.tasks)) throw new Error('codex cloud list: no tasks array');
    return { tasks: o.tasks, cursor: o.cursor ?? null };
  },
  cloudStatusArgs: (id: string) => ['cloud', 'status', id],
  cloudDiffArgs: (id: string) => ['cloud', 'diff', id],
  cloudApplyArgs: (id: string) => ['cloud', 'apply', id],
};

// ---------------------------------------------------------------- GitHub (official `gh` CLI, one GH_CONFIG_DIR per account)
export interface GhPull { number: number; title: string; state: 'open' | 'closed'; draft: boolean; merged_at: string | null; html_url: string; head: { ref: string; sha: string | null }; base: { ref: string } }

export const GitHubAdapter = {
  /** owner/repo from https://github.com/o/r(.git), git@github.com:o/r.git, ssh://git@github.com/o/r, or an ssh alias host github.com-<x> */
  parseRemote(url: string | null | undefined): { owner: string; repo: string } | undefined {
    if (!url) return undefined;
    const m = url.match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com(?:-[\w.-]+)?[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
    return m ? { owner: m[1], repo: m[2] } : undefined;
  },
  api: (endpoint: string, raw = false) => ['api', endpoint, ...(raw ? ['-H', 'Accept: application/vnd.github.raw'] : [])],
  repo: (o: string, r: string) => `repos/${o}/${r}`,
  /** list endpoints are paged with page=N by GitHub.list (capped); per_page is the page size it checks for the last page */
  branches: (o: string, r: string) => `repos/${o}/${r}/branches?per_page=100`,
  /** every open PR (paged), plus the most recently updated closed/merged ones (one page) for merged-state chips */
  openPulls: (o: string, r: string) => `repos/${o}/${r}/pulls?state=open&per_page=100&sort=updated&direction=desc`,
  recentClosedPulls: (o: string, r: string) => `repos/${o}/${r}/pulls?state=closed&per_page=50&sort=updated&direction=desc`,
  page: (endpoint: string, n: number) => `${endpoint}${endpoint.includes('?') ? '&' : '?'}page=${n}`,
  /** the page size an endpoint asks for (30 is GitHub's default) */
  perPage: (endpoint: string) => Number(endpoint.match(/[?&]per_page=(\d+)/)?.[1] || 30),
  reviews: (o: string, r: string, n: number) => `repos/${o}/${r}/pulls/${n}/reviews?per_page=100`,
  checkRuns: (o: string, r: string, sha: string) => `repos/${o}/${r}/commits/${sha}/check-runs?per_page=100`,
  /** combined commit status (the older Statuses API: external CI, deploy bots) */
  combinedStatus: (o: string, r: string, sha: string) => `repos/${o}/${r}/commits/${sha}/status?per_page=100`,
  commits: (o: string, r: string, ref: string, n = 8, path?: string) => `repos/${o}/${r}/commits?sha=${encodeURIComponent(ref)}&per_page=${n}${path ? `&path=${encodeURIComponent(path)}` : ''}`,
  compare: (o: string, r: string, base: string, head: string) => `repos/${o}/${r}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  tree: (o: string, r: string, ref: string) => `repos/${o}/${r}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  contents: (o: string, r: string, path: string, ref: string) => `repos/${o}/${r}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
  prState(p: GhPull): 'open' | 'draft' | 'merged' | 'closed' {
    if (p.merged_at) return 'merged';
    if (p.state === 'open') return p.draft ? 'draft' : 'open';
    return 'closed';
  },
  /** CI rollup over check runs plus commit statuses (success/failure/error/pending). */
  ciState(runs: { status: string; conclusion: string | null }[], statuses: { state: string }[] = []): { state: 'success' | 'failure' | 'pending' | 'none'; total: number; passed: number; failed: number } {
    const total = runs.length + statuses.length;
    const passed = runs.filter((r) => r.status === 'completed' && ['success', 'neutral', 'skipped'].includes(String(r.conclusion))).length
      + statuses.filter((x) => x.state === 'success').length;
    const failed = runs.filter((r) => r.status === 'completed' && ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(String(r.conclusion))).length
      + statuses.filter((x) => x.state === 'failure' || x.state === 'error').length;
    const state = !total ? 'none' : failed ? 'failure' : passed === total ? 'success' : 'pending';
    return { state, total, passed, failed };
  },
};
