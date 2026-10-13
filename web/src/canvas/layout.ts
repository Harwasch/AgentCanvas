// Canvas graph + auto layout. Every node has at most one parent; roots are projects (or bare
// checkouts with no project), the "Compute surfaces" cluster, and free canvas nodes.
//   Columns: one vertical tree per root, side by side.
//   Tree:    one horizontal tree per root (depth runs left → right), roots stacked top to bottom.
//   Cluster: one radial cluster per root, wrapped into rows.
import type { HubData } from '../store';
import type { AppNode, Branch, CNode as HubCNode, Checkout, LayoutEntry } from '../types';
import { computeColor, computeKey, isActive } from '../ui';

export type Kind =
  | 'checkout' | 'session' | 'app' | 'project' | 'branch' | 'cluster' | 'machine' | 'device' | 'hil' | 'agentref' | 'grant'
  | 'note' | 'todos' | 'htodo' | 'suggest' | 'review' | 'file' | 'terminal';
export interface Box { x: number; y: number; w: number; h: number }
export interface GNode { id: string; kind: Kind; ref: string; w: number; h: number; compute: string; parent: string | null; order: number }
export interface Edge { from: string; to: string; color: string; dash?: string; op?: number }
export interface Header { key: string; label: string; color: string; x: number; y: number; w: number; sub?: string }

export const SESSION_W = 340, SESSION_H = 150, SESSION_LH = 184, SESSION_XW = 720, SESSION_XH = 560;
export const CHECKOUT_W = 340;

export const checkoutH = (c: Checkout) => {
  const n = Math.min(c.apps?.length || 0, 4);
  return 174 + (n ? 20 + n * 30 : 0);
};
export const appSize = (n: AppNode) => ({ w: (n.manifest?.node?.width || 640) + 16, h: (n.manifest?.node?.height || 440) + 82 });

// Machines, devices, HIL plans and grants use their own ids on the canvas (so `?focus=<id>` works);
// a prefixed id is only used if that raw id is already taken by another node.
export const refNodeId = (id: string) => `ref:${id}`;
export const CLUSTER_ID = 'cluster';
export const machineKey = (id: string) => (id === 'claude-cloud' ? 'cloud:claude' : id === 'codex-cloud' ? 'cloud:codex' : id);

export type NodeSize = NonNullable<LayoutEntry['size']>;

export type GraphInput = Pick<HubData,
  'hosts' | 'checkouts' | 'sessions' | 'nodes' | 'projects' | 'branches' | 'machines' | 'devices' | 'cnodes' | 'todos' | 'grants' | 'hilPlans'> & {
  expanded: Record<string, boolean>;
  phone: boolean;
  /** User-resized node sizes (per collapsed / expanded state); ignored on phones. */
  sizes?: Record<string, NodeSize | undefined>;
  attention: Record<string, boolean>;
};

export interface Graph { nodes: GNode[]; edges: Edge[]; byId: Record<string, GNode>; kids: Record<string, string[]>; roots: string[] }

const tsOf = (t: string | number | null | undefined) => (t == null ? 0 : typeof t === 'number' ? t : Date.parse(t) || 0);

type Size = [number, number];
function fileSize(kind: string, ex: boolean): Size {
  switch (kind) {
    case 'model3d': return ex ? [720, 560] : [360, 320];
    case 'image': return ex ? [640, 500] : [300, 260];
    case 'code': return ex ? [720, 560] : [420, 260];
    case 'doc': return ex ? [720, 560] : [300, 170];
    case 'pdf': return ex ? [720, 720] : [300, 150];
    default: return ex ? [560, 420] : [300, 150];
  }
}
export function cnodeSize(c: HubCNode, ex: boolean): Size {
  switch (c.type) {
    case 'note': return ex ? [380, 300] : [250, 150];
    case 'todos': return ex ? [420, 580] : [340, 340];
    case 'htodo': return [250, 76];
    case 'suggest': return [270, 156];
    case 'review': return ex ? [640, 680] : [250, 190];
    case 'file': return fileSize(c.data?.kind, ex);
    case 'terminal': return ex ? [760, 480] : [480, 280];
    default: return [240, 120];
  }
}

