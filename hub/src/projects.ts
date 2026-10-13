// Projects (one per repo) and branch nodes. Local facts come from the host
// checkouts over SSH; GitHub facts (pushed branches, PRs, reviews, check runs,
// apps on pushed branches) come from the official `gh` CLI under the account
// that owns the repo (GH_CONFIG_DIR per account).
import { execFile } from 'node:child_process';
import type { Ctx } from './ctx.js';
import type { AccountConfig } from './config.js';
import { expandHome } from './config.js';
import { GitHubAdapter, type GhPull } from './adapters.js';
import { q, rpath } from './ssh.js';
import { j } from './db.js';
import { log } from './events.js';

const L = log('projects');
const SEP = '\u001e';

export interface GhRef {
  owner: string;
  repo: string;
  account: string;
  url: string;
}

export class GitHub {
  constructor(private c: Ctx) {}

  accountFor(owner: string): AccountConfig | undefined {
    const withGh = this.c.cfg.accounts.filter((a) => a.gh?.configDir);
    return withGh.find((a) => (a.gh!.owners || []).map((o) => o.toLowerCase()).includes(owner.toLowerCase())) ?? withGh[0];
  }

  /** `gh api <endpoint>` under the account's GH_CONFIG_DIR. JSON by default, raw bytes with raw=true. */
  api<T = any>(account: string, endpoint: string, raw = false): Promise<T> {
    const a = this.c.account(account);
    const env = { ...process.env, GH_CONFIG_DIR: expandHome(a.gh?.configDir || '~/.config/gh'), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
    return new Promise((resolve, reject) => {
      execFile(this.c.cfg.adapters.gh.bin, GitHubAdapter.api(endpoint, raw), { env, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`gh api ${endpoint}: ${String(stderr).trim() || err.message}`));
        if (raw) return resolve(stdout as unknown as T);
        try {
          resolve(JSON.parse(stdout.toString('utf8')));
        } catch (e: any) {
          reject(new Error(`gh api ${endpoint}: bad JSON (${e.message})`));
        }
      });
    });
  }
}

const interesting = (name: string) => /^(claude|codex)\//.test(name);

export class ProjectService {
  gh: GitHub;
  private timer?: NodeJS.Timeout;
  private pending = new Map<string, NodeJS.Timeout>();
  private running = new Set<string>();
  private lastStats = new Map<string, { at: number; heads: string; data: any }>();

  constructor(private c: Ctx) {
    this.gh = new GitHub(c);
  }

