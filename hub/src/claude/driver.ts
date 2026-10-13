// Claude driver: launches `claude` in tmux on a host under the account's
// CLAUDE_CONFIG_DIR, keeps each session's channel link (relay over SSH), takes
// hooks, tails the transcript, and falls back to tmux keys when the channel is down.
import crypto from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { Ctx } from '../ctx.js';
import { ClaudeAdapter } from '../adapters.js';
import { q, rpath } from '../ssh.js';
import { NdjsonDecoder, ndjson } from '../jsonrpc.js';
import { parseChannelLine, channelMessage, channelPermission, parseTranscriptLine, permissionDecision, writtenPaths, type HookEvent } from './payloads.js';
import { newId, type Session } from '../store.js';
import { log } from '../events.js';
import { json, type Res } from '../http.js';

const L = log('claude');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Live {
  relay?: ChildProcess;
  relayUp: boolean;
  tail?: ChildProcess;
  closed: boolean;
  relayBackoff: number;
}

export class ClaudeDriver {
  private live = new Map<string, Live>();
  /** held PermissionRequest hook responses (fallback when no channel) */
  private held = new Map<string, { res: Res; timer: NodeJS.Timeout }>();
  constructor(private c: Ctx) {}

  private configDir(accountId: string) {
    return this.c.account(accountId).claude?.configDir || '~/.claude';
  }
  private absConfigDir(home: string, accountId: string) {
    const d = this.configDir(accountId);
    return d.startsWith('~/') ? `${home}/${d.slice(2)}` : d;
  }

  async start(o: { hostId: string; accountId: string; cwd: string; checkoutId?: string | null; branch?: string | null; prompt?: string; model?: string; title?: string; resumeUuid?: string; role?: 'assistant' }): Promise<Session> {
    const info = await this.c.boot.ensure(o.hostId);
    const hubId = newId('cc-');
    const uuid = o.resumeUuid || crypto.randomUUID();
    const repo = o.cwd.split('/').filter(Boolean).pop() || 'repo';
    const tmux = hubId;
    const configDir = this.absConfigDir(info.home, o.accountId);
    const launch = ClaudeAdapter.launchCommand({
      bin: this.c.hosts.bin(o.hostId, 'claude'), hubId, sessionUuid: uuid, rcName: `${hubId} · ${repo}`,
      settingsFile: `${info.base}/claude-settings.json`, mcpConfigFile: `${info.base}/mcp.json`, resume: !!o.resumeUuid, model: o.model,
    });
    const inner = `set -a; . ${q(info.base + '/hub.env')}; set +a; export CLAUDE_CONFIG_DIR=${q(configDir)} HUB_SESSION_ID=${q(hubId)}${o.role ? ` HUB_ROLE=${q(o.role)}` : ''}; exec ${launch}`;
    const s = this.c.store.upsertSession({
      id: hubId, vendor: 'claude', kind: 'local', host_id: o.hostId, account_id: o.accountId, checkout_id: o.checkoutId ?? null, cwd: o.cwd,
      branch: o.branch ?? null, native_id: uuid, native_url: null, title: o.title || (o.prompt ? o.prompt.slice(0, 60) : `Claude · ${repo}`),
      status: 'starting', model: o.model ?? null, effort: null, last_event: 'launch',
      meta: { tmux, transcript: ClaudeAdapter.transcriptPath(configDir, o.cwd, uuid), channel: 'disconnected', ...(o.role ? { role: o.role } : {}) },
    });
    await this.c.hosts.execOk(o.hostId, `${this.tmuxBin(o.hostId)} new-session -d -s ${q(tmux)} -x 220 -y 50 -c ${rpath(o.cwd)} ${q(inner)}`);
    L(`launched ${hubId} on ${o.hostId} in ${o.cwd}`);
    this.attach(s.id);
    this.afterLaunch(s.id, o.prompt).catch((e) => {
      L(`startup ${hubId} failed: ${e.message}`);
      this.c.store.upsertSession({ id: hubId, status: 'error', last_event: e.message });
    });
    return s;
  }

  private tmuxBin(hostId: string) {
    return q(this.c.hosts.bin(hostId, 'tmux'));
  }