/** Where the default-branch row of a project folds into: the project node itself. */
const isDefault = (b: Branch, g: GraphInput) => g.projects[b.projectId]?.defaultBranch === b.name;

export function buildGraph(g: GraphInput): Graph {
  const nodes: GNode[] = [];
  const edges: Edge[] = [];
  const byId: Record<string, GNode> = {};
  let order = 0;
  const ex = (id: string) => !!g.expanded[id] && !g.phone;
  const add = (n: Omit<GNode, 'order'>) => {
    const x = { ...n, order: order++ };
    const s = g.phone ? null : g.sizes?.[x.id]?.[ex(x.id) ? 'x' : 'c'];
    if (s && s[0] > 0 && s[1] > 0) { x.w = s[0]; x.h = s[1]; }
    nodes.push(x); byId[x.id] = x; return x;
  };
  const cidMaps: Record<string, Record<string, string>> = { m: {}, dev: {}, hil: {}, grant: {} };
  const cid = (prefix: 'm' | 'dev' | 'hil' | 'grant', raw: string) => (cidMaps[prefix][raw] ||= byId[raw] || Object.values(cidMaps).some((mm) => Object.values(mm).includes(raw)) ? `${prefix}:${raw}` : raw);
  const machineNodeId = (raw: string) => cidMaps.m[raw] || cid('m', raw);
  const deviceNodeId = (raw: string) => cidMaps.dev[raw] || cid('dev', raw);
  const hilNodeId = (raw: string) => cidMaps.hil[raw] || cid('hil', raw);
  const grantNodeId = (raw: string) => cidMaps.grant[raw] || cid('grant', raw);
  const hasMachine = (raw: string) => !!cidMaps.m[raw] && !!byId[cidMaps.m[raw]];
  const hasDevice = (raw: string) => !!cidMaps.dev[raw] && !!byId[cidMaps.dev[raw]];

  // ---- repos
  const projects = Object.values(g.projects).sort((a, b) => a.name.localeCompare(b.name));
  projects.forEach((p) => {
    const e = ex(p.id);
    const sz: Size = p.readme ? (e ? [620, 860] : [460, 560]) : (e ? [560, 420] : [460, 300]);
    add({ id: p.id, kind: 'project', ref: p.id, w: sz[0], h: sz[1], compute: '', parent: null });
  });
  const projOfCheckout = (coId: string | null | undefined) => {
    const co = coId ? g.checkouts[coId] : undefined;
    return co && g.projects[co.repo_id] ? co.repo_id : null;
  };
  Object.values(g.checkouts).sort((a, b) => a.repoName.localeCompare(b.repoName) || a.host_id.localeCompare(b.host_id)).forEach((c) => {
    if (g.projects[c.repo_id]) return; // shown inside its project / branch nodes
    add({ id: c.id, kind: 'checkout', ref: c.id, w: CHECKOUT_W, h: checkoutH(c), compute: c.host_id, parent: null });
  });

  // branches (default branch folds into its project)
  const brNodeOf: Record<string, string> = {}; // branch id → canvas node id (branch or project)
  const branches = Object.values(g.branches).filter((b) => g.projects[b.projectId]).sort((a, b) => a.name.localeCompare(b.name));
  branches.forEach((b) => { brNodeOf[b.id] = isDefault(b, g) ? b.projectId : b.id; });
  branches.forEach((b) => {
    if (isDefault(b, g)) return;
    const e = ex(b.id);
    add({ id: b.id, kind: 'branch', ref: b.id, w: e ? 560 : 380, h: e ? 560 : 206, compute: '', parent: null });
  });
  // every branch hangs directly off its project (its base is shown on the node itself)
  branches.forEach((b) => {
    const n = byId[b.id];
    if (!n) return;
    n.parent = b.projectId;
    edges.push({ from: b.projectId, to: b.id, color: '#4A4E56' });
  });

  // sessions
  const cloudBranchOf: Record<string, string> = {};
  branches.forEach((b) => { if (b.cloud?.sessionId) cloudBranchOf[b.cloud.sessionId] = b.id; });
  // the canvas assistant lives in the Ask Claude panel, not on the canvas
  const sessions = Object.values(g.sessions).filter((s) => s.meta?.role !== 'assistant').sort((a, b) => tsOf(a.created_at) - tsOf(b.created_at));
  sessions.forEach((s) => {
    const e = ex(s.id);
    const key = computeKey(s);
    const loud = s.status === 'waiting' || !!g.attention[s.id];
    let parent: string | null = null;
    const pid = projOfCheckout(s.checkout_id) || (cloudBranchOf[s.id] ? g.branches[cloudBranchOf[s.id]].projectId : null);
    if (pid) {
      const bid = `${pid}#${s.branch || g.checkouts[s.checkout_id || '']?.branch || ''}`;
      parent = brNodeOf[bid] || (cloudBranchOf[s.id] ? brNodeOf[cloudBranchOf[s.id]] : null) || pid;
    } else if (s.checkout_id && byId[s.checkout_id]) parent = s.checkout_id;
    add({ id: s.id, kind: 'session', ref: s.id, w: e ? SESSION_XW : SESSION_W, h: e ? SESSION_XH : loud ? SESSION_LH : SESSION_H, compute: key, parent });
    if (parent) {
      const far = s.kind === 'cloud';
      edges.push({ from: parent, to: s.id, color: computeColor(key, g.hosts), op: far ? 0.35 : 0.7, dash: far ? '6 6' : undefined });
    }
  });

  // app nodes
  Object.values(g.nodes).forEach((n) => {
    const sz = appSize(n);
    let parent: string | null = null;
    if (n.sessionId && g.sessions[n.sessionId]) parent = n.sessionId;
    else {
      const co = Object.values(g.checkouts).find((c) => c.host_id === n.hostId && c.apps?.some((a) => a.dir === n.dir));
      if (co) {
        const pid = projOfCheckout(co.id);
        parent = pid ? (brNodeOf[`${pid}#${co.branch}`] || pid) : co.id;
      }
    }
    add({ id: n.id, kind: 'app', ref: n.id, w: sz.w, h: sz.h, compute: n.hostId, parent });
    if (parent) edges.push({ from: parent, to: n.id, color: '#3A3E46', dash: g.sessions[parent] ? undefined : '4 4' });
  });

  // ---- compute surfaces
  const machines = Object.values(g.machines).sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'host' ? -1 : 1));
  if (machines.length || Object.keys(g.devices).length) {
    add({ id: CLUSTER_ID, kind: 'cluster', ref: CLUSTER_ID, w: 270, h: 108, compute: '', parent: null });
  }
  machines.forEach((m) => {
    const id = machineNodeId(m.id);
    const e = ex(id);
    add({ id, kind: 'machine', ref: m.id, w: e ? 440 : 280, h: e ? 380 : 152, compute: machineKey(m.id), parent: CLUSTER_ID });
    edges.push({ from: CLUSTER_ID, to: id, color: m.color || '#3A3E46', op: 0.5 });
  });
  const devices = Object.values(g.devices).sort((a, b) => a.title.localeCompare(b.title));
  devices.forEach((d) => {
    const id = deviceNodeId(d.id);
    add({ id, kind: 'device', ref: d.id, w: 270, h: 136, compute: d.hostId, parent: null });
  });
  devices.forEach((d) => {
    const id = deviceNodeId(d.id);
    let parent: string | null = d.parentId && d.parentId !== d.id && hasDevice(d.parentId) ? deviceNodeId(d.parentId) : null;
    if (!parent && hasMachine(d.hostId)) parent = machineNodeId(d.hostId);
    byId[id].parent = parent;
    if (parent) edges.push({ from: parent, to: id, color: computeColor(d.hostId, g.hosts), op: 0.55 });
  });
  Object.values(g.hilPlans).forEach((p) => {
    const id = hilNodeId(p.id);
    const devs = p.devices.filter((x) => hasDevice(x));
    // under the deepest device of the plan's setup (the DUT end of the chain)
    const depth = (nid: string) => { let d = 0, cur: string | null = nid; while (cur && d < 50) { cur = byId[cur]?.parent || null; d++; } return d; };
    const best = devs.map(deviceNodeId).sort((a, b) => depth(b) - depth(a))[0];
    const parent = best || (hasMachine(p.hostId) ? machineNodeId(p.hostId) : null);
    add({ id, kind: 'hil', ref: p.id, w: 620, h: 600, compute: p.hostId, parent });
    if (parent) edges.push({ from: parent, to: id, color: '#3A3E46' });
  });
  // agent reference chips: active local sessions under their host's machine
  sessions.forEach((s) => {
    if (s.kind !== 'local' || !s.host_id || !isActive(s) || !hasMachine(s.host_id)) return;
    const id = refNodeId(s.id);
    add({ id, kind: 'agentref', ref: s.id, w: 250, h: 40, compute: s.host_id, parent: machineNodeId(s.host_id) });
    edges.push({ from: machineNodeId(s.host_id), to: id, color: computeColor(s.host_id, g.hosts), dash: '4 5', op: 0.6 });
  });

  // ---- grants (under their session)
  Object.values(g.grants).forEach((gr) => {
    if (gr.status === 'revoked' && !g.sessions[gr.sessionId]) return;
    const id = grantNodeId(gr.id);
    const parent = g.sessions[gr.sessionId] ? gr.sessionId : null;
    add({ id, kind: 'grant', ref: gr.id, w: 260, h: 128, compute: gr.hostId, parent });
    if (parent) edges.push({ from: parent, to: id, color: computeColor(gr.hostId, g.hosts), dash: '4 4', op: 0.7 });
  });

  // ---- canvas nodes
  const cnodes = Object.values(g.cnodes).sort((a, b) => tsOf(a.createdAt) - tsOf(b.createdAt));
  cnodes.forEach((c) => {
    if (c.type === 'suggest' && c.data?.status === 'dismissed') return;
    if (c.type === 'htodo' && !g.todos[c.data?.todoId]) return;
    const sz = cnodeSize(c, ex(c.id));
    let compute = '';
    if (c.type === 'terminal') compute = c.data?.hostId || '';
    add({ id: c.id, kind: c.type, ref: c.id, w: sz[0], h: sz[1], compute, parent: null });
  });
  cnodes.forEach((c) => {
    const n = byId[c.id];
    if (!n) return;
    let parent: string | null = null;
    const pick = (id: string | null | undefined) => {
      if (!id || parent) return;
      if (g.branches[id] && brNodeOf[id]) parent = brNodeOf[id];
      else if (hasMachine(id)) parent = machineNodeId(id);
      else if (byId[id] && id !== c.id) parent = id;
    };
    pick(c.parentId);
    if (c.type === 'review' || c.type === 'htodo' || c.type === 'suggest' || c.type === 'terminal') pick(c.data?.sessionId);
    if (c.type === 'suggest') pick(c.data?.branchId);
    if (c.type === 'terminal' && c.data?.hostId) pick(c.data.hostId);
    // guard against cycles between canvas nodes
    let cur: string | null = parent, hops = 0;
    while (cur && hops++ < 60) { if (cur === c.id) { parent = null; break; } cur = byId[cur]?.parent || null; }
    n.parent = parent;
    if (parent) {
      const pk = byId[parent].kind;
      const color = pk === 'session' ? computeColor(byId[parent].compute, g.hosts) : '#3A3E46';
      edges.push({ from: parent, to: c.id, color, dash: c.type === 'suggest' || c.type === 'htodo' ? '4 4' : undefined, op: pk === 'session' ? 0.55 : 1 });
    }
  });

  // children lists in insertion order; roots: projects, bare checkouts, cluster, then free nodes
  const kids: Record<string, string[]> = {};
  nodes.forEach((n) => { if (n.parent && byId[n.parent]) (kids[n.parent] ||= []).push(n.id); else n.parent = null; });
  const rank: Record<string, number> = { branch: 0, session: 1, app: 2, review: 3, suggest: 4, htodo: 5, grant: 6, terminal: 7, todos: 8, file: 9, note: 10, device: 11, hil: 12, agentref: 13 };
  Object.values(kids).forEach((list) => list.sort((a, b) => (rank[byId[a].kind] ?? 20) - (rank[byId[b].kind] ?? 20) || byId[a].order - byId[b].order));
  const roots = nodes.filter((n) => !n.parent).map((n) => n.id);
  return { nodes, edges, byId, kids, roots };
}

