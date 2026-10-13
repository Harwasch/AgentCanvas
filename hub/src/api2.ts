// v2 routes: projects/branches (GitHub), files as nodes, canvas nodes, to-dos,
// suggestions, reviews, devices/locks, grants, HIL runs, terminals.
import type { Ctx } from './ctx.js';
import { Router, HttpError } from './http.js';
import { parseSource, fileMime, safePath } from './files.js';
import { validRef } from './projects.js';

export function routesV2(c: Ctx, r: Router) {
  const wrap = async <T>(f: () => Promise<T> | T, status = 409): Promise<T> => {
    try {
      return await f();
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(/unknown|no such/i.test(e.message) ? 404 : /required|invalid|bad /i.test(e.message) ? 400 : status, e.message);
    }
  };

  // ------------------------------------------------------------ projects / branches
  r.post('/api/projects/:id/refresh', 'hub', (req) => wrap(async () => {
    await c.projects.refresh(req.params.id);
    return c.projects.project(req.params.id);
  }));
  r.post('/api/branches', 'hub', (req) => wrap(() => {
    const b = req.body || {};
    if (!validRef(String(b.name || '').trim()) || (b.base != null && b.base !== '' && !validRef(b.base))) throw new HttpError(400, 'invalid branch or base name');
    return c.projects.createBranch({ projectId: b.projectId, checkoutId: b.checkoutId, base: b.base, name: String(b.name || '').trim(), goal: b.goal, push: !!b.push });
  }));
  r.post('/api/branches/:id/refresh', 'hub', (req) => wrap(async () => {
    const br = c.projects.branch(req.params.id);
    if (!br) throw new Error('unknown branch');
    for (const co of br.checkouts) await c.repos.refreshCheckout(co);
    await c.projects.refresh(br.projectId);
    return c.projects.branch(req.params.id);
  }));
  r.get('/api/branches/:id/files', 'hub', (req) => wrap(async () => {
    const br = c.projects.branch(req.params.id);
    if (!br) throw new Error('unknown branch');
    const source = br.checkouts[0] ? { kind: 'checkout' as const, checkoutId: br.checkouts[0] } : { kind: 'github' as const, projectId: br.projectId, ref: br.name };
    return { source, files: await c.files.list(source, req.query.get('q') || '') };
  }));

  // ------------------------------------------------------------ files
  r.get('/api/files/list', 'hub', (req) => wrap(async () => ({ files: await c.files.list(parseSource(req.query.get('source')), req.query.get('q') || '') }), 400));
  r.get('/api/files/raw', 'hub', async (req, res) => {
    const source = wrapSync(() => parseSource(req.query.get('source')));
    const path = wrapSync(() => safePath(req.query.get('path') || ''));
    const sha = req.query.get('sha') || 'worktree';
    let buf: Buffer;
    try {
      buf = await c.files.raw(source, path, sha);
    } catch (e: any) {
      throw new HttpError(404, e.message);
    }
    const mime = fileMime(path);
    res.writeHead(200, {
      'content-type': mime,
      'content-length': buf.length,
      // repo content is untrusted: never let it run as a document on the hub origin
      'content-security-policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      'cache-control': sha !== 'worktree' ? 'private, max-age=86400' : 'no-store',
      'content-disposition': 'inline',
    });
    res.end(buf);
  });

  // ------------------------------------------------------------ canvas nodes
  r.post('/api/cnodes', 'hub', (req) => wrap(() => c.nodes.create(req.body?.type, req.body?.parentId ?? null, req.body?.data || {}), 400));
  r.post('/api/cnodes/:id', 'hub', (req) => wrap(() => c.nodes.patch(req.params.id, req.body?.data || {})));
  r.del('/api/cnodes/:id', 'hub', (req) => wrap(() => {
    c.nodes.remove(req.params.id);
    return { ok: true };
  }));
  r.post('/api/cnodes/:id/latest', 'hub', (req) => wrap(() => c.nodes.latest(req.params.id)));

  // ------------------------------------------------------------ to-dos, suggestions, reviews
  r.post('/api/todos', 'hub', (req) => wrap(() => c.nodes.addTodo(String(req.body?.text || ''), req.body?.scope ?? null), 400));
  r.post('/api/todos/:id', 'hub', (req) => wrap(() => c.nodes.updateTodo(req.params.id, { text: req.body?.text, done: req.body?.done })));
  r.del('/api/todos/:id', 'hub', (req) => wrap(() => {
    c.nodes.removeTodo(req.params.id);
    return { ok: true };
  }));
  r.post('/api/todos/:id/dispatch', 'hub', (req) => wrap(() => c.nodes.dispatchTodo(req.params.id, req.body || {})));
  r.post('/api/suggestions/:id/launch', 'hub', (req) => wrap(() => c.nodes.launchSuggestion(req.params.id, req.body || {})));
  r.post('/api/suggestions/:id/dismiss', 'hub', (req) => wrap(() => c.nodes.dismissSuggestion(req.params.id)));
  r.post('/api/reviews/:id/decision', 'hub', (req) => wrap(() => {
    const d = req.body?.decision;
    if (d !== 'approve' && d !== 'changes') throw new HttpError(400, 'decision must be approve|changes');
    return c.nodes.decideReview(req.params.id, d, req.body?.note);
  }));
  r.post('/api/reviews/:id/comments', 'hub', (req) => wrap(() => c.nodes.addComment(req.params.id, String(req.body?.text || ''))));

  // ------------------------------------------------------------ devices, grants, HIL
  r.post('/api/devices/:id/lock', 'hub', (req) => wrap(() => {
    if (!c.compute.device(req.params.id)) throw new Error('unknown device');
    const holder = req.body?.sessionId ?? null;
    if (holder && holder !== 'you' && !c.store.session(holder)) throw new Error('unknown session');
    // you can always reassign or release a lock from the hub
    return { lock: c.compute.setLock(req.params.id, holder, { force: true }) };
  }));
  r.post('/api/grants', 'hub', (req) => wrap(() => {
    const b = req.body || {};
    if (!c.store.session(b.sessionId)) throw new Error('unknown session');
    return c.compute.createGrant({ sessionId: b.sessionId, hostId: b.hostId, resources: String(b.resources || 'shell'), purpose: String(b.purpose || ''), quotaGB: b.quotaGB ?? null, status: 'active' });
  }));
  r.post('/api/grants/:id', 'hub', (req) => wrap(() => {
    const st = req.body?.status;
    if (st !== 'active' && st !== 'revoked') throw new HttpError(400, 'status must be active|revoked');
    return c.compute.setGrant(req.params.id, st);
  }));
  r.post('/api/hil/:planId/run', 'hub', (req) => wrap(() => c.hil.start(req.params.planId, 'you')));
  r.post('/api/hil/runs/:id/abort', 'hub', (req) => wrap(() => {
    c.hil.abort(req.params.id);
    return { ok: true };
  }));
  r.post('/api/hil/runs/:id/rerun-failed', 'hub', (req) => wrap(() => c.hil.rerunFailed(req.params.id)));

  // ------------------------------------------------------------ terminals
  r.del('/api/terminals/:id', 'hub', (req) => wrap(() => {
    c.nodes.remove(req.params.id);
    return { ok: true };
  }));
}

function wrapSync<T>(f: () => T): T {
  try {
    return f();
  } catch (e: any) {
    throw new HttpError(400, e.message);
  }
}
