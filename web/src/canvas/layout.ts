// Auto layout for the canvas: per-compute columns or per-repo clusters.
import type { AppNode, Checkout, Host, LayoutEntry, Session } from '../types';
import { CLOUD_NAMES, computeColor, computeKey, computeName } from '../ui';

export type Kind = 'checkout' | 'session' | 'app';
export interface Box { x: number; y: number; w: number; h: number }
export interface CNode { id: string; kind: Kind; w: number; h: number; compute: string }
export interface Edge { from: string; to: string; color: string; dash?: string; op?: number }
export interface Header { key: string; label: string; color: string; x: number; y: number; w: number; sub?: string }

export const SESSION_W = 340, SESSION_H = 150, SESSION_LH = 184, SESSION_XW = 720, SESSION_XH = 560;
export const CHECKOUT_W = 340;
const GAP_Y = 36, GAP_X = 96, APP_GAP = 48;

export const checkoutH = (c: Checkout) => {
  const n = Math.min(c.apps?.length || 0, 4);
  return 174 + (n ? 20 + n * 30 : 0);
};
export const appSize = (n: AppNode) => ({ w: (n.manifest?.node?.width || 640) + 16, h: (n.manifest?.node?.height || 440) + 82 });

export interface GraphInput {
  hosts: Record<string, Host>;
  checkouts: Record<string, Checkout>;
  sessions: Record<string, Session>;
  nodes: Record<string, AppNode>;
  expanded: Record<string, boolean>;
  phone: boolean;
  attention: Record<string, boolean>;
}

export interface Graph { nodes: CNode[]; edges: Edge[]; byId: Record<string, CNode> }

const tsOf = (t: string | number) => (typeof t === 'number' ? t : Date.parse(t) || 0);

export function buildGraph(g: GraphInput): Graph {
  const nodes: CNode[] = [];
  const edges: Edge[] = [];
  Object.values(g.checkouts).forEach((c) => nodes.push({ id: c.id, kind: 'checkout', w: CHECKOUT_W, h: checkoutH(c), compute: c.host_id }));
  Object.values(g.sessions).forEach((s) => {
    const ex = !!g.expanded[s.id] && !g.phone;
    const key = computeKey(s);
    const loud = s.status === 'waiting' || !!g.attention[s.id];
    nodes.push({ id: s.id, kind: 'session', w: ex ? SESSION_XW : SESSION_W, h: ex ? SESSION_XH : loud ? SESSION_LH : SESSION_H, compute: key });
    if (s.checkout_id && g.checkouts[s.checkout_id]) {
      const far = s.kind === 'cloud' || g.checkouts[s.checkout_id].host_id !== s.host_id;
      edges.push({ from: s.checkout_id, to: s.id, color: computeColor(key, g.hosts), op: far ? 0.35 : 0.7, dash: far ? '6 6' : undefined });
    }
  });
  Object.values(g.nodes).forEach((n) => {
    const sz = appSize(n);
    nodes.push({ id: n.id, kind: 'app', w: sz.w, h: sz.h, compute: n.hostId });
    if (n.sessionId && g.sessions[n.sessionId]) edges.push({ from: n.sessionId, to: n.id, color: '#3A3E46' });
    else {
      const co = Object.values(g.checkouts).find((c) => c.host_id === n.hostId && c.apps?.some((a) => a.dir === n.dir));
      if (co) edges.push({ from: co.id, to: n.id, color: '#3A3E46', dash: '4 4' });
    }
  });
  const byId: Record<string, CNode> = {};
  nodes.forEach((n) => { byId[n.id] = n; });
  return { nodes, edges, byId };
}

function sortSessions(list: Session[], checkoutOrder: string[]) {
  return list.slice().sort((a, b) => {
    const ca = checkoutOrder.indexOf(a.checkout_id || ''), cb = checkoutOrder.indexOf(b.checkout_id || '');
    if (ca !== cb) return ca - cb;
    return tsOf(a.created_at) - tsOf(b.created_at);
  });
}

/** Place a session and its apps (to the right) at x,y. Returns row size. */
function placeRow(s: Session, x: number, y: number, G: Graph, apps: AppNode[], pos: Record<string, Box>) {
  const sn = G.byId[s.id];
  pos[s.id] = { x, y, w: sn.w, h: sn.h };
  let ay = y, aw = 0;
  apps.forEach((a) => {
    const an = G.byId[a.id];
    pos[a.id] = { x: x + sn.w + APP_GAP, y: ay, w: an.w, h: an.h };
    ay += an.h + GAP_Y;
    aw = Math.max(aw, an.w);
  });
  return { w: sn.w + (apps.length ? APP_GAP + aw : 0), h: Math.max(sn.h, apps.length ? ay - y - GAP_Y : 0) };
}

export interface LayoutResult { pos: Record<string, Box>; headers: Header[] }