// ------------------------------------------------------------------ layouts
interface L { pos: Record<string, Box>; W: number; H: number }

function norm(pos: Record<string, Box>): L {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  Object.values(pos).forEach((p) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h); });
  if (!Number.isFinite(x0)) return { pos: {}, W: 0, H: 0 };
  const out: Record<string, Box> = {};
  Object.keys(pos).forEach((k) => { const p = pos[k]; out[k] = { x: p.x - x0, y: p.y - y0, w: p.w, h: p.h }; });
  return { pos: out, W: x1 - x0, H: y1 - y0 };
}

/** Vertical tree: each depth is a lane; parents centered over their children. */
function treeRoot(rootId: string, G: Graph): L {
  const maxD: number[] = [];
  const walk = (id: string, d: number) => { maxD[d] = Math.max(maxD[d] || 0, G.byId[id].h); (G.kids[id] || []).forEach((c) => walk(c, d + 1)); };
  walk(rootId, 0);
  const lane = [0];
  for (let d = 1; d < maxD.length; d++) lane[d] = lane[d - 1] + maxD[d - 1] + 80;
  const pos: Record<string, Box> = {};
  const GAP = 36;
  const place = (id: string, d: number, o: number): number => {
    const n = G.byId[id];
    const ks = G.kids[id] || [];
    if (!ks.length) { pos[id] = { x: o, y: lane[d], w: n.w, h: n.h }; return o + n.w + GAP; }
    let c = o;
    ks.forEach((k) => { c = place(k, d + 1, c); });
    const f = pos[ks[0]], l = pos[ks[ks.length - 1]];
    const px = Math.max(o, (f.x + l.x + l.w) / 2 - n.w / 2);
    pos[id] = { x: px, y: lane[d], w: n.w, h: n.h };
    return Math.max(c, px + n.w + GAP);
  };
  place(rootId, 0, 0);
  return norm(pos);
}

