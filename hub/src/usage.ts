// Subscription usage per AI account: the rate-limit windows Claude and Codex enforce (5-hour and weekly), as the
// vendors report them. Codex: the app-server's account/rateLimits on any connected daemon. Claude: the endpoint the
// CLI's /usage reads, with the hub's own profile login for that account (never an API key). Both are best-effort.
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './ctx.js';
import { ClaudeAdapter, CodexAdapter, type UsageWindow } from './adapters.js';
import { expandHome } from './config.js';
import { log } from './events.js';

const L = log('usage');

export interface Usage { accountId: string; vendor: 'claude' | 'codex'; windows: UsageWindow[]; plan?: string | null; at: number; error?: string }

export class UsageService {
  private data = new Map<string, Usage>();
  private timer?: NodeJS.Timeout;
  constructor(private c: Ctx) {}

  list() {
    return [...this.data.values()];
  }

  private put(u: Usage) {
    this.data.set(`${u.vendor}:${u.accountId}`, u);
    this.c.bus.publish('usage.upsert', u);
  }

  fromCodex(accountId: string, raw: any) {
    const windows = CodexAdapter.parseRateLimits(raw);
    if (windows.length) this.put({ accountId, vendor: 'codex', windows, plan: raw?.planType ?? null, at: Date.now() });
  }

  async refresh() {
    for (const a of this.c.cfg.accounts) {
      if (a.claude !== undefined || a.hub?.claudeConfigDir) await this.claude(a.id).catch((e) => this.fail(a.id, 'claude', e));
      if (a.codex !== undefined || a.hub?.codexHome) await this.codex(a.id).catch((e) => this.fail(a.id, 'codex', e));
    }
  }

  private fail(accountId: string, vendor: 'claude' | 'codex', e: any) {
    const prev = this.data.get(`${vendor}:${accountId}`);
    L(`${vendor}/${accountId}: ${e.message}`);
    this.put({ accountId, vendor, windows: prev?.windows || [], plan: prev?.plan ?? null, at: prev?.at ?? Date.now(), error: String(e.message || e).slice(0, 200) });
  }

  private async codex(accountId: string) {
    const raw = await this.c.codex.rateLimits(accountId);
    if (raw == null) {
      if (!this.data.has(`codex:${accountId}`)) this.put({ accountId, vendor: 'codex', windows: [], at: Date.now(), error: 'no Codex daemon connected for this account yet' });
      return;
    }
    this.fromCodex(accountId, raw);
  }

  private async claude(accountId: string) {
    const url = this.c.cfg.adapters.claude.usageUrl;
    if (!url) return;
    const dir = this.c.account(accountId).hub?.claudeConfigDir;
    if (!dir) throw new Error('no hub.claudeConfigDir for this account (log Claude in on the hub to see usage)');
    let cred: any;
    try {
      cred = JSON.parse(fs.readFileSync(path.join(expandHome(dir), '.credentials.json'), 'utf8'));
    } catch {
      throw new Error('Claude is not logged in in the hub profile for this account');
    }
    const oauth = cred?.claudeAiOauth;
    if (!oauth?.accessToken) throw new Error('no claude.ai login in the hub profile for this account');
    if (oauth.expiresAt && Number(oauth.expiresAt) < Date.now()) throw new Error('the hub profile login has expired; run claude once in that profile to refresh it');
    const r = await fetch(url, { headers: ClaudeAdapter.usageHeaders(oauth.accessToken), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`usage endpoint answered ${r.status}`);
    this.put({ accountId, vendor: 'claude', windows: ClaudeAdapter.parseUsage(await r.json()), plan: oauth.subscriptionType ?? null, at: Date.now() });
  }

  start() {
    const tick = () => this.refresh().catch((e) => L(`refresh: ${e.message}`));
    setTimeout(tick, 5000);
    this.timer = setInterval(tick, this.c.cfg.usagePollIntervalSec * 1000);
  }
  stop() {
    clearInterval(this.timer);
  }
}
