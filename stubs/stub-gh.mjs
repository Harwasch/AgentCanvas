#!/usr/bin/env node
// stub-gh: stands in for the GitHub CLI (`gh api …`, `gh auth status`) in tests.
// Repos are the test env's bare git repos (STUB_GH_GIT_ROOT/<repo>.git, owner ignored);
// pull requests, reviews and check runs come from $GH_CONFIG_DIR/stub-github.json:
//   { "pulls": { "<owner>/<repo>": [ { number, title, state, draft, merged, head, base, reviews: [state…], checks: [{name, status, conclusion}] } ] } }
// Output shapes follow the GitHub REST API (v2022-11-28) for the fields the hub reads.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { home } from './common.mjs';

const argv = process.argv.slice(2);
const CFG = process.env.GH_CONFIG_DIR || path.join(home, '.config', 'gh');
const GIT_ROOT = process.env.STUB_GH_GIT_ROOT || '/srv/agent-hub-git';
const die = (msg, code = 1) => {
  process.stderr.write(msg + '\n');
  process.exit(code);
};
if (!fs.existsSync(path.join(CFG, 'hosts.yml'))) die('To get started with GitHub CLI, please run:  gh auth login', 4);
const login = (fs.readFileSync(path.join(CFG, 'hosts.yml'), 'utf8').match(/user:\s*(\S+)/) || [])[1] || 'stub-user';

if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stderr.write(`github.com\n  ✓ Logged in to github.com account ${login} (${CFG}/hosts.yml)\n`);
  process.exit(0);
}
if (argv[0] !== 'api') die(`stub-gh: only "gh api" and "gh auth status" are stubbed`, 2);