/** Horizontal tree: each depth is a column; parents centered beside their children. */
function treeRootH(rootId: string, G: Graph): L {
  const maxW: number[] = [];
  const walk = (id: string, d: number) => { maxW[d] = Math.max(maxW[d] || 0, G.byId[id].w); (G.kids[id] || []).forEach((c) => walk(c, d + 1)); };
  walk(rootId, 0);
  const lane = [0];
  for (let d = 1; d < maxW.length; d++) lane[d] = lane[d - 1] + maxW[d - 1] + 110;
  const pos: Record<string, Box> = {};
  const GAP = 44; // room for chips that sit above a node (file pins)
  const place = (id: string, d: number, o: number): number => {
    const n = G.byId[id];
    const ks = G.kids[id] || [];
    if (!ks.length) { pos[id] = { x: lane[d], y: o, w: n.w, h: n.h }; return o + n.h + GAP; }
    let c = o;
    ks.forEach((k) => { c = place(k, d + 1, c); });
    const f = pos[ks[0]], l = pos[ks[ks.length - 1]];
    const py = Math.max(o, (f.y + l.y + l.h) / 2 - n.h / 2);
    pos[id] = { x: lane[d], y: py, w: n.w, h: n.h };
    return Math.max(c, py + n.h + GAP);
  };
  place(rootId, 0, 0);
  return norm(pos);
}