export function autoLayout(mode: 'cluster' | 'columns', g: GraphInput, G: Graph): LayoutResult {
  const pos: Record<string, Box> = {};
  const headers: Header[] = [];
  const checkouts = Object.values(g.checkouts).sort((a, b) => a.repoName.localeCompare(b.repoName) || a.host_id.localeCompare(b.host_id));
  const coOrder = checkouts.map((c) => c.id);
  const sessions = Object.values(g.sessions);
  const appsBySession: Record<string, AppNode[]> = {};
  const orphanApps: AppNode[] = [];
  Object.values(g.nodes).forEach((n) => {
    if (n.sessionId && g.sessions[n.sessionId]) (appsBySession[n.sessionId] ||= []).push(n);
    else orphanApps.push(n);
  });

  if (mode === 'columns') {
    const hostKeys = Object.values(g.hosts).sort((a, b) => a.label.localeCompare(b.label)).map((h) => h.id);
    const extraHostKeys = Array.from(new Set(sessions.filter((s) => s.kind !== 'cloud' && s.host_id && !g.hosts[s.host_id]).map((s) => s.host_id as string)));
    const keys = [...hostKeys, ...extraHostKeys, ...Object.keys(CLOUD_NAMES).filter((k) => sessions.some((s) => computeKey(s) === k))];
    let x = 0;
    keys.forEach((key) => {
      let y = 0, colW = SESSION_W;
      const cos = checkouts.filter((c) => !key.startsWith('cloud:') && c.host_id === key);
      cos.forEach((c) => {
        const n = G.byId[c.id];
        pos[c.id] = { x, y, w: n.w, h: n.h };
        // apps of this checkout without a session sit to its right
        let ay = y;
        orphanApps.filter((a) => a.hostId === c.host_id && c.apps?.some((p) => p.dir === a.dir) && !pos[a.id]).forEach((a) => {
          const an = G.byId[a.id];
          pos[a.id] = { x: x + n.w + APP_GAP, y: ay, w: an.w, h: an.h };
          ay += an.h + GAP_Y;
          colW = Math.max(colW, n.w + APP_GAP + an.w);
        });
        y = Math.max(y + n.h, ay - GAP_Y) + GAP_Y;
      });
      if (cos.length) y += 28;
      sortSessions(sessions.filter((s) => computeKey(s) === key), coOrder).forEach((s) => {
        const r = placeRow(s, x, y, G, appsBySession[s.id] || [], pos);
        colW = Math.max(colW, r.w);
        y += r.h + GAP_Y;
      });
      orphanApps.filter((a) => !pos[a.id] && a.hostId === key).forEach((a) => {
        const an = G.byId[a.id];
        pos[a.id] = { x, y, w: an.w, h: an.h };
        y += an.h + GAP_Y;
        colW = Math.max(colW, an.w);
      });
      const host = g.hosts[key];
      headers.push({ key, label: computeName(key, g.hosts), color: computeColor(key, g.hosts), x, y: -46, w: colW, sub: host ? host.status : 'managed' });
      x += colW + GAP_X;
    });
    // anything left (apps on unknown hosts)
    let y = 0;
    G.nodes.forEach((n) => { if (!pos[n.id]) { pos[n.id] = { x, y, w: n.w, h: n.h }; y += n.h + GAP_Y; } });
    return { pos, headers };
  }

  // cluster: one cluster per checkout; sessions in 2 columns under it.
  let x = 0;
  const groups: { co: Checkout | null; sess: Session[] }[] = checkouts.map((c) => ({ co: c, sess: [] as Session[] }));
  const loose: Session[] = [];
  sessions.forEach((s) => {
    const gi = groups.find((gr) => gr.co && gr.co.id === s.checkout_id);
    if (gi) gi.sess.push(s); else loose.push(s);
  });
  if (loose.length) groups.push({ co: null, sess: loose });
  groups.forEach((gr) => {
    const sess = sortSessions(gr.sess, coOrder);
    const rows: { w: number; h: number }[] = [];
    // measure rows via a scratch placement
    const scratch: Record<string, Box> = {};
    sess.forEach((s) => rows.push(placeRow(s, 0, 0, G, appsBySession[s.id] || [], scratch)));
    const slotW = Math.max(SESSION_W, ...rows.map((r) => r.w));
    const cols = sess.length > 1 ? 2 : 1;
    const clusterW = Math.max(CHECKOUT_W, cols * slotW + (cols - 1) * 48);
    let y = 0;
    if (gr.co) {
      const n = G.byId[gr.co.id];
      pos[gr.co.id] = { x: x + (clusterW - n.w) / 2, y, w: n.w, h: n.h };
      let ay = y;
      orphanApps.filter((a) => gr.co && a.hostId === gr.co.host_id && gr.co.apps?.some((p) => p.dir === a.dir) && !pos[a.id]).forEach((a) => {
        const an = G.byId[a.id];
        pos[a.id] = { x: x + (clusterW + n.w) / 2 + APP_GAP, y: ay, w: an.w, h: an.h };
        ay += an.h + GAP_Y;
      });
      y += n.h + 90;
    }
    for (let i = 0; i < sess.length; i += cols) {
      let rowH = 0;
      for (let c = 0; c < cols && i + c < sess.length; c++) {
        const r = placeRow(sess[i + c], x + c * (slotW + 48), y, G, appsBySession[sess[i + c].id] || [], pos);
        rowH = Math.max(rowH, r.h);
      }
      y += rowH + GAP_Y + 10;
    }
    headers.push({ key: gr.co ? gr.co.id : 'loose', label: gr.co ? gr.co.repoName : 'No checkout', color: gr.co ? computeColor(gr.co.host_id, g.hosts) : '#8A8F98', x, y: -46, w: clusterW, sub: gr.co ? computeName(gr.co.host_id, g.hosts) : '' });
    x += clusterW + 160;
  });
  let y = 0;
  G.nodes.forEach((n) => { if (!pos[n.id]) { pos[n.id] = { x, y, w: n.w, h: n.h }; y += n.h + GAP_Y; } });
  return { pos, headers };
}

export function applySaved(pos: Record<string, Box>, G: Graph, saved: Record<string, LayoutEntry>) {
  const out: Record<string, Box> = { ...pos };
  Object.keys(saved).forEach((id) => {
    const n = G.byId[id];
    const s = saved[id];
    if (n && Number.isFinite(s.x) && Number.isFinite(s.y)) out[id] = { x: s.x, y: s.y, w: n.w, h: n.h };
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
