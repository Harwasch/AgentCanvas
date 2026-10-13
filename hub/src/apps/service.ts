// App host bridge (hub side): publish/validate/start app servers, serve their
// UI with a deny-by-default CSP, enforce tiers on every tool call (confirm,
// rate limit, audit), promote/pin, hot reload, and screenshots for agents.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../ctx.js';
import { validateManifest, checkUiOrigins, type AppManifest } from './manifest.js';
import { decide, RateLimiter, type Caller } from './policy.js';
import { AppRuntime } from './runtime.js';
import { Shooter } from './shot.js';
import { q } from '../ssh.js';
import { j } from '../db.js';
import type { Session } from '../store.js';
import { log } from '../events.js';

const L = log('apps');

export class AppError extends Error {
  constructor(public errors: string[], public warnings: string[] = []) {
    super(errors.join('; '));
  }
}

export interface PublishResult {
  node: any;
  errors: string[];
  warnings: string[];
  consoleErrors: string[];
  serverLog: string[];
  screenshot?: Buffer;
}

export class AppService {
  private runtimes = new Map<string, AppRuntime>();
  private html = new Map<string, string>();
  private limiter = new RateLimiter();
  private debounce = new Map<string, NodeJS.Timeout>();
  private confirmWaiters = new Map<string, (ok: boolean) => void>();
  shooter: Shooter;
  private idleTimer?: NodeJS.Timeout;

  constructor(private c: Ctx) {
    this.shooter = new Shooter(c.cfg, c.secrets.hubToken);
  }