/** Dense radial cluster (ported from the design): rings sized to what their nodes need. */
function clusterRoot(rootId: string, G: Graph): L {
  const sz = (id: string) => [G.byId[id].w, G.byId[id].h];
  const tang = (id: string, th: number) => { const s = sz(id); return Math.abs(s[0] * Math.sin(th)) + Math.abs(s[1] * Math.cos(th)); };
  const radial = (id: string, th: number) => { const s = sz(id); return (Math.abs(s[0] * Math.cos(th)) + Math.abs(s[1] * Math.sin(th))) / 2; };
  const W: Record<string, number> = {};
  const wgt = (id: string): number => { const ks = G.kids[id] || []; W[id] = ks.length ? ks.reduce((a, k) => a + wgt(k), 0) : 1; return W[id]; };
  wgt(rootId);
  const ang: Record<string, number> = { [rootId]: 0 }, rad: Record<string, number> = { [rootId]: 0 };
  let prev = [rootId], prevR = 0, prevExt = Math.hypot(...sz(rootId)) / 2;
  const GAP = 28;
  for (let guard = 0; guard < 40; guard++) {
    const ring: { id: string; p: string; t: number }[] = [];
    prev.forEach((p) => (G.kids[p] || []).forEach((k) => ring.push({ id: k, p, t: 0 })));
    if (!ring.length) break;
    if (prev.length === 1 && prev[0] === rootId) {
      let a = -Math.PI / 2;
      const tot = W[rootId];
      ring.forEach((r) => { const span = (2 * Math.PI * W[r.id]) / tot; r.t = a + span / 2; a += span; });
    } else {
      const groups: Record<string, typeof ring> = {};
      ring.forEach((r) => { (groups[r.p] ||= []).push(r); });
      Object.keys(groups).forEach((p) => {
        const gr = groups[p];
        let off = -(gr.length - 1) / 2;
        gr.forEach((r) => { r.t = ang[p] + off * 0.22 * Math.min(1, 6 / gr.length); off += 1; });
      });
    }
    const ext = Math.max(...ring.map((r) => radial(r.id, r.t)));
    const need = ring.reduce((a, r) => a + tang(r.id, r.t) + GAP, 0) / (2 * Math.PI);
    let R = Math.max(prevR + prevExt + ext + 44, need);
    ring.sort((a, b) => a.t - b.t);
    let out = ring.map((r) => r.t);
    for (let it = 0; it < 40; it++) {
      const minSep = (a: typeof ring[0], b: typeof ring[0]) => ((Math.max(tang(a.id, a.t), tang(a.id, a.t + 0.3)) + Math.max(tang(b.id, b.t), tang(b.id, b.t + 0.3))) / 2 + GAP) / R;
      out = ring.map((r) => r.t);
      for (let i = 1; i < ring.length; i++) out[i] = Math.max(out[i], out[i - 1] + minSep(ring[i - 1], ring[i]));
      const n = ring.length;
      if (n < 2 || out[n - 1] - out[0] + minSep(ring[n - 1], ring[0]) <= 2 * Math.PI) break;
      R *= 1.08;
    }
    const shift = ring.reduce((a, r, i) => a + (r.t - out[i]), 0) / ring.length;
    ring.forEach((r, i) => { ang[r.id] = out[i] + shift; rad[r.id] = R; });
    prev = ring.map((r) => r.id); prevR = R; prevExt = ext;
  }
  const pos: Record<string, Box> = {};
  Object.keys(ang).forEach((id) => {
    const s = sz(id);
    pos[id] = { x: rad[id] * Math.cos(ang[id]) - s[0] / 2, y: rad[id] * Math.sin(ang[id]) - s[1] / 2, w: s[0], h: s[1] };
  });
  return norm(pos);
}

