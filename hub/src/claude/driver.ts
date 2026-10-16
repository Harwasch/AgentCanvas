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
import { json, HELD, type Res } from '../http.js';
import { sessionToken } from '../tokens.js';

const L = log('claude');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Live {
  relay?: ChildProcess;
  relayUp: boolean;
  tail?: ChildProcess;
  closed: boolean;
  relayBackoff: number;
  /** transcript lines already read (kept in session meta, so a reattach starts after them instead of replaying the file) */
  tLines?: number;
  tSave?: NodeJS.Timeout;
}

/** tmux's own answer for one session; 'unknown' when the host could not be asked (ssh failed, tmux missing). */
export type TmuxState = 'alive' | 'gone' | 'unknown';

/** Parse `<name> <has-session exit code>` lines: 0 = alive, 1 = tmux says no such session; a missing line = unknown. */
export function parseTmuxStates(names: string[], stdout: string): Map<string, TmuxState> {
  const rc = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\S+) (\d+)$/);
    if (m) rc.set(m[1], Number(m[2]));
  }
  return new Map(names.map((n) => [n, rc.get(n) === 0 ? 'alive' : rc.get(n) === 1 ? 'gone' : 'unknown']));
}

/** Chat, interrupt and settings are refused for sessions started outside the hub. */
export class ReadOnlyError extends Error {
  constructor() {
    super('read-only: this session was started outside the hub (Claude app or terminal); take it over to continue it here');
  }
}

export class ClaudeDriver {
  private live = new Map<string, Live>();
  /** held PermissionRequest hook responses (fallback when no channel) */
  private held = new Map<string, { res: Res; timer: NodeJS.Timeout }>();
  private checkTimers = new Map<string, NodeJS.Timeout>();
  private liveness?: NodeJS.Timeout;
  constructor(private c: Ctx) {}

  private configDir(accountId: string) {
    return this.c.account(accountId).claude?.configDir || '~/.claude';
  }
  private absConfigDir(home: string, accountId: string) {
    const d = this.configDir(accountId);
    return d.startsWith('~/') ? `${home}/${d.slice(2)}` : d;
  }