  private async pane(s: Session): Promise<string> {
    const r = await this.c.hosts.exec(s.host_id!, `${this.tmuxBin(s.host_id!)} capture-pane -p -J -S -200 -t ${q(s.meta.tmux)}`);
    if (r.code !== 0) throw new Error(`tmux session gone: ${r.stderr.trim()}`);
    return r.stdout;
  }

  private async keys(s: Session, ...keys: string[]) {
    await this.c.hosts.execOk(s.host_id!, `${this.tmuxBin(s.host_id!)} send-keys -t ${q(s.meta.tmux)} ${keys.map(q).join(' ')}`);
  }
  private async typeLine(s: Session, text: string) {
    await this.c.hosts.execOk(s.host_id!, `${this.tmuxBin(s.host_id!)} send-keys -t ${q(s.meta.tmux)} -l -- ${q(text.replace(/\n/g, ' '))} && ${this.tmuxBin(s.host_id!)} send-keys -t ${q(s.meta.tmux)} Enter`);
  }

  /** Answer one-time startup prompts through tmux, read the Remote Control URL, then deliver the first prompt. */
  private async afterLaunch(id: string, prompt?: string) {
    const answered = new Set<string>();
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await sleep(500);
      const s = this.c.store.session(id)!;
      let pane: string;
      try {
        pane = await this.pane(s);
      } catch (e: any) {
        throw new Error(`claude exited during startup: ${e.message}`);
      }
      if (/Not logged in|run \/login/i.test(pane)) throw new Error('claude is not logged in for this account on this host');
      const tail = pane.replace(/\s+$/, '').split('\n').slice(-12).join('\n'); // panes pad with blank lines
      if (this.c.cfg.autoAnswerStartupPrompts)
        for (const p of ClaudeAdapter.startupPrompts)
          if (p.re.test(tail) && !answered.has(p.name)) {
            answered.add(p.name);
            L(`${id}: answering ${p.name}`);
            await this.keys(s, ...p.keys);
          }
      const url = ClaudeAdapter.parseRemoteControlUrl(pane);
      if (url && s.native_url !== url) this.c.store.upsertSession({ id, native_url: url });
      if (ClaudeAdapter.isReady(tail) || (i > 30 && !ClaudeAdapter.startupPrompts.some((p) => p.re.test(tail)))) ready = true;
    }
    if (!ready) throw new Error('claude did not become ready within 30 s');
    this.c.store.upsertSession({ id, status: prompt ? 'running' : 'idle', last_event: 'ready' });
    // give the channel a moment to attach, then send the first prompt
    for (let i = 0; i < 20 && !this.live.get(id)?.relayUp; i++) await sleep(250);
    if (prompt) await this.send(id, prompt);
  }

  /** (Re)attach live links: channel relay + transcript tail. */
  attach(id: string) {
    let l = this.live.get(id);
    if (!l) {
      l = { relayUp: false, closed: false, relayBackoff: 500 };
      this.live.set(id, l);
    }
    this.connectRelay(id);
    this.startTail(id);
  }

  private connectRelay(id: string) {
    const l = this.live.get(id)!;
    const s = this.c.store.session(id);
    if (!s || l.closed || l.relay) return;
    const p = this.c.hosts.spawn(s.host_id!, `${q(this.c.hosts.bin(s.host_id!, 'python'))} "$HOME/.agent-hub/hub_channel.py" relay ${q(id)}`);
    l.relay = p;
    const dec = new NdjsonDecoder((m) => this.onChannel(id, m), (line) => L(`${id}: bad channel line ${line.slice(0, 80)}`));
    p.stdout!.on('data', (d) => dec.push(d));
    p.stderr!.on('data', (d) => L(`${id} relay: ${String(d).trim()}`));
    p.on('close', () => {
      l.relay = undefined;
      if (l.relayUp) {
        l.relayUp = false;
        this.c.store.upsertSession({ id, meta: { channel: 'disconnected' } });
      }
      if (!l.closed) setTimeout(() => this.connectRelay(id), (l.relayBackoff = Math.min(l.relayBackoff * 2, 15000)));
    });
  }

  private onChannel(id: string, raw: unknown) {
    const r = parseChannelLine(raw);
    if (!r.ok) return L(`${id}: channel: ${r.error}`);
    const l = this.live.get(id)!;
    const m = r.msg;
    if (m.type === 'hello') {
      l.relayUp = true;
      l.relayBackoff = 500;
      this.c.store.upsertSession({ id, meta: { channel: 'connected' } });
    } else if (m.type === 'permission_request') {
      const a = this.c.store.upsertApproval({
        id: `cca-${id}-${m.requestId}`, session_id: id, source: 'claude-channel', status: 'pending',
        title: `${m.toolName}: ${m.description || 'tool call'}`, detail: m.inputPreview, data: { requestId: m.requestId, toolName: m.toolName },
      });
      this.c.store.setStatus(id, 'waiting', `approval ${m.toolName}`);
      this.c.push.notify({ title: 'Approval needed', body: `${this.c.store.session(id)?.title}: ${a.title}`, tag: a.id, url: `/?focus=${id}` });
    }
  }

  private startTail(id: string) {
    const l = this.live.get(id)!;
    const s = this.c.store.session(id);
    if (!s || l.closed || l.tail) return;
    const t = s.meta.transcript as string;
    const p = this.c.hosts.spawn(s.host_id!, `tail -n +1 -F -- ${q(t)} 2>/dev/null`);
    l.tail = p;
    let buf = '';
    p.stdout!.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.onTranscript(id, line);
      }
    });
    p.on('close', () => {
      l.tail = undefined;
      if (!l.closed) setTimeout(() => this.startTail(id), 3000);
    });
  }

  private onTranscript(id: string, line: string) {
    for (const it of parseTranscriptLine(line)) {
      let text = it.text;
      let data: any = it.data ?? null;
      if (it.role === 'user' && it.kind === 'text') {
        const ch = text.match(/^<channel source="([^"]*)"[^>]*>\n?([\s\S]*?)\n?<\/channel>$/);
        if (ch) {
          text = ch[2];
          data = { via: 'channel', source: ch[1] };
        }
      }
      if (it.kind === 'tool_use' && it.data?.name?.startsWith('mcp__hub__')) data = { ...data, hub: true };
      this.c.store.upsertMessage({
        id: `t-${id}-${it.uuid}`, session_id: id,
        role: it.role, kind: it.kind === 'tool_use' || it.kind === 'tool_result' ? 'tool' : it.kind === 'thinking' ? 'reasoning' : 'text',
        text: it.kind === 'tool_use' ? `${it.data.name} ${JSON.stringify(it.data.input).slice(0, 300)}` : text, data,
      });
    }
  }

  // ------------------------------------------------------------- commands
  async send(id: string, text: string) {
    const s = this.need(id);
    const l = this.live.get(id);
    if (l?.relayUp && l.relay?.stdin?.writable) {
      l.relay.stdin.write(ndjson(channelMessage(text, { from: 'agent_hub' })));
    } else {
      L(`${id}: channel down, typing via tmux`);
      await this.typeLine(s, text);
    }
    this.c.store.setStatus(id, 'running', 'prompt sent');
  }

  async interrupt(id: string) {
    const s = this.need(id);
    await this.keys(s, ...ClaudeAdapter.interruptKeys);
    this.c.store.setStatus(id, 'idle', 'interrupted');
    this.expireApprovals(id);
  }

  async settings(id: string, o: { model?: string; effort?: string }) {
    const s = this.need(id);
    if (o.model) await this.typeLine(s, ClaudeAdapter.modelKeys(o.model));
    if (o.effort) await this.typeLine(s, ClaudeAdapter.effortKeys(o.effort));
    this.c.store.upsertSession({ id, model: o.model ?? s.model, effort: o.effort ?? s.effort });
  }

  async stop(id: string) {
    const s = this.need(id);
    const l = this.live.get(id);
    if (l) {
      l.closed = true;
      l.relay?.kill();
      l.tail?.kill();
    }
    await this.c.hosts.exec(s.host_id!, `${this.tmuxBin(s.host_id!)} kill-session -t ${q(s.meta.tmux)}`);
    this.c.store.setStatus(id, 'ended', 'stopped from hub');
    this.expireApprovals(id);
  }

  /** On hub restart: reattach to sessions whose tmux is still alive. */
  async recover() {
    for (const s of this.c.store.sessions("vendor='claude' AND kind='local' AND status NOT IN ('ended','error')")) {
      const r = await this.c.hosts.exec(s.host_id!, `${this.tmuxBin(s.host_id!)} has-session -t ${q(s.meta.tmux)}`).catch(() => ({ code: 1 }));
      if (r.code === 0) this.attach(s.id);
      else this.c.store.setStatus(s.id, 'ended', 'tmux session gone');
    }
  }

  async decide(approvalId: string, decision: 'allow' | 'deny') {
    const a = this.c.store.approval(approvalId);
    if (!a || a.status !== 'pending') return;
    if (a.source === 'claude-channel') {
      const l = this.live.get(a.session_id);
      if (!l?.relayUp || !l.relay?.stdin?.writable) throw new Error('channel is not connected; answer in the native app or the terminal');
      l.relay.stdin.write(ndjson(channelPermission(a.data.requestId, decision)));
    } else if (a.source === 'claude-hook') {
      const h = this.held.get(approvalId);
      if (h) {
        clearTimeout(h.timer);
        this.held.delete(approvalId);
        json(h.res, 200, permissionDecision(decision));
      }
    }
    this.c.store.upsertApproval({ id: approvalId, status: decision, decided_by: 'hub' });
    this.c.store.setStatus(a.session_id, 'running', `approval ${decision}`);
  }

  private expireApprovals(sessionId: string) {
    for (const a of this.c.store.pendingApprovals())
      if (a.session_id === sessionId && a.source.startsWith('claude')) {
        const h = this.held.get(a.id);
        if (h) {
          clearTimeout(h.timer);
          this.held.delete(a.id);
          json(h.res, 200, {});
        }
        this.c.store.upsertApproval({ id: a.id, status: 'expired' });
      }
  }

  private need(id: string) {
    const s = this.c.store.session(id);
    if (!s || s.vendor !== 'claude' || s.kind !== 'local') throw new Error(`no local claude session ${id}`);
    return s;
  }

  // ------------------------------------------------------------- hooks
  /** Returns true if the response was taken over (held). */
  onHook(h: HookEvent, res: Res): boolean {
    const s = this.c.store.sessionByNative(h.sessionId);
    if (!s) {
      L(`hook ${h.event} for unknown session ${h.sessionId}`);
      return false;
    }
    const id = s.id;
    switch (h.event) {
      case 'UserPromptSubmit':
        this.c.store.setStatus(id, 'running', 'prompt');
        if (s.title.startsWith('Claude · ') && h.prompt) this.c.store.upsertSession({ id, title: h.prompt.replace(/<\/?channel[^>]*>/g, '').trim().slice(0, 60) });
        break;
      case 'PreToolUse':
        this.c.store.setStatus(id, 'running', `tool ${h.toolName}`);
        break;
      case 'PermissionRequest': {
        const l = this.live.get(id);
        this.c.store.setStatus(id, 'waiting', `permission ${h.toolName}`);
        if (l?.relayUp) return false; // the channel relays the dialog; first answer wins
        const aid = `cch-${id}-${crypto.randomBytes(3).toString('hex')}`;
        this.c.store.upsertApproval({
          id: aid, session_id: id, source: 'claude-hook', status: 'pending', title: `${h.toolName}`,
          detail: JSON.stringify(h.toolInput).slice(0, 2000), data: { toolName: h.toolName },
        });
        this.c.push.notify({ title: 'Approval needed', body: `${s.title}: ${h.toolName}`, tag: aid, url: `/?focus=${id}` });
        const timer = setTimeout(() => {
          this.held.delete(aid);
          this.c.store.upsertApproval({ id: aid, status: 'expired' });
          json(res, 200, {}); // no decision: the terminal dialog shows
        }, 120_000);
        this.held.set(aid, { res, timer });
        return true;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure':
        this.expireApprovals(id);
        this.c.store.setStatus(id, 'running', `done ${h.toolName}`);
        if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(h.toolName || ''))
          for (const p of writtenPaths(h)) this.c.apps.onFileWritten(s, p).catch((e) => L(`hot reload: ${e.message}`));
        break;
      case 'Stop':
        this.expireApprovals(id);
        this.c.store.setStatus(id, 'idle', 'turn finished');
        if (s.checkout_id) this.c.repos.refreshCheckout(s.checkout_id).catch(() => {});
        break;
      case 'Notification':
        break;
      case 'SessionEnd':
        this.c.store.setStatus(id, 'ended', 'session ended');
        break;
    }
    return false;
  }
}
