// Repo indexer: `git status --porcelain=v2 --branch` over SSH on a timer and
// after every turn; finds checkouts under each host's roots and apps/*/app.json.
import type { Ctx } from './ctx.js';
import { q, rpath } from './ssh.js';
import { j } from './db.js';
import { log } from './events.js';
import { GitHubAdapter } from './adapters.js';

const L = log('repos');
const SEP = '\u001e';

export interface PorcelainStatus {
  head: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: { path: string; xy: string }[];
}

export function parsePorcelainV2(out: string): PorcelainStatus {
  const st: PorcelainStatus = { head: null, branch: null, upstream: null, ahead: 0, behind: 0, changes: [] };
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.oid ')) st.head = line.slice(13).trim() === '(initial)' ? null : line.slice(13).trim();
    else if (line.startsWith('# branch.head ')) st.branch = line.slice(14).trim() === '(detached)' ? null : line.slice(14).trim();
    else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) [st.ahead, st.behind] = [Number(m[1]), Number(m[2])];
    } else if (line.startsWith('1 ')) {
      const f = line.split(' ');
      st.changes.push({ xy: f[1], path: f.slice(8).join(' ') });
    } else if (line.startsWith('2 ')) {
      const f = line.split(' ');
      st.changes.push({ xy: f[1], path: f.slice(9).join(' ').split('\t')[0] });
    } else if (line.startsWith('u ')) {
      const f = line.split(' ');
      st.changes.push({ xy: f[1], path: f.slice(10).join(' ') });
    } else if (line.startsWith('? ')) st.changes.push({ xy: '??', path: line.slice(2) });
  }
  return st;
}

export class RepoIndexer {
  private timer?: NodeJS.Timeout;
  constructor(private c: Ctx) {}

  start() {
    const run = () => this.scanAll().catch((e) => L(`scan: ${e.message}`));
    setTimeout(run, 500);
    this.timer = setInterval(run, this.c.cfg.repoIndexIntervalSec * 1000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async scanAll() {
    await Promise.all(this.c.cfg.hosts.map((h) => this.scanHost(h.id).catch((e) => L(`scan ${h.id}: ${e.message}`))));
  }

  async scanHost(hostId: string) {
    const roots = (this.c.cfg.hosts.find((h) => h.id === hostId)?.roots || ['~/code']).map(rpath).join(' ');
    const out = await this.c.hosts.execOk(hostId, `for r in ${roots}; do [ -d "$r" ] && find "$r" -maxdepth 3 -name .git -prune -print 2>/dev/null; done | sed 's#/\\.git$##'`, { timeoutMs: 20000 });
    const paths = out.split('\n').map((s) => s.trim()).filter(Boolean);
    await Promise.all(paths.map((p) => this.refreshPath(hostId, p)));
  }

  checkoutForPath(hostId: string, path: string) {
    if (!path) return undefined;
    const rows = this.c.db.all('SELECT * FROM checkout WHERE host_id=?', hostId);
    const r = rows.filter((x) => path === x.path || path.startsWith(x.path + '/')).sort((a, b) => b.path.length - a.path.length)[0];
    return r ? this.row(r) : undefined;
  }

  checkout(id: string) {
    const r = this.c.db.get('SELECT * FROM checkout WHERE id=?', id);
    return r ? this.row(r) : undefined;
  }

  row(r: any) {
    const repo = r.repo_id ? this.c.db.get('SELECT * FROM repo WHERE id=?', r.repo_id) : undefined;
    const changes = j(r.changes, [] as any[]);
    const apps = j(r.apps, [] as any[]).map((a: any) => {
      const n = this.c.db.get("SELECT id FROM app_node WHERE host_id=? AND dir=? AND preview_of IS NULL", r.host_id, `${r.path}/${a.dir}`);
      return { ...a, published: !!n, nodeId: n?.id };
    });
    return { ...r, changes, apps, dirty: changes.length, repoName: repo?.name ?? r.path.split('/').pop(), remote_url: repo?.remote_url ?? null };
  }

  async refreshCheckout(id: string) {
    const r = this.c.db.get('SELECT host_id, path FROM checkout WHERE id=?', id);
    if (r) await this.refreshPath(r.host_id, r.path);
  }

  async refreshPath(hostId: string, path: string) {
    const p = q(path);
    const script = [
      `git -C ${p} status --porcelain=v2 --branch 2>/dev/null`,
      `printf '${SEP}'`,
      `git -C ${p} log -1 --format='%s%x1f%ct' 2>/dev/null`,
      `printf '${SEP}'`,
      `git -C ${p} config --get remote.origin.url 2>/dev/null`, // as configured (not insteadOf-expanded)
      `printf '${SEP}'`,
      `for f in ${p}/apps/*/app.json; do [ -f "$f" ] && printf '%s\\t' "$f" && tr -d '\\n' < "$f" && echo; done; true`,
    ].join('; ');
    const out = await this.c.hosts.execOk(hostId, script, { timeoutMs: 20000 });
    const [status, log1, remote, appsOut] = out.split(SEP);
    const st = parsePorcelainV2(status || '');
    const [subject, ct] = (log1 || '').trim().split('\u001f');
    const remoteUrl = (remote || '').trim() || null;
    const name = (remoteUrl || path).replace(/\.git$/, '').split(/[/:]/).pop() || path;
    const gh = GitHubAdapter.parseRemote(remoteUrl);
    const repoId = gh ? `github.com/${gh.owner}/${gh.repo}` : remoteUrl ? remoteUrl.replace(/^(https?:\/\/|git@|file:\/\/)/, '').replace(/\.git$/, '').replace(':', '/') : `local:${hostId}:${path}`;
    this.c.db.upsert('repo', { id: repoId, remote_url: remoteUrl, name });
    const apps: any[] = [];
    for (const line of (appsOut || '').split('\n').filter(Boolean)) {
      const [file, body] = line.split('\t');
      const dir = file.slice(path.length + 1).replace(/\/app\.json$/, '');
      const m = j(body, {} as any);
      apps.push({ dir, id: m.id ?? dir.split('/').pop(), title: m.title ?? dir });
    }
    const id = `${hostId}:${path}`;
    this.c.db.upsert('checkout', {
      id, host_id: hostId, path, repo_id: repoId, branch: st.branch, head: st.head, head_subject: subject ?? null, head_time: ct ? Number(ct) * 1000 : null, upstream: st.upstream,
      ahead: st.ahead, behind: st.behind, dirty: st.changes.length, changes: st.changes, apps, updated_at: Date.now(),
    });
    this.c.bus.publish('checkout.upsert', this.checkout(id));
    this.c.projects?.touch(repoId);
  }

  async files(id: string) {
    const co = this.checkout(id);
    if (!co) throw new Error('unknown checkout');
    const out = await this.c.hosts.execOk(co.host_id, `git -C ${q(co.path)} ls-files --cached --others --exclude-standard | head -2000`);
    const changed = new Map<string, string>(co.changes.map((c: any) => [c.path, c.xy]));
    return { files: out.split('\n').filter(Boolean).map((p) => ({ path: p, xy: changed.get(p) ?? null })) };
  }

  async file(id: string, rel: string) {
    const co = this.checkout(id);
    if (!co) throw new Error('unknown checkout');
    if (rel.split('/').includes('..') || rel.startsWith('/')) throw new Error('bad path');
    const out = await this.c.hosts.execOk(co.host_id, `head -c 200000 ${q(co.path + '/' + rel)}`);
    return { path: rel, content: out };
  }
}