  async start(o: { hostId: string; accountId: string; cwd: string; checkoutId?: string | null; branch?: string | null; prompt?: string; model?: string; title?: string; resumeUuid?: string; role?: 'assistant'; reuseId?: string }): Promise<Session> {
    const info = await this.c.boot.ensure(o.hostId);
    // a take-over keeps the imported row (canvas node, messages, transcript position)
    const prev = o.reuseId ? this.c.store.session(o.reuseId) : undefined;
    const hubId = prev?.id ?? newId('cc-');
    const uuid = o.resumeUuid || crypto.randomUUID();
    const repo = o.cwd.split('/').filter(Boolean).pop() || 'repo';
    const tmux = hubId;
    const configDir = this.absConfigDir(info.home, o.accountId);
    const launch = ClaudeAdapter.launchCommand({
      bin: this.c.hosts.bin(o.hostId, 'claude'), hubId, sessionUuid: uuid, rcName: ClaudeAdapter.rcName({ repo, branch: o.branch, prompt: o.prompt, title: o.title }),
      settingsFile: `${info.base}/claude-settings.json`, mcpConfigFile: `${info.base}/mcp.json`, resume: !!o.resumeUuid, model: o.model,
    });
    // the per-session secret goes through a 0600 file (never a command line); the shell sources and removes it
    const tokFile = `${info.base}/run/${hubId}.env`;
    await this.c.hosts.put(o.hostId, tokFile, `HUB_SESSION_TOKEN=${sessionToken(this.c.secrets.hookToken, hubId)}\n`, '600');
    const inner = `set -a; . ${q(info.base + '/hub.env')}; . ${q(tokFile)}; set +a; rm -f ${q(tokFile)}; ${ClaudeAdapter.configDirEnv(info.home, configDir)}HUB_SESSION_ID=${q(hubId)}${o.role ? ` HUB_ROLE=${q(o.role)}` : ''}; exec ${launch}`;
    const s = this.c.store.upsertSession({
      id: hubId, vendor: 'claude', kind: 'local', host_id: o.hostId, account_id: o.accountId, checkout_id: o.checkoutId ?? null, cwd: o.cwd,
      branch: o.branch ?? null, native_id: uuid, native_url: null, title: o.title || (o.prompt ? o.prompt.slice(0, 60) : `Claude · ${repo}`),
      status: 'starting', model: o.model ?? null, effort: null, last_event: 'launch',
      meta: {
        tmux, transcript: prev?.meta.transcript || ClaudeAdapter.transcriptPath(configDir, o.cwd, uuid), channel: 'disconnected', stok: true,
        ...(o.role ? { role: o.role } : {}), ...(prev ? { external: false, takenOver: Date.now() } : {}),
      },
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
    let lastTail = '';
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
      lastTail = tail;
      if (this.c.cfg.autoAnswerStartupPrompts)
        for (const p of ClaudeAdapter.startupPrompts)
          if (p.re.test(tail) && !answered.has(p.name)) {
            answered.add(p.name);
            L(`${id}: answering ${p.name}`);
            await this.keys(s, ...p.keys);
          }
      const url = ClaudeAdapter.parseRemoteControlUrl(pane);
      if (url && s.native_url !== url) this.c.store.upsertSession({ id, native_url: url });
      // a startup prompt already answered may stay on screen (e.g. the dev-channel notice); an open dialog never counts as ready
      if (ClaudeAdapter.isReady(tail) || (i > 30 && !ClaudeAdapter.dialogOpen(tail) && !ClaudeAdapter.startupPrompts.some((p) => p.re.test(tail) && !answered.has(p.name)))) ready = true;
    }
    if (!ready) {
      // The TUI may look different from what ClaudeAdapter.isReady expects. If claude is still running (or the
      // channel is up), keep the session and deliver the prompt anyway; log the pane so the pattern can be fixed.
      const s = this.c.store.session(id)!;
      const alive = await this.pane(s).then((p) => { lastTail = p.replace(/\s+$/, '').split('\n').slice(-12).join('\n'); return true; }, () => false);
      if (!alive) throw new Error('claude exited during startup');
      L(`${id}: ready prompt not recognised after 30 s; continuing. Pane tail:\n${lastTail.replace(/https?:\/\/\S+/g, '<url>')}`);
      if (ClaudeAdapter.dialogOpen(lastTail)) {
        // never type into an unknown dialog (Enter could pick "exit"): leave it to you, in the terminal or the Claude app
        this.c.store.upsertSession({ id, status: 'waiting', last_event: 'a startup dialog is open: answer it in the session\'s terminal (agent pane), then send the prompt again' });
        return;
      }
      this.c.store.upsertSession({ id, last_event: 'startup screen not recognised (see hub log); continuing' });
    }
    this.c.store.upsertSession({ id, status: prompt ? 'running' : 'idle', ...(ready ? { last_event: 'ready' } : {}) });
    // give the channel a moment to attach, then send the first prompt
    for (let i = 0; i < 40 && !this.live.get(id)?.relayUp; i++) await sleep(250);
    if (prompt) await this.send(id, prompt);
  }

  /** (Re)attach live links: channel relay + transcript tail. */
  attach(id: string) {
    let l = this.live.get(id);
    if (!l) {
      l = { relayUp: false, closed: false, relayBackoff: 500 };
      this.live.set(id, l);
      // a row from a previous hub run may still say connected; it is connected again when the relay says hello
      if (this.c.store.session(id)?.meta.channel === 'connected') this.c.store.upsertSession({ id, meta: { channel: 'disconnected' } });
    }
    this.connectRelay(id);
    this.startTail(id);
  }

  private connectRelay(id: string) {
    const l = this.live.get(id);
    const s = this.c.store.session(id);
    if (!l || !s || l.closed || l.relay) return;
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
      if (l.closed) return;
      // the channel server dies with claude (/exit, crash): ask tmux soon instead of waiting for the periodic check
      this.checkSoon(s.host_id!);
      setTimeout(() => this.connectRelay(id), (l.relayBackoff = Math.min(l.relayBackoff * 2, 15000)));
    });
  }

  private onChannel(id: string, raw: unknown) {
    const r = parseChannelLine(raw);
    if (!r.ok) return L(`${id}: channel: ${r.error}`);
    const l = this.live.get(id);
    if (!l) return;
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
    const l = this.live.get(id);
    const s = this.c.store.session(id);
    if (!l || !s || l.closed || l.tail) return;
    const t = s.meta.transcript as string;
    l.tLines ??= Math.max(0, Number(s.meta.tLines) || 0);
    const p = this.c.hosts.spawn(s.host_id!, `tail -n +${l.tLines + 1} -F -- ${q(t)} 2>/dev/null`);
    l.tail = p;
    let buf = '';
    p.stdout!.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        l.tLines = (l.tLines || 0) + 1;
        try {
          this.onTranscript(id, line);
        } catch (e: any) {
          L(`${id}: transcript line: ${e.message}`);
        }
      }
      // the line count is saved quietly (no session.upsert), at most every 2 s
      l.tSave ??= setTimeout(() => this.saveTranscriptPos(id), 2000);
    });
    p.on('close', () => {
      l.tail = undefined;
      if (!l.closed) setTimeout(() => this.startTail(id), 3000);
    });
  }

  private saveTranscriptPos(id: string) {
    const l = this.live.get(id);
    if (!l) return;
    clearTimeout(l.tSave);
    l.tSave = undefined;
    if (l.tLines != null) this.c.store.patchMetaQuiet(id, { tLines: l.tLines });
  }

  /** One transcript line → messages (also used by the importer for sessions started outside the hub). */
  onTranscript(id: string, line: string) {
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
    if (o.model) {
      await this.typeLine(s, ClaudeAdapter.modelKeys(o.model));
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        const tail = (await this.pane(s)).replace(/\s+$/, '').split('\n').slice(-12).join('\n');
        if (ClaudeAdapter.modelConfirm.re.test(tail)) {
          await this.keys(s, ...ClaudeAdapter.modelConfirm.keys);
          break;
        }
        if (ClaudeAdapter.isReady(tail)) break;
      }
    }
    if (o.effort) await this.typeLine(s, ClaudeAdapter.effortKeys(o.effort));
    this.c.store.upsertSession({ id, model: o.model ?? s.model, effort: o.effort ?? s.effort });
  }

  /**
   * Continue a session started outside the hub under the hub's control: `claude --resume <uuid>` in tmux, same
   * row. The caller has made sure the Claude app or terminal no longer has it open (two writers corrupt it).
   */
  async takeover(id: string): Promise<Session> {
    const s = this.c.store.session(id);
    if (!s || s.vendor !== 'claude' || !s.meta.external) throw new Error('only sessions started outside the hub can be taken over');
    if (!s.host_id || !s.cwd || !s.native_id) throw new Error('this session has no host, folder or Claude session id');
    L(`${id}: taking over ${s.native_id} on ${s.host_id}`);
    return this.start({ hostId: s.host_id, accountId: s.account_id, cwd: s.cwd, checkoutId: s.checkout_id, branch: s.branch, title: s.title, resumeUuid: s.native_id, reuseId: s.id });
  }

  async stop(id: string) {
    const ext = this.c.store.session(id);
    if (ext?.meta.external) {
      // not ours to stop: take it off the canvas (the importer leaves it hidden)
      this.c.store.upsertSession({ id, status: 'ended', last_event: 'hidden in hub', meta: { hidden: true } });
      return;
    }
    const s = this.need(id);
    const l = this.live.get(id);
    if (l) l.closed = true; // no relay reconnects while tmux goes away
    await this.c.hosts.exec(s.host_id!, `${this.tmuxBin(s.host_id!)} kill-session -t ${q(s.meta.tmux)}`);
    this.end(id, 'stopped from hub');
  }

  /**
   * Reattach to sessions whose tmux is alive and end the ones tmux says are gone. Runs on hub start, when a host
   * comes back online, and on a timer. A host that cannot be asked (ssh down) leaves its sessions as they are.
   */
  async recover(hostId?: string, o: { startup?: boolean } = {}) {
    const all = this.c.store
      .sessions("vendor='claude' AND kind='local' AND status NOT IN ('ended','error')")
      .filter((s) => s.host_id && (!hostId || s.host_id === hostId) && !s.meta.external); // imported sessions have no tmux of ours
    const byHost = new Map<string, Session[]>();
    for (const s of all) byHost.set(s.host_id!, [...(byHost.get(s.host_id!) || []), s]);
    await Promise.all([...byHost].map(async ([h, list]) => {
      const states = await this.tmuxStates(h, list.map((s) => s.meta.tmux));
      for (const s of list) {
        const st = states.get(s.meta.tmux);
        if (st === 'gone') this.end(s.id, 'claude exited (tmux session gone)');
        else if (st === 'alive') {
          if (s.meta.hostOffline) this.c.store.upsertSession({ id: s.id, last_event: 'host back online', meta: { hostOffline: false } });
          const l = this.live.get(s.id);
          if (!l || l.closed) {
            if (l) this.live.delete(s.id);
            this.attach(s.id);
          }
        } else if (o.startup || !s.meta.hostOffline) {
          // unreachable: keep the session; retried when the host comes back online
          if (!s.meta.hostOffline) L(`${s.id}: ${h} unreachable; keeping the session until the host is back`);
          this.c.store.upsertSession({ id: s.id, last_event: 'host offline', meta: { hostOffline: true } });
        }
      }
    }));
  }

  /** One ssh exec per host: `tmux has-session` for each name, with its exit code. */
  async tmuxStates(hostId: string, names: string[]): Promise<Map<string, TmuxState>> {
    if (!names.length) return new Map();
    const tm = this.tmuxBin(hostId);
    const r = await this.c.hosts.exec(hostId, `for s in ${names.map(q).join(' ')}; do ${tm} has-session -t "$s" 2>/dev/null; echo "$s $?"; done`, { timeoutMs: 15000 }).catch(() => ({ code: -1, stdout: '', stderr: '' }));
    return parseTmuxStates(names, r.stdout);
  }

  /** Periodic liveness check (claudeLivenessIntervalSec): sessions that exit on their own (/exit, crash) fire no hook we can rely on. */
  startLiveness() {
    const sec = Math.max(1, this.c.cfg.claudeLivenessIntervalSec || 60);
    this.liveness = setInterval(() => {
      const hosts = new Set([...this.live.entries()].filter(([, l]) => !l.closed).map(([id]) => this.c.store.session(id)?.host_id).filter(Boolean) as string[]);
      for (const h of hosts) if ((this.c.hosts.row(h) as any)?.status !== 'offline') this.recover(h).catch((e) => L(`liveness ${h}: ${e.message}`));
    }, sec * 1000);
  }
  stopLiveness() {
    if (this.liveness) clearInterval(this.liveness);
  }

  /** debounced recover(host) after a relay dropped */
  private checkSoon(hostId: string) {
    clearTimeout(this.checkTimers.get(hostId));
    this.checkTimers.set(hostId, setTimeout(() => {
      this.checkTimers.delete(hostId);
      this.recover(hostId).catch((e) => L(`check ${hostId}: ${e.message}`));
    }, 1500));
  }

  /** The session is really over: close its links, forget it, and mark it ended (its device locks are released on that event). */
  private end(id: string, why: string) {
    const l = this.live.get(id);
    if (l) {
      l.closed = true;
      l.relay?.kill();
      l.tail?.kill();
      if (l.tSave) this.saveTranscriptPos(id);
    }
    this.live.delete(id);
    L(`${id}: ${why}`);
    this.c.store.setStatus(id, 'ended', why);
    this.expireApprovals(id);
  }

  /** a held PermissionRequest hook response is still open for this approval */
  holding(approvalId: string) {
    return this.held.has(approvalId);
  }
  /** channel approvals can be answered only while the relay is up */
  channelUp(sessionId: string) {
    const l = this.live.get(sessionId);
    return !!(l?.relayUp && l.relay?.stdin?.writable);
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
      if (!h) throw new Error('no longer waiting');
      clearTimeout(h.timer);
      this.held.delete(approvalId);
      json(h.res, 200, permissionDecision(decision));
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
    if (s.meta.external) throw new ReadOnlyError();
    return s;
  }

  // ------------------------------------------------------------- hooks
  /** Returns HELD if the response was taken over (answered later by decide() or the timeout). */
  onHook(h: HookEvent, res: Res): typeof HELD | false {
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
        // Claude gave up on the hook (its timeout, or it exited): nobody is waiting for this answer any more
        res.once('close', () => {
          if (res.writableFinished || !this.held.has(aid)) return;
          clearTimeout(timer);
          this.held.delete(aid);
          this.c.store.upsertApproval({ id: aid, status: 'expired' });
        });
        return HELD;
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
        this.end(id, 'session ended');
        break;
    }
    return false;
  }
}
