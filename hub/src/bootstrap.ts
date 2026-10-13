// Per-host bootstrap: the only files the hub puts on a host are the channel/MCP
// script, its env file, the hub CA (self-signed setups), the hook settings file,
// the MCP config for Claude, and a managed [mcp_servers.hub] block in Codex config.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HubConfig, AccountConfig } from './config.js';
import type { Secrets } from './config.js';
import { HostManager, rpath, q } from './ssh.js';
import { CodexAdapter } from './adapters.js';
import { log } from './events.js';
import { CANVAS_TOOL_NAMES } from './canvas.js';

const L = log('bootstrap');
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOST_FILES = path.resolve(HERE, '../../host-files');

export interface HostInfo {
  home: string;
  base: string; // ~/.agent-hub absolute
}

const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Notification'];

export function claudeHookSettings(cfg: HubConfig) {
  const hook = (timeout: number) => ({
    type: 'http',
    url: `${cfg.hostCallbackUrl.replace(/\/$/, '')}/hooks/claude`,
    headers: { Authorization: 'Bearer $HUB_HOOK_TOKEN' },
    allowedEnvVars: ['HUB_HOOK_TOKEN'],
    timeout,
  });
  const hooks: Record<string, any[]> = {};
  for (const ev of HOOK_EVENTS) {
    const tool = ['PreToolUse', 'PermissionRequest', 'PostToolUse'].includes(ev);
    // PermissionRequest may be held open by the hub while you decide (fallback when the channel is down)
    hooks[ev] = [{ ...(tool ? { matcher: '*' } : {}), hooks: [hook(ev === 'PermissionRequest' ? 130 : 15)] }];
  }
  // canvas tools never prompt in Claude Code: the hub applies its own tiers (confirm-tier tools wait for you in the hub)
  return { hooks, permissions: { allow: CANVAS_TOOL_NAMES.map((n) => `mcp__hub__${n}`) } };
}

export class Bootstrapper {
  private done = new Map<string, Promise<HostInfo>>();
  private codexDone = new Set<string>();
  constructor(private cfg: HubConfig, private secrets: Secrets, private hosts: HostManager) {}

  invalidate(hostId: string) {
    this.done.delete(hostId);
  }

  ensure(hostId: string): Promise<HostInfo> {
    let p = this.done.get(hostId);
    if (!p) {
      p = this.run(hostId).catch((e) => {
        this.done.delete(hostId);
        throw e;
      });
      this.done.set(hostId, p);
    }
    return p;
  }

  private async run(hostId: string): Promise<HostInfo> {
    const home = (await this.hosts.execOk(hostId, 'printf %s "$HOME"')).trim();
    const base = `${home}/.agent-hub`;
    await this.hosts.execOk(hostId, `mkdir -p ${q(base)}/run && chmod 700 ${q(base)} ${q(base)}/run`);
    const caOnHost = this.cfg.tls?.ca ? `${base}/hub-ca.pem` : '';
    if (this.cfg.tls?.ca) await this.hosts.put(hostId, caOnHost, fs.readFileSync(this.cfg.tls.ca, 'utf8'), '644');
    const env = [
      `HUB_URL=${this.cfg.hostCallbackUrl}`,
      `HUB_TOKEN=${this.secrets.hookToken}`,
      `HUB_HOOK_TOKEN=${this.secrets.hookToken}`,
      `HUB_HOST_ID=${hostId}`,
      ...(caOnHost ? [`HUB_CA_FILE=${caOnHost}`, `NODE_EXTRA_CA_CERTS=${caOnHost}`] : []),
    ].join('\n');
    await this.hosts.put(hostId, `${base}/hub.env`, env + '\n', '600');
    await this.hosts.put(hostId, `${base}/hub_channel.py`, fs.readFileSync(path.join(HOST_FILES, 'hub_channel.py'), 'utf8'), '700');
    await this.hosts.put(hostId, `${base}/claude-settings.json`, JSON.stringify(claudeHookSettings(this.cfg), null, 2), '600');
    const py = this.hosts.bin(hostId, 'python');
    await this.hosts.put(
      hostId,
      `${base}/mcp.json`,
      JSON.stringify({ mcpServers: { hub: { command: py, args: [`${base}/hub_channel.py`] } } }, null, 2),
      '600',
    );
    L(`bootstrapped ${hostId} (${home})`);
    return { home, base };
  }

  /** Managed [mcp_servers.hub] block in $CODEX_HOME/config.toml, so Codex agents get publish_app too. */
  async ensureCodexMcp(hostId: string, account: AccountConfig) {
    const key = `${hostId}:${account.id}`;
    if (this.codexDone.has(key)) return;
    const info = await this.ensure(hostId);
    const codexHome = account.codex?.home || '~/.codex';
    const block = CodexAdapter.mcpConfigBlock(this.hosts.bin(hostId, 'python'), `${info.base}/hub_channel.py`);
    const f = `${codexHome.replace(/\/$/, '')}/config.toml`;
    // strip a previous managed block, then append the current one
    const script = `mkdir -p ${rpath(codexHome)} && touch ${rpath(f)} && ` +
      `sed -i '/^# >>> agent-hub/,/^# <<< agent-hub/d' ${rpath(f)} && printf '\\n%s\\n' ${q(block)} >> ${rpath(f)}`;
    await this.hosts.execOk(hostId, script);
    this.codexDone.add(key);
  }
}
