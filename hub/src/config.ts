// Hub configuration: one JSON file, seeded into SQLite on start.
// Every real-CLI path lives under `adapters` (or per-host `bins`), so swapping
// the stubs for the vendor binaries is a config change only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export interface HostConfig {
  id: string;
  label?: string;
  /** ssh destination, e.g. "hub@minipc-a" (a Tailscale MagicDNS name in production) */
  target: string;
  port?: number;
  color?: string;
  /** directories scanned for git checkouts (depth 2), `~` allowed */
  roots?: string[];
  /** per-host override of vendor binary paths */
  bins?: { claude?: string; codex?: string; python?: string; git?: string; tmux?: string; nvidiaSmi?: string };
  /** bench hardware on this host; status from `probe` (exit 0 = connected). ids are host-local. */
  devices?: DeviceConfig[];
  /** hardware-in-the-loop plans runnable on this host (output in the hub HIL line protocol) */
  hil?: HilPlanConfig[];
  /** how app servers marked always-on are supervised: systemd-run --user, or a tmux-held ssh stdio session */
  appSupervisor?: 'ssh-stdio' | 'systemd-run';
}

export interface DeviceConfig {
  id: string;
  title: string;
  kind?: string;
  icon?: string;
  port?: string;
  fw?: string;
  parentId?: string;
  probe?: string;
}

export interface HilPlanConfig {
  id: string;
  title: string;
  command: string;
  cwd?: string;
  devices?: string[];
  plan?: string;
  setup?: string[];
}

export interface AccountConfig {
  id: string;
  label?: string;
  color?: string;
  claude?: { configDir?: string };
  codex?: { home?: string };
  git?: { name?: string; email?: string };
  /** gh / ssh host alias used for GitHub calls of this account */
  /** GitHub through the official `gh` CLI: GH_CONFIG_DIR on the hub (log in once with `gh auth login`), and the owners this account covers */
  gh?: { configDir?: string; owners?: string[]; hostAlias?: string };
  /** profile dirs on the hub itself, used by cloud adapters */
  hub?: { claudeConfigDir?: string; codexHome?: string; scratchDir?: string };
  cloud?: {
    claudeEnvironments?: { id: string; label: string; routineId?: string }[];
    codexEnvironments?: { id: string; label: string }[];
  };
}

export interface HubConfig {
  listen: { host: string; port: number };
  /** URL browsers use (tailscale serve name in production) */
  publicUrl: string;
  /** URL hosts use to POST hooks / MCP tool calls back to the hub */
  hostCallbackUrl: string;
  /** URL vendor clouds use for repo hooks (Funnel / tunnel); optional */
  cloudCallbackUrl?: string;
  /** null = plain HTTP (e.g. behind `tailscale serve`, which terminates TLS) */
  tls: { cert: string; key: string; ca?: string } | null;
  dataDir: string;
  adapters: {
    claude: { bin: string; cloudBin: string };
    codex: { bin: string; cloudBin: string };
    gh: { bin: string };
  };
  ssh: { bin: string; identityFile?: string; extraArgs?: string[]; controlDir?: string };
  hosts: HostConfig[];
  accounts: AccountConfig[];
  screenshot: { chromiumPath?: string };
  push: { subject: string };
  repoIndexIntervalSec: number;
  cloudPollIntervalSec: number;
  githubPollIntervalSec: number;
  metricsIntervalSec: number;
  /** auto-answer dev-channel warning / one-time Remote Control prompt in tmux */
  autoAnswerStartupPrompts: boolean;
  /** serve plain HTTP on a non-loopback address with a non-https publicUrl (tokens and cookies in clear text) */
  allowInsecureHttp?: boolean;
}