  private dir(id: string) {
    const d = path.join(this.c.cfg.dataDir, 'apps', id);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  row(id: string) {
    return this.c.db.get('SELECT * FROM app_node WHERE id=?', id);
  }

  view(r: any) {
    if (!r) return undefined;
    const m: AppManifest | null = j<AppManifest>(r.manifest, null);
    return {
      id: r.id, type: 'app', appId: r.app_id, sessionId: r.session_id, hostId: r.host_id, dir: r.dir, checkoutId: r.checkout_id, title: r.title,
      state: r.state, version: r.version, pinnedCommit: r.pinned_commit, grantedVersion: r.granted_version, status: this.runtimes.get(r.id)?.status ?? r.status,
      errors: j(r.errors, []), url: `/api/apps/${r.id}/ui?v=${r.version}`, thumbnail: r.thumbnail ? `/api/apps/${r.id}/thumbnail.png?t=${r.updated_at}` : null,
      updatedAt: r.updated_at, previewOf: r.preview_of ?? null,
      manifest: m ? { id: m.id, title: m.title, version: m.version, lifecycle: m.lifecycle, tools: m.tools, node: m.node, ui: m.ui, csp: m.csp, devices: m.devices || [] } : null,
    };
  }

  nodes() {
    return this.c.db.all('SELECT * FROM app_node ORDER BY created_at').map((r) => this.view(r));
  }

  private emit(id: string) {
    const v = this.view(this.row(id));
    if (v) this.c.bus.publish('node.upsert', v);
    return v;
  }

  private nodeIdFor(hostId: string, dir: string) {
    const co = this.c.repos.checkoutForPath(hostId, dir);
    const key = co ? `${co.repo_id}:${dir.slice(co.path.length + 1)}` : `${hostId}:${dir}`;
    return { id: 'app-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 10), checkoutId: co?.id ?? null };
  }

  /** Resolve an id given by an agent: node id, or manifest id (prefer the caller's session). */
  resolve(idOrAppId: string, sessionId?: string | null) {
    let r = this.row(idOrAppId);
    if (!r) {
      const rows = this.c.db.all('SELECT * FROM app_node WHERE app_id=? ORDER BY (session_id=?) DESC, (preview_of IS NOT NULL) DESC, updated_at DESC', idOrAppId, sessionId ?? '');
      r = rows[0];
    }
    if (!r) throw new Error(`no published app "${idOrAppId}"`);
    return r;
  }

  private async readManifest(hostId: string, dir: string) {
    const r = await this.c.hosts.exec(hostId, `cat ${q(dir + '/app.json')}`);
    if (r.code !== 0) throw new AppError([`no app.json in ${dir}`]);
    let raw: unknown;
    try {
      raw = JSON.parse(r.stdout);
    } catch (e: any) {
      throw new AppError([`app.json is not valid JSON: ${e.message}`]);
    }
    const v = validateManifest(raw);
    if (!v.ok) throw new AppError(v.errors, v.warnings);
    return { manifest: v.manifest!, warnings: v.warnings };
  }

  /** Start/restart the server and load the UI for a node from `runDir`. */
  private async materialize(id: string, hostId: string, runDir: string, manifest: AppManifest): Promise<{ warnings: string[]; errors: string[] }> {
    const warnings: string[] = [];
    const errors: string[] = [];
    this.runtimes.get(id)?.stop();
    this.runtimes.delete(id);
    let html: string;
    if (manifest.server) {
      if (manifest.server.transport !== 'stdio') throw new AppError(['server.transport "http" is validated but not supported by hub v1 (use stdio)']);
      const rt = new AppRuntime(this.c.hosts, hostId, runDir, manifest.server.command, manifest.server.env);
      this.runtimes.set(id, rt);
      rt.onExit((code) => {
        if (this.runtimes.get(id) !== rt) return;
        this.c.db.run('UPDATE app_node SET status=?, logs=?, updated_at=? WHERE id=?', code ? 'error' : 'stopped', JSON.stringify(rt.logs.slice(-50)), Date.now(), id);
        this.emit(id);
        if (manifest.lifecycle === 'always-on' && code !== 0) setTimeout(() => this.ensureRunning(id).catch((e) => L(`restart ${id}: ${e.message}`)), 3000);
      });
      await rt.start();
      const serverTools = rt.tools.map((t) => t.name);
      for (const t of serverTools) if (!manifest.tools[t]) warnings.push(`server tool "${t}" is not declared in app.json; the hub refuses it`);
      for (const t of Object.keys(manifest.tools)) if (!serverTools.includes(t)) warnings.push(`declared tool "${t}" is not offered by the server`);
      ({ html } = await rt.readResource(manifest.ui));
    } else {
      const r = await this.c.hosts.exec(hostId, `cat ${q(runDir + '/' + manifest.uiFile)}`);
      if (r.code) throw new AppError([`uiFile ${manifest.uiFile} not readable`]);
      html = r.stdout;
    }
    errors.push(...checkUiOrigins(html, manifest.csp));
    if (errors.length) {
      this.runtimes.get(id)?.stop();
      throw new AppError(errors, warnings);
    }
    this.html.set(id, html);
    fs.writeFileSync(path.join(this.dir(id), 'ui.html'), html);
    return { warnings, errors };
  }

  /** publish_app / repo-scan publish / hot reload. */
  async publish(o: { hostId: string; dir: string; sessionId?: string | null; title?: string; caller: Caller; shoot?: boolean }): Promise<PublishResult> {
    const dir = o.dir.replace(/\/+$/, '');
    const base = this.nodeIdFor(o.hostId, dir);
    const existing = this.row(base.id);
    // after promotion, agent edits create a preview version beside the pinned one
    const asPreview = existing?.state === 'promoted' && o.caller.kind !== 'user';
    const id = asPreview ? `${base.id}-pv` : base.id;
    const prev = this.row(id);
    let manifest: AppManifest;
    let warnings: string[] = [];
    try {
      ({ manifest, warnings } = await this.readManifest(o.hostId, dir));
      if (manifest.runsOn && manifest.runsOn !== o.hostId && manifest.runsOn !== 'hub')
        warnings.push(`runsOn "${manifest.runsOn}" differs from the host holding the app (${o.hostId}); v1 runs it where the files are`);
      const runDir = prev?.state === 'promoted' && !asPreview && prev.pinned_dir ? prev.pinned_dir : dir;
      const mat = await this.materialize(id, o.hostId, runDir, manifest);
      warnings.push(...mat.warnings);
    } catch (e: any) {
      const errs = e instanceof AppError ? e.errors : [String(e.message || e)];
      if (prev) {
        this.c.db.run('UPDATE app_node SET status=?, errors=?, updated_at=? WHERE id=?', 'error', JSON.stringify(errs), Date.now(), id);
        this.emit(id);
      }
      return { node: prev ? this.view(this.row(id)) : null, errors: errs, warnings: e.warnings || warnings, consoleErrors: [], serverLog: this.runtimes.get(id)?.logs.slice(-20) ?? [] };
    }
    const now = Date.now();
    this.c.db.upsert('app_node', {
      id, app_id: manifest.id, session_id: o.sessionId ?? prev?.session_id ?? existing?.session_id ?? null, host_id: o.hostId, dir, checkout_id: base.checkoutId,
      title: o.title || manifest.title, manifest, state: prev?.state ?? 'preview', version: (prev?.version ?? 0) + 1,
      granted_version: prev?.granted_version ?? null, status: this.runtimes.get(id)?.status ?? 'running', errors: [], preview_of: asPreview ? base.id : null,
      created_at: prev?.created_at ?? now, updated_at: now,
    });
    // reloading a promoted node restarts the same pinned commit, so a current grant carries over
    if (prev?.state === 'promoted' && !asPreview && prev.granted_version === prev.version) {
      this.c.db.run('UPDATE app_node SET granted_version=? WHERE id=?', prev.version + 1, id);
      this.audit(id, '(reload)', 'actuate', o.caller, {}, true, `pinned ${String(prev.pinned_commit).slice(0, 12)} restarted; grant carried to v${prev.version + 1}`, '');
    }
    this.emit(id);
    if (base.checkoutId) this.c.repos.refreshCheckout(base.checkoutId).catch(() => {});
    L(`published ${id} (${manifest.id} v${(prev?.version ?? 0) + 1}) from ${o.hostId}:${dir}${asPreview ? ' as preview beside pinned' : ''}`);
    let shot: Buffer | undefined;
    let consoleErrors: string[] = [];
    if (o.shoot !== false) {
      try {
        const s = await this.screenshot(id);
        shot = s.png;
        consoleErrors = s.consoleErrors;
      } catch (e: any) {
        consoleErrors.push(`screenshot failed: ${e.message}`);
      }
    }
    return { node: this.view(this.row(id)), errors: [], warnings, consoleErrors, serverLog: this.runtimes.get(id)?.logs.slice(-20) ?? [], screenshot: shot };
  }

  async screenshot(id: string, size?: { width: number; height: number }) {
    const r = this.row(id);
    if (!r) throw new Error('unknown app node');
    const m: AppManifest = j<AppManifest>(r.manifest, null);
    const s = await this.shooter.shoot(id, size ?? m?.node);
    fs.writeFileSync(path.join(this.dir(id), 'thumbnail.png'), s.png);
    this.c.db.run('UPDATE app_node SET thumbnail=?, updated_at=? WHERE id=?', 'thumbnail.png', Date.now(), id);
    this.emit(id);
    return s;
  }

  thumbnail(id: string): Buffer | undefined {
    const f = path.join(this.c.cfg.dataDir, 'apps', id, 'thumbnail.png');
    return fs.existsSync(f) ? fs.readFileSync(f) : undefined;
  }

  ui(id: string): { html: string; manifest: AppManifest } | undefined {
    const r = this.row(id);
    if (!r) return undefined;
    let html = this.html.get(id);
    if (!html) {
      const f = path.join(this.c.cfg.dataDir, 'apps', id, 'ui.html');
      if (fs.existsSync(f)) html = fs.readFileSync(f, 'utf8');
    }
    return html ? { html, manifest: j<AppManifest>(r.manifest, null) } : undefined;
  }

  private async ensureRunning(id: string) {
    const r = this.row(id);
    if (!r) throw new Error('unknown app node');
    const rt = this.runtimes.get(id);
    if (rt && rt.status === 'running') return rt;
    const m: AppManifest = j<AppManifest>(r.manifest, null);
    const runDir = r.state === 'promoted' && r.pinned_dir ? r.pinned_dir : r.dir;
    await this.materialize(id, r.host_id, runDir, m);
    this.c.db.run('UPDATE app_node SET status=? WHERE id=?', 'running', id);
    this.emit(id);
    return this.runtimes.get(id)!;
  }

  private audit(nodeId: string, tool: string, tier: string, caller: Caller, args: any, allowed: boolean, reason: string, result: string) {
    const ts = Date.now();
    const callerS = `${caller.kind}:${caller.label || caller.id}`;
    const r = this.c.db.run('INSERT INTO audit (ts, app_node_id, tool, tier, caller, args, allowed, reason, result) VALUES (?,?,?,?,?,?,?,?,?)', ts, nodeId, tool, tier, callerS, JSON.stringify(args ?? {}), allowed ? 1 : 0, reason, result.slice(0, 1000));
    this.c.bus.publish('audit.append', { id: Number(r.lastInsertRowid), ts, app_node_id: nodeId, tool, tier, caller: callerS, args, allowed, reason, result: result.slice(0, 1000) });
  }

  /**
   * Every tool call from a node, an agent or another app passes here.
   * Agents asking for a confirm-tier tool get a confirm prompt in the hub and wait for the human.
   */
  async call(id: string, tool: string, args: any, caller: Caller, confirmed: boolean): Promise<{ ok: true; result: any } | { ok: false; code: string; reason: string }> {
    const r = this.row(id);
    if (!r) return { ok: false, code: 'unknown', reason: 'unknown app node' };
    const node = { state: r.state, version: r.version, grantedVersion: r.granted_version, manifest: j<AppManifest>(r.manifest, null) } as any;
    const m = node.manifest as AppManifest;
    const locks = (m?.devices || []).map((dv) => {
      const full = `${r.host_id}:${dv}`;
      const l = this.c.compute.lockOf(full);
      return { device: full, title: this.c.compute.device(full)?.title, holder: l?.sessionId ?? null, holderLabel: l ? this.c.compute.holderLabel(l.sessionId) : undefined };
    });
    let d = decide(node, id, tool, { confirmed, now: Date.now(), caller, locks }, this.limiter);
    if (!d.allowed && d.code === 'needs_confirm' && caller.kind !== 'user') {
      const ok = await this.askConfirm(id, tool, args, caller);
      if (ok) d = decide(node, id, tool, { confirmed: true, now: Date.now(), caller, locks }, this.limiter);
    }
    if (!d.allowed) {
      this.audit(id, tool, d.tier ?? 'unknown', caller, args, false, d.reason, '');
      return { ok: false, code: d.code, reason: d.reason };
    }
    try {
      const rt = await this.ensureRunning(id);
      const result = await rt.call(tool, args);
      const text = (result?.content || []).map((c: any) => c.text).filter(Boolean).join(' ');
      // audited: every actuate call, every refusal, every agent/app call; the node's own read polling is not
      if (d.tier === 'actuate' || caller.kind !== 'user') this.audit(id, tool, d.tier, caller, args, true, d.reason, text);
      return { ok: true, result };
    } catch (e: any) {
      this.audit(id, tool, d.tier, caller, args, true, d.reason, `error: ${e.message}`);
      return { ok: true, result: { isError: true, content: [{ type: 'text', text: `app server error: ${e.message}` }] } };
    }
  }

  private askConfirm(id: string, tool: string, args: any, caller: Caller): Promise<boolean> {
    const r = this.row(id)!;
    const aid = `app-confirm-${crypto.randomBytes(4).toString('hex')}`;
    this.c.store.upsertApproval({
      id: aid, session_id: caller.kind === 'agent' ? caller.id : r.session_id, source: 'app-confirm', status: 'pending',
      title: `${r.title}: ${tool}`, detail: `${caller.kind} ${caller.label || caller.id} wants to call ${tool} ${JSON.stringify(args)}`, data: { nodeId: id, tool, args },
    });
    this.c.push.notify({ title: 'Confirm app action', body: `${r.title}: ${tool}`, tag: aid, url: `/?focus=${id}` });
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.confirmWaiters.delete(aid);
        this.c.store.upsertApproval({ id: aid, status: 'expired' });
        resolve(false);
      }, 120_000);
      this.confirmWaiters.set(aid, (ok) => {
        clearTimeout(t);
        resolve(ok);
      });
    });
  }

  decideConfirm(approvalId: string, decision: 'allow' | 'deny') {
    const w = this.confirmWaiters.get(approvalId);
    this.confirmWaiters.delete(approvalId);
    this.c.store.upsertApproval({ id: approvalId, status: decision, decided_by: 'hub' });
    w?.(decision === 'allow');
  }

  async resource(id: string, uri: string) {
    const rt = await this.ensureRunning(id);
    return rt.peer!.request('resources/read', { uri });
  }

  status(id: string) {
    const r = this.row(id)!;
    const rt = this.runtimes.get(id);
    return {
      id, appId: r.app_id, title: r.title, state: r.state, version: r.version, pinnedCommit: r.pinned_commit, grantedVersion: r.granted_version,
      server: rt?.status ?? r.status, errors: j(r.errors, []), logs: (rt?.logs ?? j(r.logs, [])).slice(-20), tier: r.state === 'promoted' && r.granted_version === r.version ? 'actuate granted (pinned)' : 'read-only (preview)',
    };
  }

  // ------------------------------------------------------------ promote
  private async repoRoot(hostId: string, dir: string) {
    return (await this.c.hosts.execOk(hostId, `git -C ${q(dir)} rev-parse --show-toplevel`)).trim();
  }

  /**
   * The exact tree "Commit & pin" would commit: HEAD plus everything under the app dir (tracked changes,
   * deletions and untracked files, recursively), built in a throwaway index. Prints head, head tree, tree.
   */
  private treeScript(dir: string) {
    return `cd ${q(dir)} && head=$(git rev-parse HEAD) && idx="$(git rev-parse --absolute-git-dir)/agent-hub-review.$$" && ` +
      `trap 'rm -f "$idx"' EXIT && GIT_INDEX_FILE="$idx" git read-tree "$head" && GIT_INDEX_FILE="$idx" git add -A -- . && ` +
      `tree=$(GIT_INDEX_FILE="$idx" git write-tree) && printf '%s\\n%s\\n%s\\n' "$head" "$(git rev-parse "$head^{tree}")" "$tree"`;
  }

  async review(id: string) {
    const r = this.row(id)!;
    const m: AppManifest = j<AppManifest>(r.manifest, null);
    const t = await this.c.hosts.exec(r.host_id, this.treeScript(r.dir) +
      ` && printf '\\036' && GIT_INDEX_FILE="$idx" git diff --cached --name-status --relative --no-renames -z "$head" -- . && printf '\\036' && git ls-tree -r -l -z "$tree" -- .`);
    const [ids = '', diff = '', tree = ''] = t.stdout.split('\u001e');
    const [commit, headTree, appTree] = ids.trim().split('\n');
    const ok = t.code === 0 && /^[0-9a-f]{40,64}$/.test(commit || '') && /^[0-9a-f]{40,64}$/.test(appTree || '');
    // every change Commit & pin would commit (status + path relative to the app dir)
    const d = diff.split('\0').filter(Boolean);
    const changes: { status: string; path: string }[] = [];
    for (let i = 0; i + 1 < d.length; i += 2) changes.push({ status: d[i], path: d[i + 1] });
    // source preview: every file of the reviewed tree (text only, truncated; the list itself is complete)
    const entries = tree.split('\0').filter(Boolean).map((e) => {
      const m2 = e.match(/^\d+ (\w+) ([0-9a-f]+)\s+(\d+|-)\t(.*)$/s);
      return m2 && m2[1] === 'blob' ? { sha: m2[2], size: Number(m2[3]) || 0, path: m2[4] } : null;
    }).filter(Boolean) as { sha: string; size: number; path: string }[];
    const changed = new Set(changes.map((c) => c.path));
    const shown = [...entries].sort((a, b) => Number(changed.has(b.path)) - Number(changed.has(a.path))).slice(0, 60);
    const PREVIEW = 100_000;
    let serverFiles: { path: string; content: string; size: number; truncated: boolean; changed: boolean }[] = [];
    if (shown.length) {
      // blobs back to back, each cut to min(size, PREVIEW) bytes: split by length, so file content cannot fake a boundary
      const cat = await this.c.hosts.execBuf(r.host_id, `cd ${q(r.dir)} && for s in ${shown.map((e) => e.sha).join(' ')}; do git cat-file blob "$s" | head -c ${PREVIEW}; done`);
      let off = 0;
      serverFiles = shown.map((e) => {
        const n = Math.min(e.size, PREVIEW);
        const raw = cat.stdout.subarray(off, off + n);
        off += n;
        const binary = raw.includes(0);
        return { path: e.path, size: e.size, changed: changed.has(e.path), truncated: binary || e.size > PREVIEW, content: binary ? `(binary, ${e.size} bytes)` : raw.toString('utf8') };
      });
    }
    // binds the reviewed base commit and the full content of what would be committed
    const reviewHash = ok ? crypto.createHash('sha256').update(`${commit}:${appTree}`).digest('hex').slice(0, 16) : '';
    return {
      id, version: r.version, state: r.state, candidateCommit: ok ? commit : null, appTree: ok ? appTree : null,
      dirtyFiles: ok && headTree !== appTree ? changes.map((c) => c.path) : [], changes, files: entries.map((e) => e.path),
      tools: m.tools, lifecycle: m.lifecycle, serverFiles, reviewHash,
    };
  }

  /** Pin a git commit, run the server from a worktree at that commit, and (optionally) grant actuate for this version. */
  async promote(id: string, o: { commit: string; grantActuate: boolean; commitDirty?: boolean; reviewHash?: string }) {
    let r = this.row(id)!;
    if (r.preview_of) {
      // promoting a preview version replaces the pinned node's version
      const pinned = this.row(r.preview_of);
      if (pinned) {
        this.unpublish(id);
        id = pinned.id;
        r = pinned;
      }
    }
    if (!/^[0-9a-f]{7,40}$/.test(o.commit)) throw new Error('commit must be a git sha');
    const rev = await this.review(id);
    if (o.reviewHash && rev.reviewHash !== o.reviewHash) throw new Error('app files changed since you reviewed them; review again');
    let head = (await this.c.hosts.execOk(r.host_id, `git -C ${q(r.dir)} rev-parse HEAD`)).trim();
    if (!head.startsWith(o.commit)) throw new Error(`HEAD moved: reviewed ${o.commit.slice(0, 8)}, now ${head.slice(0, 8)}; review again`);
    if (rev.dirtyFiles.length) {
      if (!o.commitDirty || !o.reviewHash) throw new Error(`app has uncommitted changes; commit them (or use "commit & pin" after review):\n${rev.dirtyFiles.join('\n')}`);
      // commit exactly the reviewed tree under the session account's git identity: rebuild it right before
      // committing, refuse if it differs from the reviewed one, then commit that tree object (nothing else can slip in)
      const acct = this.c.account(this.c.store.session(r.session_id)?.account_id ?? this.c.cfg.accounts[0].id);
      const ident = `-c user.name=${q(acct.git?.name || 'agent-hub')} -c user.email=${q(acct.git?.email || 'hub@localhost')}`;
      const msg = q(`Pin ${r.title} v${r.version} for promotion (Agent Hub)`);
      const out = await this.c.hosts.exec(r.host_id, this.treeScript(r.dir) +
        ` && [ "$head" = ${q(rev.candidateCommit!)} ] && [ "$tree" = ${q(rev.appTree!)} ] || { echo "app files changed since review" >&2; exit 5; }; ` +
        `c=$(git ${ident} commit-tree "$tree" -p "$head" -m ${msg}) && git update-ref -m ${msg} HEAD "$c" "$head" && git reset -q -- . && printf '\\036%s' "$c"`);
      if (out.code === 5) throw new Error('app files changed since you reviewed them; review again');
      if (out.code !== 0) throw new Error(`commit failed: ${out.stderr.trim().slice(0, 300)}`);
      head = out.stdout.split('\u001e').pop()!.trim();
    }
    const root = await this.repoRoot(r.host_id, r.dir);
    const rel = r.dir.slice(root.length + 1);
    const pinDir = `$HOME/.agent-hub/pins/${id}-${head.slice(0, 12)}`;
    const out = await this.c.hosts.execOk(r.host_id, `d="${pinDir}"; if [ ! -d "$d" ]; then git -C ${q(root)} worktree add --detach "$d" ${q(head)} >/dev/null 2>&1 || exit 3; fi; printf %s "$d"`);
    const pinnedDir = `${out.trim()}/${rel}`;
    const m: AppManifest = j<AppManifest>(r.manifest, null);
    await this.materialize(id, r.host_id, pinnedDir, m);
    const version = r.version + 1;
    this.c.db.run('UPDATE app_node SET state=?, pinned_commit=?, pinned_dir=?, version=?, granted_version=?, status=?, errors=?, updated_at=? WHERE id=?',
      'promoted', head, pinnedDir, version, o.grantActuate ? version : null, 'running', '[]', Date.now(), id);
    const user: Caller = { kind: 'user', id: 'hub-user', label: 'you' };
    this.audit(id, '(promote)', 'actuate', user, { commit: head }, true, `pinned ${head.slice(0, 12)}, lifecycle ${m.lifecycle}`, '');
    if (o.grantActuate) this.audit(id, '(grant actuate)', 'actuate', user, { version }, true, `actuate granted for v${version} after review`, '');
    L(`promoted ${id} @ ${head.slice(0, 8)} (actuate ${o.grantActuate ? 'granted' : 'not granted'})`);
    this.screenshot(id).catch(() => {});
    return this.emit(id);
  }

  async reload(id: string) {
    const r = this.row(id)!;
    return this.publish({ hostId: r.host_id, dir: r.dir, sessionId: r.session_id, caller: { kind: 'user', id: 'hub-user', label: 'you' } });
  }

  unpublish(id: string) {
    this.runtimes.get(id)?.stop();
    this.runtimes.delete(id);
    this.html.delete(id);
    this.c.db.run('DELETE FROM app_node WHERE id=?', id);
    this.c.db.run('DELETE FROM layout WHERE node_id=?', id);
    this.c.bus.publish('node.remove', { id });
  }

  /** Hot reload / safety net: a write under **\/apps/<name>/ from a hook or a Codex fileChange item. */
  async onFileWritten(s: Session, file: string) {
    if (!s.host_id) return;
    const abs = file.startsWith('/') ? file : `${s.cwd}/${file}`;
    const m = abs.match(/^(.*\/apps\/[^/]+)\//);
    if (!m) return;
    const dir = m[1];
    const key = `${s.host_id}:${dir}`;
    clearTimeout(this.debounce.get(key));
    this.debounce.set(key, setTimeout(async () => {
      this.debounce.delete(key);
      const has = await this.c.hosts.exec(s.host_id!, `test -f ${q(dir + '/app.json')}`);
      if (has.code) return;
      L(`file change under ${dir} → ${this.row(this.nodeIdFor(s.host_id!, dir).id) ? 'hot reload' : 'auto-publish (unpublished app caught by file hook)'}`);
      await this.publish({ hostId: s.host_id!, dir, sessionId: s.id, caller: { kind: 'agent', id: s.id, label: s.title } });
    }, 1500));
  }

  /** Explicit publish cancels a pending debounced reload for the same dir. */
  cancelPending(hostId: string, dir: string) {
    const key = `${hostId}:${dir.replace(/\/+$/, '')}`;
    clearTimeout(this.debounce.get(key));
    this.debounce.delete(key);
  }

  start() {
    // on-demand servers stop after 15 min without tool calls; the UI reloads them on next use
    this.idleTimer = setInterval(() => {
      for (const [id, rt] of this.runtimes) {
        const m: AppManifest = j<AppManifest>(this.row(id)?.manifest, null);
        if (m?.lifecycle === 'on-demand' && rt.status === 'running' && Date.now() - rt.lastUse > 15 * 60_000) {
          L(`stopping idle on-demand server ${id}`);
          rt.stop();
        }
      }
    }, 60_000);
    // always-on servers come back with the hub
    for (const r of this.c.db.all("SELECT id, manifest FROM app_node")) {
      const m: AppManifest = j<AppManifest>(r.manifest, null);
      if (m?.lifecycle === 'always-on') this.ensureRunning(r.id).catch((e) => L(`start ${r.id}: ${e.message}`));
    }
  }

  async stop() {
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const rt of this.runtimes.values()) rt.stop();
    await this.shooter.close();
  }
}
