// Terminal nodes: a real shell on a host, as the host's login user, inside a
// tmux session (survives reconnects). Each browser view is a tmux client over
// `ssh -tt`; resizes go to that client's pty with stty. Open/close is audited.
import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import type { Ctx } from './ctx.js';
import { q, rpath } from './ssh.js';
import { log } from './events.js';

const L = log('term');

export class TerminalService {
  constructor(private c: Ctx) {}

  private audit(termId: string, what: string, detail: any) {
    this.c.db.run('INSERT INTO audit (ts, app_node_id, tool, tier, caller, args, allowed, reason, result) VALUES (?,?,?,?,?,?,?,?,?)',
      Date.now(), termId, what, 'shell', 'user:you', JSON.stringify(detail), 1, '', '');
    this.c.bus.publish('audit.append', { ts: Date.now(), app_node_id: termId, tool: what, tier: 'shell', caller: 'user:you', args: detail, allowed: true, reason: '', result: '' });
  }

  async create(o: { hostId?: string; cwd?: string; sessionId?: string | null; parentId?: string | null; mode?: 'shell' | 'agent' }) {
    const s = o.sessionId ? this.c.store.session(o.sessionId) : undefined;
    const hostId = o.hostId || s?.host_id;
    if (!hostId) throw new Error('hostId is required');
    this.c.hosts.host(hostId);
    await this.c.boot.ensure(hostId);
    const id = `term-${crypto.randomBytes(4).toString('hex')}`;
    const agentPane = o.mode === 'agent' && s?.vendor === 'claude' && s.meta?.tmux;
    const tmux = agentPane ? String(s!.meta.tmux) : id;
    const cwd = o.cwd || s?.cwd || '~';
    if (!agentPane) await this.c.hosts.execOk(hostId, `tmux new-session -d -s ${q(tmux)} -x 120 -y 32 -c ${rpath(cwd)}`);
    this.audit(id, '(terminal open)', { host: hostId, cwd, mode: agentPane ? 'agent' : 'shell', session: s?.id ?? null });
    L(`opened ${id} on ${hostId} (${agentPane ? `agent pane ${tmux}` : cwd})`);
    return this.c.nodes.putTerminal(id, o.parentId ?? s?.id ?? hostId, { hostId, cwd, mode: agentPane ? 'agent' : 'shell', sessionId: s?.id ?? null, status: 'open', tmux });
  }

  async close(id: string) {
    const n = this.c.nodes.get(id);
    if (!n) return;
    if (n.data.mode === 'shell') await this.c.hosts.exec(n.data.hostId, `tmux kill-session -t ${q(n.data.tmux)}`);
    this.audit(id, '(terminal close)', { host: n.data.hostId });
  }

  /** One browser view ↔ one tmux client over ssh -tt. */
  attach(id: string, ws: WebSocket) {
    const n = this.c.nodes.get(id);
    if (!n || n.type !== 'terminal') {
      ws.close(4404, 'unknown terminal');
      return;
    }
    const { hostId, tmux } = n.data;
    const ttyFile = `$HOME/.agent-hub/run/${id}-${crypto.randomBytes(3).toString('hex')}.tty`;
    const proc = this.c.hosts.spawnTty(hostId, `tty > "${ttyFile}"; stty cols 120 rows 32; tmux has-session -t ${q(tmux)} 2>/dev/null || tmux new-session -d -s ${q(tmux)} -c ${rpath(n.data.cwd || '~')}; exec tmux attach -t ${q(tmux)}`);
    proc.stdout!.on('data', (d: Buffer) => ws.readyState === ws.OPEN && ws.send(d, { binary: true }));
    proc.stderr!.on('data', (d: Buffer) => ws.readyState === ws.OPEN && ws.send(d, { binary: true }));
    proc.on('close', () => {
      if (ws.readyState === ws.OPEN) ws.close(1000, 'terminal ended');
      this.c.hosts.exec(hostId, `rm -f "${ttyFile}"`).catch(() => {});
    });
    let resizeT: NodeJS.Timeout | undefined;
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        proc.stdin!.write(raw as Buffer);
        return;
      }
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.type === 'input' && typeof m.data === 'string') proc.stdin!.write(m.data);
      else if (m.type === 'resize') {
        const cols = Math.max(20, Math.min(400, Number(m.cols) || 80));
        const rows = Math.max(5, Math.min(200, Number(m.rows) || 24));
        clearTimeout(resizeT);
        resizeT = setTimeout(() => {
          this.c.hosts.exec(hostId, `f="${ttyFile}"; [ -f "$f" ] && stty -F "$(cat "$f")" cols ${cols} rows ${rows}`).catch(() => {});
        }, 120);
      }
    });
    ws.on('close', () => {
      proc.stdin?.end();
      proc.kill('SIGTERM');
    });
  }
}