let endpoint;
let method = 'GET';
const headers = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-X' || a === '--method') method = argv[++i];
  else if (a === '-H' || a === '--header') headers.push(argv[++i]);
  else if (a === '--paginate' || a === '--silent') continue;
  else if (!a.startsWith('-') && !endpoint) endpoint = a;
}
const raw = headers.some((h) => /vnd\.github\.raw/i.test(h));
const u = new URL(endpoint.replace(/^\//, ''), 'https://api.github.com/');
const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
const q = u.searchParams;
if (parts[0] !== 'repos' || parts.length < 3) die(`gh: Not Found (HTTP 404)`);
const [, owner, repo, ...rest] = parts;
const gitDir = path.join(GIT_ROOT, `${repo}.git`);
if (!fs.existsSync(gitDir)) die('gh: Not Found (HTTP 404)');
const git = (...a) => execFileSync('git', ['--git-dir', gitDir, ...a], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
const gits = (...a) => git(...a).toString('utf8');
const fixtures = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(CFG, 'stub-github.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const pulls = (fixtures.pulls || {})[`${owner}/${repo}`] || [];
const out = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');
const html = `https://github.com/${owner}/${repo}`;
const resolve = (ref) => {
  try {
    return gits('rev-parse', '--verify', '-q', `${ref}^{commit}`).trim();
  } catch {
    die('gh: No commit found for SHA: ' + ref + ' (HTTP 422)');
  }
};
const defaultBranch = () => gits('symbolic-ref', '--short', 'HEAD').trim();
if (method !== 'GET') die(`stub-gh: ${method} not stubbed (HTTP 405)`);

const r0 = rest[0];
if (!r0) {
  const size = Math.round(Number((gits('count-objects', '-v').match(/size-pack: (\d+)/) || [])[1] || 0));
  out({ id: 1, name: repo, full_name: `${owner}/${repo}`, private: true, html_url: html, default_branch: defaultBranch(), size, owner: { login: owner } });
} else if (r0 === 'branches') {
  const lines = gits('for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads').trim().split('\n').filter(Boolean);
  out(lines.map((l) => {
    const [name, sha] = l.split(' ');
    return { name, commit: { sha, url: `${html}/commit/${sha}` }, protected: name === defaultBranch() };
  }));
} else if (r0 === 'pulls' && !rest[1]) {
  const state = q.get('state') || 'open';
  const list = pulls.filter((p) => state === 'all' || (state === 'open' ? p.state === 'open' : p.state !== 'open'));
  out(list.map((p) => {
    let sha = null;
    try {
      sha = resolve(p.head);
    } catch {}
    return {
      number: p.number, title: p.title, state: p.state === 'open' ? 'open' : 'closed', draft: !!p.draft, merged_at: p.merged ? new Date().toISOString() : null,
      html_url: `${html}/pull/${p.number}`, head: { ref: p.head, sha, label: `${owner}:${p.head}` }, base: { ref: p.base || defaultBranch() }, user: { login },
    };
  }));
} else if (r0 === 'pulls' && rest[2] === 'reviews') {
  const p = pulls.find((x) => String(x.number) === rest[1]);
  if (!p) die('gh: Not Found (HTTP 404)');
  out((p.reviews || []).map((s, i) => ({ id: i + 1, state: s, user: { login: `reviewer${i + 1}` } })));
} else if (r0 === 'commits' && rest[2] === 'check-runs') {
  const sha = resolve(rest[1]);
  const branch = gits('for-each-ref', '--points-at', sha, '--format=%(refname:short)', 'refs/heads').trim().split('\n')[0];
  const p = pulls.find((x) => x.head === branch) || (fixtures.checks || {})[branch] && { checks: fixtures.checks[branch] };
  const runs = (p?.checks || []).map((c, i) => ({ id: i + 1, name: c.name, status: c.status || 'completed', conclusion: c.status && c.status !== 'completed' ? null : c.conclusion || 'success', head_sha: sha, html_url: `${html}/actions/runs/${1000 + i}` }));
  out({ total_count: runs.length, check_runs: runs });
} else if (r0 === 'commits' && !rest[1]) {
  const sha = resolve(q.get('sha') || defaultBranch());
  const n = Number(q.get('per_page') || 30);
  const args = ['log', `-${n}`, '--format=%H%x1f%an%x1f%aI%x1f%s', sha];
  if (q.get('path')) args.push('--', q.get('path'));
  out(gits(...args).trim().split('\n').filter(Boolean).map((l) => {
    const [h, an, at, s] = l.split('\x1f');
    return { sha: h, html_url: `${html}/commit/${h}`, commit: { message: s, author: { name: an, date: at } } };
  }));
} else if (r0 === 'compare') {
  const [base, head] = rest.slice(1).join('/').split('...');
  const b = resolve(base);
  const h = resolve(head);
  const [behind, ahead] = gits('rev-list', '--left-right', '--count', `${b}...${h}`).trim().split(/\s+/).map(Number);
  out({ status: ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'identical', ahead_by: ahead, behind_by: behind, total_commits: ahead });
} else if (r0 === 'git' && rest[1] === 'trees') {
  const sha = resolve(rest.slice(2).join('/'));
  const recursive = q.has('recursive');
  const lines = gits('ls-tree', '-l', ...(recursive ? ['-r', '-t'] : []), sha).trim().split('\n').filter(Boolean);
  out({ sha, truncated: false, tree: lines.map((l) => {
    const [meta, p] = l.split('\t');
    const [mode, type, osha, size] = meta.split(/\s+/);
    return { path: p, mode, type, sha: osha, ...(type === 'blob' ? { size: Number(size) } : {}) };
  }) });
} else if (r0 === 'contents') {
  const p = rest.slice(1).join('/');
  const ref = q.get('ref') || defaultBranch();
  let buf;
  try {
    buf = git('show', `${resolve(ref)}:${p}`);
  } catch {
    die('gh: Not Found (HTTP 404)');
  }
  if (raw) process.stdout.write(buf);
  else out({ type: 'file', path: p, name: path.basename(p), size: buf.length, encoding: 'base64', content: buf.toString('base64'), sha: gits('rev-parse', `${resolve(ref)}:${p}`).trim(), html_url: `${html}/blob/${ref}/${p}` });
} else die('gh: Not Found (HTTP 404)');