/** Free nodes (no parent): a grid of up to 3 columns. */
function freeGrid(ids: string[], G: Graph): L {
  const pos: Record<string, Box> = {};
  const COLS = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(ids.length))));
  const colX: number[] = [];
  const colY: number[] = new Array(COLS).fill(0);
  let x = 0;
  for (let c = 0; c < COLS; c++) {
    colX[c] = x;
    const w = Math.max(0, ...ids.filter((_, i) => i % COLS === c).map((id) => G.byId[id].w));
    x += w + 40;
  }
  ids.forEach((id, i) => {
    const c = i % COLS, n = G.byId[id];
    pos[id] = { x: colX[c], y: colY[c], w: n.w, h: n.h };
    colY[c] += n.h + 56;
  });
  return norm(pos);
}

export interface LayoutResult { pos: Record<string, Box>; headers: Header[] }

export type AutoMode = 'cluster' | 'columns' | 'tree';

export function autoLayout(mode: AutoMode, G: Graph): LayoutResult {
  const pos: Record<string, Box> = {};
  const headers: Header[] = [];
  const put = (l: L, ox: number, oy: number) => Object.keys(l.pos).forEach((k) => { const p = l.pos[k]; pos[k] = { x: p.x + ox, y: p.y + oy, w: p.w, h: p.h }; });
  const treeRoots = G.roots.filter((id) => ['project', 'checkout', 'cluster'].includes(G.byId[id].kind) || (G.kids[id] || []).length);
  const free = G.roots.filter((id) => !treeRoots.includes(id));
  // projects first, then bare checkouts, other trees, compute cluster last
  const rk = (id: string) => ({ project: 0, checkout: 1, cluster: 3 } as Record<string, number>)[G.byId[id].kind] ?? 2;
  treeRoots.sort((a, b) => rk(a) - rk(b) || G.byId[a].order - G.byId[b].order);

  if (mode === 'columns') {
    let x = 0;
    treeRoots.forEach((r) => { const l = treeRoot(r, G); put(l, x, 0); x += l.W + 160; });
    if (free.length) {
      const l = freeGrid(free, G);
      put(l, x, 0);
      headers.push({ key: 'free', label: 'Free nodes', color: '#8A8F98', x, y: -46, w: l.W, sub: `${free.length}` });
    }
    return { pos, headers };
  }
  if (mode === 'tree') {
    let y = 0;
    treeRoots.forEach((r) => { const l = treeRootH(r, G); put(l, 0, y); y += l.H + 140; });
    if (free.length) {
      const l = freeGrid(free, G);
      put(l, 0, y + 46);
      headers.push({ key: 'free', label: 'Free nodes', color: '#8A8F98', x: 0, y, w: l.W, sub: `${free.length}` });
    }
    return { pos, headers };
  }
  const Ls = treeRoots.map((r) => clusterRoot(r, G));
  if (free.length) Ls.push(freeGrid(free, G));
  const maxRow = Math.max(4400, ...Ls.map((l) => l.W));
  let x = 0, y = 0, rowH = 0;
  Ls.forEach((l, i) => {
    if (x > 0 && x + l.W > maxRow) { x = 0; y += rowH + 160; rowH = 0; }
    put(l, x, y);
    if (free.length && i === Ls.length - 1) headers.push({ key: 'free', label: 'Free nodes', color: '#8A8F98', x, y: y - 46, w: l.W, sub: `${free.length}` });
    x += l.W + 160; rowH = Math.max(rowH, l.H);
  });
  return { pos, headers };
}

export function applySaved(pos: Record<string, Box>, G: Graph, saved: Record<string, LayoutEntry>) {
  const out: Record<string, Box> = { ...pos };
  Object.keys(saved).forEach((id) => {
    const n = G.byId[id];
    const s = saved[id];
    if (n && s && Number.isFinite(s.x) && Number.isFinite(s.y)) out[id] = { x: s.x, y: s.y, w: n.w, h: n.h };
  });
  return out;
}

export function bbox(pos: Record<string, Box>, ids?: string[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  (ids || Object.keys(pos)).forEach((id) => {
    const p = pos[id];
    if (!p) return;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h);
  });
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 100, h: 100 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Center-to-center segment clipped at both box borders. */
export function clipSeg(a: Box, b: Box) {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const dx = bx - ax, dy = by - ay;
  if (!dx && !dy) return null;
  const clip = (p: Box) => Math.min(dx ? p.w / 2 / Math.abs(dx) : 1e9, dy ? p.h / 2 / Math.abs(dy) : 1e9);
  const t1 = clip(a), t2 = clip(b);
  if (t1 + t2 >= 1) return null;
  return { x1: ax + dx * t1, y1: ay + dy * t1, x2: bx - dx * t2, y2: by - dy * t2 };
}

