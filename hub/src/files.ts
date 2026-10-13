// Any repo file as a node: list/read files from a host checkout (over SSH) or a
// GitHub ref (through gh), pin them to the last commit that touched the path,
// and detect newer versions. Uncommitted files pin to "worktree" (always live).
import type { Ctx } from './ctx.js';
import { GitHubAdapter } from './adapters.js';
import { q } from './ssh.js';

export type FileSource = { kind: 'checkout'; checkoutId: string } | { kind: 'github'; projectId: string; ref: string };
export type FileKind = 'doc' | 'image' | 'code' | 'model3d' | 'pdf' | 'text' | 'binary';

const EXT: Record<string, FileKind> = {
  md: 'doc', markdown: 'doc', mdx: 'doc',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image',
  stl: 'model3d', pdf: 'pdf',
  c: 'code', h: 'code', cc: 'code', cpp: 'code', hpp: 'code', py: 'code', ts: 'code', tsx: 'code', js: 'code', mjs: 'code', jsx: 'code', rs: 'code', go: 'code',
  java: 'code', kt: 'code', swift: 'code', rb: 'code', sh: 'code', bash: 'code', zsh: 'code', toml: 'code', yaml: 'code', yml: 'code', json: 'code', html: 'code',
  css: 'code', scss: 'code', sql: 'code', lua: 'code', m: 'code', vhd: 'code', v: 'code', sv: 'code', ino: 'code', cmake: 'code', makefile: 'code', dockerfile: 'code',
  txt: 'text', log: 'text', csv: 'text', tsv: 'text', ini: 'text', cfg: 'text', conf: 'text', rst: 'text',
};
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  pdf: 'application/pdf', stl: 'model/stl',
};

export function fileKind(path: string): FileKind {
  const base = path.split('/').pop()!.toLowerCase();
  if (base === 'makefile' || base === 'dockerfile') return 'code';
  const ext = base.includes('.') ? base.split('.').pop()! : '';
  return EXT[ext] ?? (ext ? 'binary' : 'text');
}
export function fileMime(path: string): string {
  const ext = path.split('.').pop()!.toLowerCase();
  if (MIME[ext]) return MIME[ext];
  const k = fileKind(path);
  return k === 'binary' ? 'application/octet-stream' : 'text/plain; charset=utf-8';
}

export function parseSource(v: unknown): FileSource {
  const s = typeof v === 'string' ? JSON.parse(v) : v;
  if (s?.kind === 'checkout' && typeof s.checkoutId === 'string') return { kind: 'checkout', checkoutId: s.checkoutId };
  if (s?.kind === 'github' && typeof s.projectId === 'string' && typeof s.ref === 'string') return { kind: 'github', projectId: s.projectId, ref: s.ref };
  throw new Error('invalid file source');
}

export function safePath(p: string) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.split('/').some((x) => x === '..' || x === '') || p.includes('\0')) throw new Error('bad path');
  return p;
}

export interface Pin {
  sha: string; // commit sha, or "worktree"
  blob: string | null;
  subject?: string;
  at?: number;
}

export class FileService {
  constructor(private c: Ctx) {}

  private co(id: string) {
    const co = this.c.repos.checkout(id);
    if (!co) throw new Error('unknown checkout');
    return co;
  }
  private gh(projectId: string) {
    const g = this.c.projects.ghRef(projectId);
    if (!g) throw new Error('project has no GitHub remote / account');
    return g;
  }

  async list(src: FileSource, filter = ''): Promise<{ path: string; kind: FileKind }[]> {
    let paths: string[];
    if (src.kind === 'checkout') {
      const co = this.co(src.checkoutId);
      const out = await this.c.hosts.execOk(co.host_id, `git -C ${q(co.path)} ls-files --cached --others --exclude-standard | head -20000`, { timeoutMs: 30000 });
      paths = out.split('\n').filter(Boolean);
    } else {
      const g = this.gh(src.projectId);
      const t = await this.c.projects.gh.api<any>(g.account, GitHubAdapter.tree(g.owner, g.repo, src.ref));
      paths = (t.tree || []).filter((x: any) => x.type === 'blob').map((x: any) => x.path);
    }
    const f = filter.toLowerCase();
    const scored = paths.filter((p) => !f || p.toLowerCase().includes(f) || fuzzy(p.toLowerCase(), f));
    scored.sort((a, b) => (f ? Number(b.toLowerCase().includes(f)) - Number(a.toLowerCase().includes(f)) : 0) || a.length - b.length);
    return scored.slice(0, 2000).map((path) => ({ path, kind: fileKind(path) }));
  }

  /** Last commit that touched the path (or "worktree" when the file is uncommitted/dirty). */
  async pin(src: FileSource, path: string): Promise<Pin> {
    safePath(path);
    if (src.kind === 'checkout') {
      const co = this.co(src.checkoutId);
      const p = q(co.path);
      const r = await this.c.hosts.execOk(co.host_id, `cd ${p} && test -f ${q(path)} || { echo missing; exit 0; }; st=$(git status --porcelain -- ${q(path)}); if [ -n "$st" ]; then echo "worktree $(git hash-object ${q(path)})"; else git log -1 --format='%H%x1f%s%x1f%ct' -- ${q(path)}; git rev-parse HEAD:${q(path)} 2>/dev/null; fi`);
      const lines = r.trim().split('\n');
      if (lines[0] === 'missing') throw new Error(`no such file ${path}`);
      if (lines[0].startsWith('worktree ')) return { sha: 'worktree', blob: lines[0].slice(9) };
      const [sha, subject, ct] = lines[0].split('\u001f');
      return { sha, blob: lines[1] || null, subject, at: Number(ct) * 1000 };
    }
    const g = this.gh(src.projectId);
    const cm = await this.c.projects.gh.api<any[]>(g.account, GitHubAdapter.commits(g.owner, g.repo, src.ref, 1, path));
    if (!cm.length) throw new Error(`no such file ${path} on ${src.ref}`);
    return { sha: cm[0].sha, blob: null, subject: String(cm[0].commit?.message || '').split('\n')[0], at: Date.parse(cm[0].commit?.author?.date) };
  }

  async raw(src: FileSource, path: string, sha: string): Promise<Buffer> {
    safePath(path);
    if (src.kind === 'checkout') {
      const co = this.co(src.checkoutId);
      const cmd = sha === 'worktree' || !sha ? `cat ${q(co.path + '/' + path)}` : `git -C ${q(co.path)} show ${q(`${sha}:${path}`)}`;
      if (sha && sha !== 'worktree' && !/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('bad sha');
      const r = await this.c.hosts.execBuf(co.host_id, cmd, { maxBytes: 25 * 1024 * 1024 });
      if (r.code !== 0) throw new Error(r.stderr.trim() || `cannot read ${path}`);
      return r.stdout;
    }
    const g = this.gh(src.projectId);
    return this.c.projects.gh.api<Buffer>(g.account, GitHubAdapter.contents(g.owner, g.repo, path, sha && sha !== 'worktree' ? sha : src.ref), true);
  }
}

function fuzzy(s: string, f: string) {
  let i = 0;
  for (const ch of s) if (ch === f[i]) i++;
  return i === f.length;
}