export interface Secrets {
  hubToken: string;
  hookToken: string;
  cloudHookToken: string;
  /** bearer token for the external /mcp endpoint (Claude Code / Desktop on your machines) */
  mcpToken: string;
  vapid?: { publicKey: string; privateKey: string };
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const DEFAULTS: HubConfig = {
  listen: { host: '0.0.0.0', port: 8443 },
  publicUrl: 'https://localhost:8443',
  hostCallbackUrl: 'https://localhost:8443',
  tls: null,
  dataDir: '~/.agent-hub',
  adapters: {
    claude: { bin: 'claude', cloudBin: 'claude' },
    codex: { bin: 'codex', cloudBin: 'codex' },
    gh: { bin: 'gh' },
  },
  ssh: { bin: 'ssh' },
  hosts: [],
  accounts: [],
  screenshot: {},
  push: { subject: 'mailto:hub@localhost' },
  repoIndexIntervalSec: 60,
  cloudPollIntervalSec: 15,
  githubPollIntervalSec: 60,
  metricsIntervalSec: 10,
  autoAnswerStartupPrompts: true,
};

export function loadConfig(file?: string): { config: HubConfig; file: string } {
  const f = path.resolve(file || process.env.HUB_CONFIG || 'config/hub.config.json');
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  const config: HubConfig = {
    ...DEFAULTS,
    ...raw,
    listen: { ...DEFAULTS.listen, ...(raw.listen || {}) },
    adapters: {
      claude: { ...DEFAULTS.adapters.claude, ...(raw.adapters?.claude || {}) },
      codex: { ...DEFAULTS.adapters.codex, ...(raw.adapters?.codex || {}) },
      gh: { ...DEFAULTS.adapters.gh, ...(raw.adapters?.gh || {}) },
    },
    ssh: { ...DEFAULTS.ssh, ...(raw.ssh || {}) },
    screenshot: { ...DEFAULTS.screenshot, ...(raw.screenshot || {}) },
    push: { ...DEFAULTS.push, ...(raw.push || {}) },
  };
  config.dataDir = expandHome(config.dataDir);
  if (config.tls) {
    config.tls.cert = expandHome(config.tls.cert);
    config.tls.key = expandHome(config.tls.key);
  }
  const insecure = insecureHttp(config);
  if (insecure && !config.allowInsecureHttp)
    throw new Error(`refusing to start: ${insecure}. Use tls, put the hub behind tailscale serve (https publicUrl, listen on 127.0.0.1), or set "allowInsecureHttp": true`);
  if (insecure) console.warn(`[config] WARNING: ${insecure} ("allowInsecureHttp": true)`);
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  return { config, file: f };
}

/** Why this config would send the hub token in clear text over the network, or null. */
export function insecureHttp(c: Pick<HubConfig, 'tls' | 'publicUrl' | 'listen'>): string | null {
  if (c.tls || /^https:/i.test(c.publicUrl)) return null;
  if (/^(127\.\d+\.\d+\.\d+|::1|localhost)$/i.test(c.listen.host)) return null;
  return `plain HTTP on ${c.listen.host}:${c.listen.port} with publicUrl ${c.publicUrl}: the hub token and cookie would cross the network unencrypted`;
}

export function loadSecrets(dataDir: string): Secrets {
  const f = path.join(dataDir, 'secrets.json');
  let s: Partial<Secrets> = {};
  if (fs.existsSync(f)) s = JSON.parse(fs.readFileSync(f, 'utf8'));
  const tok = () => crypto.randomBytes(24).toString('base64url');
  const out: Secrets = {
    hubToken: process.env.HUB_TOKEN || s.hubToken || tok(),
    hookToken: s.hookToken || tok(),
    cloudHookToken: s.cloudHookToken || tok(),
    mcpToken: s.mcpToken || tok(),
    vapid: s.vapid,
  };
  fs.writeFileSync(f, JSON.stringify(out, null, 2), { mode: 0o600 });
  return out;
}

export function saveSecrets(dataDir: string, s: Secrets) {
  fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify(s, null, 2), { mode: 0o600 });
}