  start() {
    const tick = () => this.refreshAll().catch((e) => L(`refresh: ${e.message}`));
    setTimeout(tick, 1500);
    this.timer = setInterval(tick, this.c.cfg.githubPollIntervalSec * 1000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  projects() {
    return this.c.db.all('SELECT data FROM project ORDER BY id').map((r) => j(r.data, null));
  }
  branches() {
    return this.c.db.all('SELECT data FROM branch ORDER BY project_id, name').map((r) => j(r.data, null));
  }
  project(id: string) {
    return j<any>(this.c.db.get('SELECT data FROM project WHERE id=?', id)?.data, null);
  }
  branch(id: string) {
    return j<any>(this.c.db.get('SELECT data FROM branch WHERE id=?', id)?.data, null);
  }

  ghRef(projectId: string): GhRef | null {
    const repo = this.c.db.get('SELECT * FROM repo WHERE id=?', projectId);
    const p = GitHubAdapter.parseRemote(repo?.remote_url);
    if (!p) return null;
    const acct = this.gh.accountFor(p.owner);
    if (!acct) return null;
    return { ...p, account: acct.id, url: `https://github.com/${p.owner}/${p.repo}` };
  }

  /** debounce a refresh after a checkout changed */
  touch(projectId: string) {
    clearTimeout(this.pending.get(projectId));
    this.pending.set(projectId, setTimeout(() => {
      this.pending.delete(projectId);
      this.refresh(projectId).catch((e) => L(`refresh ${projectId}: ${e.message}`));
    }, 1500));
  }

  async refreshAll() {
    const ids = this.c.db.all('SELECT DISTINCT repo_id FROM checkout').map((r) => r.repo_id);
    for (const id of ids) await this.refresh(id).catch((e) => L(`refresh ${id}: ${e.message}`));
  }

  /** Local stats + branch facts from one online checkout over SSH (cached until heads change or 5 min). */
  private async localFacts(projectId: string, checkouts: any[]) {
    const heads = checkouts.map((c) => `${c.id}@${c.head}@${c.dirty}`).join('|');
    const cached = this.lastStats.get(projectId);
    if (cached && cached.heads === heads && Date.now() - cached.at < 300_000) return cached.data;
    const online = checkouts.filter((co) => this.c.db.get('SELECT status FROM host WHERE id=?', co.host_id)?.status === 'online');
    const co = online[0] ?? checkouts[0];
    let stats = { files: 0, commits: 0, sizeMB: 0 };
    let folders: { name: string; mb: number }[] = [];
    let readme = '';
    if (co) {
      const p = q(co.path);
      const r = await this.c.hosts.exec(co.host_id, [
        `git -C ${p} ls-files | wc -l`, `printf '${SEP}'`, `git -C ${p} rev-list --count HEAD 2>/dev/null || echo 0`, `printf '${SEP}'`,
        `du -sk ${p}/.git 2>/dev/null | cut -f1`, `printf '${SEP}'`,
        `cd ${p} && for d in */; do [ -d "$d" ] && printf '%s\\t%s\\n' "$(du -sk "$d" | cut -f1)" "\${d%/}"; done`, `printf '${SEP}'`,
        `head -c 20000 ${p}/README.md 2>/dev/null; true`,
      ].join('; '), { timeoutMs: 30000 });
      const [files, commits, kb, dirs, rd] = r.stdout.split(SEP);
      stats = { files: Number(files) || 0, commits: Number(commits) || 0, sizeMB: Math.round(((Number(kb) || 0) / 1024) * 10) / 10 };
      folders = (dirs || '').split('\n').filter(Boolean).map((l) => {
        const [k, name] = l.split('\t');
        return { name, mb: Math.round((Number(k) / 1024) * 10) / 10 };
      }).sort((a, b) => b.mb - a.mb);
      readme = rd || '';
    }
    // per checkout: commits on its branch and ahead/behind its base
    const per: Record<string, { commits: any[]; aheadBase: number; behindBase: number; base: string }> = {};
    await Promise.all(checkouts.map(async (x) => {
      if (!x.branch) return;
      const meta = this.c.db.get('SELECT base FROM branch_meta WHERE id=?', `${projectId}#${x.branch}`);
      const base = meta?.base || 'main';
      const p = q(x.path);
      const r = await this.c.hosts.exec(x.host_id, [
        `git -C ${p} log -8 --format='%H%x1f%s%x1f%an%x1f%ct' 2>/dev/null`, `printf '${SEP}'`,
        `git -C ${p} rev-list --left-right --count ${q('origin/' + base)}...HEAD 2>/dev/null || git -C ${p} rev-list --left-right --count ${q(base)}...HEAD 2>/dev/null || echo '0 0'`,
      ].join('; '));
      const [log1, ab] = r.stdout.split(SEP);
      const [behind, ahead] = (ab || '0 0').trim().split(/\s+/).map(Number);
      per[x.id] = {
        base,
        aheadBase: ahead || 0,
        behindBase: behind || 0,
        commits: (log1 || '').split('\n').filter(Boolean).map((l) => {
          const [sha, subject, author, ct] = l.split('\u001f');
          return { sha, subject, author, at: Number(ct) * 1000 };
        }),
      };
    }));
    const data = { stats, folders, readme, per };
    this.lastStats.set(projectId, { at: Date.now(), heads, data });
    return data;
  }

  async refresh(projectId: string) {
    if (this.running.has(projectId)) return this.touch(projectId);
    this.running.add(projectId);
    try {
      await this.doRefresh(projectId);
    } finally {
      this.running.delete(projectId);
    }
  }

  private async doRefresh(projectId: string) {
    const repo = this.c.db.get('SELECT * FROM repo WHERE id=?', projectId);
    if (!repo) return;
    const checkouts = this.c.db.all('SELECT * FROM checkout WHERE repo_id=? ORDER BY host_id, path', projectId).map((r) => this.c.repos.row(r));
    const local = await this.localFacts(projectId, checkouts);
    const ghr = this.ghRef(projectId);
    let defaultBranch = 'main';
    let remote: Map<string, string> = new Map();
    let pulls: GhPull[] = [];
    let ghError: string | null = null;
    if (ghr) {
      try {
        const [info, brs, prs] = await Promise.all([
          this.gh.api(ghr.account, GitHubAdapter.repo(ghr.owner, ghr.repo)),
          this.gh.api<any[]>(ghr.account, GitHubAdapter.branches(ghr.owner, ghr.repo)),
          this.gh.api<GhPull[]>(ghr.account, GitHubAdapter.pulls(ghr.owner, ghr.repo)),
        ]);
        defaultBranch = info.default_branch || 'main';
        remote = new Map(brs.map((b) => [b.name, b.commit?.sha]));
        pulls = prs;
      } catch (e: any) {
        ghError = e.message;
        L(`github ${projectId}: ${e.message}`);
      }
    }
    // which branches become nodes: default, checked out somewhere, created in the hub, open PR heads, claude/* + codex/* result branches
    const metas = this.c.db.all('SELECT * FROM branch_meta WHERE id LIKE ?', `${projectId}#%`);
    const names = new Set<string>([defaultBranch]);
    for (const co of checkouts) if (co.branch) names.add(co.branch);
    for (const m of metas) names.add(m.id.slice(projectId.length + 1));
    for (const p of pulls) if (p.state === 'open' && remote.has(p.head.ref)) names.add(p.head.ref);
    for (const n of remote.keys()) if (interesting(n)) names.add(n);

    const branches: any[] = [];
    for (const name of names) {
      const id = `${projectId}#${name}`;
      const meta = metas.find((m) => m.id === id);
      const cos = checkouts.filter((co) => co.branch === name);
      const first = cos[0];
      const lf = first ? local.per[first.id] : undefined;
      const remoteSha = remote.get(name) ?? null;
      const pr = pulls.find((p) => p.head.ref === name && (p.state === 'open' || p.merged_at)) ?? pulls.find((p) => p.head.ref === name);
      let prOut: any = null;
      let ci: any = null;
      let commits = lf?.commits ?? [];
      let aheadBase = lf?.aheadBase ?? 0;
      let behindBase = lf?.behindBase ?? 0;
      let apps: any[] = [];
      const base = meta?.base ?? (name === defaultBranch ? null : lf?.base ?? defaultBranch);
      if (ghr && !ghError) {
        try {
          if (pr) {
            const rv = await this.gh.api<any[]>(ghr.account, GitHubAdapter.reviews(ghr.owner, ghr.repo, pr.number));
            prOut = {
              number: pr.number, title: pr.title, state: GitHubAdapter.prState(pr), url: pr.html_url,
              reviews: { approved: rv.filter((r) => r.state === 'APPROVED').length, changesRequested: rv.filter((r) => r.state === 'CHANGES_REQUESTED').length, commented: rv.filter((r) => r.state === 'COMMENTED').length },
            };
          }
          if (remoteSha) {
            const cr = await this.gh.api<any>(ghr.account, GitHubAdapter.checkRuns(ghr.owner, ghr.repo, remoteSha));
            const runs = cr.check_runs || [];
            ci = { ...GitHubAdapter.ciState(runs), url: runs.find((r: any) => r.conclusion === 'failure')?.html_url ?? runs[0]?.html_url ?? null };
            if (!first) {
              // remote-only branch: commits + ahead/behind from GitHub
              const cm = await this.gh.api<any[]>(ghr.account, GitHubAdapter.commits(ghr.owner, ghr.repo, name, 8));
              commits = cm.map((x) => ({ sha: x.sha, subject: String(x.commit?.message || '').split('\n')[0], author: x.commit?.author?.name, at: Date.parse(x.commit?.author?.date) }));
              if (base) {
                const cmp = await this.gh.api<any>(ghr.account, GitHubAdapter.compare(ghr.owner, ghr.repo, base, name));
                aheadBase = cmp.ahead_by ?? 0;
                behindBase = cmp.behind_by ?? 0;
              }
            }
            // repo scan on the pushed branch: apps/*/app.json (finds apps built by cloud sessions)
            if (name !== defaultBranch || !first) {
              const tree = await this.gh.api<any>(ghr.account, GitHubAdapter.tree(ghr.owner, ghr.repo, remoteSha));
              const found = (tree.tree || []).filter((t: any) => t.type === 'blob' && /^apps\/[^/]+\/app\.json$/.test(t.path));
              apps = await Promise.all(found.slice(0, 10).map(async (t: any) => {
                let title = t.path.split('/')[1];
                let appId = title;
                try {
                  const m = JSON.parse((await this.gh.api<Buffer>(ghr.account, GitHubAdapter.contents(ghr.owner, ghr.repo, t.path, remoteSha), true)).toString('utf8'));
                  title = m.title || title;
                  appId = m.id || appId;
                } catch {}
                return { path: t.path.replace(/\/app\.json$/, ''), id: appId, title };
              }));
            }
          }
        } catch (e: any) {
          L(`github ${id}: ${e.message}`);
        }
      }
      const up = first ? { ahead: first.ahead ?? 0, behind: first.behind ?? 0 } : { ahead: 0, behind: 0 };
      const cloudSession = /^claude\//.test(name) || /^codex\//.test(name)
        ? this.c.store.sessions("kind='cloud' AND checkout_id IN (SELECT id FROM checkout WHERE repo_id=?)", projectId)
            .find((s) => s.meta.resultBranch === name || (s.native_id && commits.some((cm: any) => String(cm.subject || '').includes(s.native_id!))))
        : undefined;
      branches.push({
        id, projectId, name, base, goal: meta?.goal ?? null, createdBy: meta?.created_by ?? (interesting(name) ? 'agent' : 'other'),
        checkouts: cos.map((x) => x.id), head: first?.head ?? null, pushed: !!remoteSha, remoteSha,
        aheadRemote: remoteSha ? up.ahead : 0, behindRemote: remoteSha ? up.behind : 0, aheadBase, behindBase,
        pr: prOut, ci, commits, apps, cloud: interesting(name) ? { sessionId: cloudSession?.id } : null, updatedAt: Date.now(),
      });
    }
    // write + emit; drop branches that are gone
    const before = new Set(this.c.db.all('SELECT id FROM branch WHERE project_id=?', projectId).map((r) => r.id));
    for (const b of branches) {
      const prev = this.c.db.get('SELECT data FROM branch WHERE id=?', b.id)?.data;
      const { updatedAt, ...cmp } = b;
      const prevCmp = prev ? (({ updatedAt: _u, ...rest }) => rest)(JSON.parse(prev)) : null;
      before.delete(b.id);
      if (prevCmp && JSON.stringify(prevCmp) === JSON.stringify(cmp)) continue;
      this.c.db.upsert('branch', { id: b.id, project_id: projectId, name: b.name, data: b, updated_at: updatedAt });
      this.c.bus.publish('branch.upsert', b);
    }
    for (const gone of before) {
      this.c.db.run('DELETE FROM branch WHERE id=?', gone);
      this.c.bus.publish('branch.remove', { id: gone });
    }
    const project = {
      id: projectId, name: repo.name, remoteUrl: repo.remote_url, gh: ghr, defaultBranch, readme: local.readme,
      stats: { ...local.stats, branches: branches.length, sessions: this.c.store.sessions('checkout_id IN (SELECT id FROM checkout WHERE repo_id=?)', projectId).length },
      folders: local.folders, checkouts: checkouts.map((x) => x.id), githubError: ghError, updatedAt: Date.now(),
    };
    const prevP = this.c.db.get('SELECT data FROM project WHERE id=?', projectId)?.data;
    const strip = (o: any) => JSON.stringify({ ...o, updatedAt: 0 });
    if (!prevP || strip(JSON.parse(prevP)) !== strip(project)) {
      this.c.db.upsert('project', { id: projectId, data: project, updated_at: Date.now() });
      this.c.bus.publish('project.upsert', project);
    }
  }

  /** New branch = a git worktree on the chosen host, optionally pushed under the host's git credentials. */
  async createBranch(o: { projectId: string; checkoutId: string; base: string; name: string; goal?: string; push?: boolean; createdBy?: string }) {
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(o.name) || o.name.includes('..') || o.name.startsWith('/') || o.name.endsWith('/')) throw new Error('invalid branch name');
    const co = this.c.repos.checkout(o.checkoutId);
    if (!co || co.repo_id !== o.projectId) throw new Error('checkout is not part of this project');
    const id = `${o.projectId}#${o.name}`;
    // worktrees live beside the main checkout: <parent>/<repo>.worktrees/<branch-slug> (inside the host's scan roots)
    const m = co.path.match(/^(.*)\/([^/]+)\.worktrees\/[^/]+$/);
    const parent = m ? m[1] : co.path.replace(/\/[^/]+$/, '');
    const repoName = m ? m[2] : co.path.split('/').pop();
    const wt = `${parent}/${repoName}.worktrees/${o.name.replace(/\//g, '-')}`;
    const p = q(co.path);
    const base = o.base || 'main';
    const script = [
      `git -C ${p} fetch -q origin 2>/dev/null || true`,
      `if git -C ${p} rev-parse -q --verify ${q('refs/heads/' + o.name)} >/dev/null; then echo "branch exists" >&2; exit 3; fi`,
      `start=$(git -C ${p} rev-parse -q --verify ${q('origin/' + base)} || git -C ${p} rev-parse -q --verify ${q(base)}) || { echo "unknown base ${base}" >&2; exit 4; }`,
      `git -C ${p} worktree add -q -b ${q(o.name)} ${q(wt)} "$start"`,
      o.push ? `git -C ${q(wt)} push -q -u origin ${q(o.name)}` : 'true',
    ].join(' && ');
    await this.c.hosts.execOk(co.host_id, script, { timeoutMs: 60000 });
    this.c.db.upsert('branch_meta', { id, base, goal: o.goal ?? null, created_by: o.createdBy ?? 'hub', created_at: Date.now() });
    L(`created ${o.name} (from ${base}) as worktree ${wt} on ${co.host_id}${o.push ? ', pushed' : ''}`);
    await this.c.repos.refreshPath(co.host_id, wt);
    this.lastStats.delete(o.projectId);
    await this.refresh(o.projectId);
    return this.branch(id);
  }
}

export { rpath };
