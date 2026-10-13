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
  effortKeys: (e: string) => `/effort ${e}`,
  /** Prompts shown once per host/profile that the hub answers through tmux. */
  startupPrompts: [
    { re: /Loading development channels|I am using this for local development/i, keys: ['Enter'], name: 'dev-channel warning' },
    { re: /Enable Remote Control\? \(y\/n\)/i, keys: ['y', 'Enter'], name: 'remote-control enable' },
    { re: /Do you trust the files in this folder|Trust .*\? \[y\/N\]/i, keys: ['Enter'], name: 'workspace trust' },
  ],
  /** Idle input prompt visible: stub prints "❯"; the real TUI draws "> " inside a box (dialogs' "❯ 1." does not match). */
  isReady: (paneTail: string) => /^\s*(❯|>|│\s*>)\s*(│\s*)?$/m.test(paneTail),
  /** Remote Control session URL as printed in the pane. */
  parseRemoteControlUrl(pane: string): string | undefined {
    const m = pane.match(/https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+)/);
    return m ? `https://claude.ai/code/${m[1]}` : undefined;
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
    'cloud', 'exec', '--env', o.env, ...(o.attempts ? ['--attempts', String(o.attempts)] : []), ...(o.branch ? ['--branch', o.branch] : []), o.prompt,
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
