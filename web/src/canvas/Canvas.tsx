// Infinite canvas: pan / zoom / pinch, draggable + resizable nodes, marquee selection, auto layout, edges.
//   Mouse: left-drag on empty canvas selects (shift adds), right- or middle-drag pans, right-click opens the add menu.
//   Nodes: drag moves the node (or the whole selection); shift-drag also moves every descendant.
//   Touch: one finger pans or drags a node, two fingers pinch.
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { ViewportCtx, useInView } from '../nodes/common';
import { NodeView } from '../nodes/NodeView';
import { hub, setExpanded, setLayoutMode, toast, ui, useHub, useUI, type HubData } from '../store';
import { CLOUD_NAMES, Icon, computeColor, computeKey, isActive, useIsPhone } from '../ui';
import { applySaved, autoLayout, bbox, buildGraph, clipSeg, graphKey, type Box, type GNode, type Graph, type Kind, type NodeSize } from './layout';
import { LIVE_ZOOM, centerOn, clampZ, fitBox, useView, view, zoomAt } from './view';

const GRID = 22;
/** the grid layer overhangs the viewport by this much on each side (≥ the largest grid step, 22 × 2.5) */
const GRID_PAD = 60;
const CLIENT_ID = Math.random().toString(36).slice(2, 10);

function nodeText(n: GNode): string {
  const h = hub.get();
  const id = n.ref;
  switch (n.kind) {
    case 'session': { const s = h.sessions[id]; return s ? [s.title, s.branch, s.vendor, s.kind, h.hosts[s.host_id || '']?.label, h.accounts[s.account_id]?.label, s.status, s.kind === 'cloud' ? CLOUD_NAMES[computeKey(s)] : ''].join(' ') : ''; }
    case 'checkout': { const c = h.checkouts[id]; return c ? [c.repoName, c.branch, c.path, h.hosts[c.host_id]?.label, c.head_subject].join(' ') : ''; }
    case 'app': { const a = h.nodes[id]; return a ? [a.title, a.appId, a.dir, h.hosts[a.hostId]?.label].join(' ') : ''; }
    case 'project': { const p = h.projects[id]; return p ? [p.name, p.gh?.owner, p.gh?.account, p.defaultBranch, 'project repo'].join(' ') : ''; }
    case 'branch': { const b = h.branches[id]; return b ? [b.name, b.goal, b.base, b.pr ? `#${b.pr.number} ${b.pr.title}` : '', 'branch'].join(' ') : ''; }
    case 'machine': { const m = h.machines[id]; return m ? [m.label, m.kind, 'machine compute', m.gpu.map((g) => g.name).join(' ')].join(' ') : ''; }
    case 'device': { const d = h.devices[id]; return d ? [d.title, d.kind, d.port, d.icon, h.hosts[d.hostId]?.label, 'device'].join(' ') : ''; }
    case 'hil': { const p = h.hilPlans[id]; return p ? [p.title, p.plan, 'hil test', h.hosts[p.hostId]?.label].join(' ') : ''; }
    case 'grant': { const g = h.grants[id]; return g ? [g.resources, g.purpose, 'grant compute access'].join(' ') : ''; }
    case 'agentref': { const s = h.sessions[id]; return s ? s.title : ''; }
    case 'cluster': return 'compute surfaces cluster';
    default: {
      const c = h.cnodes[id];
      if (!c) return '';
      const d = c.data || {};
      const todo = c.type === 'htodo' ? h.todos[d.todoId]?.text : '';
      return [c.type, d.title, d.text, d.path, d.prompt, d.rationale, todo].filter(Boolean).join(' ');
    }
  }
}

type NodeActs = {
  down: (e: React.PointerEvent, id: string) => void;
  ctx: (e: React.MouseEvent, id: string, kind: string) => void;
  rzDown: (e: React.PointerEvent, id: string) => void;
  rzReset: (id: string) => void;
  reg: (id: string, el: HTMLDivElement | null) => void;
};

/** '' | 'loud' | 'run <color>': a session node's attention ring, read per node so other nodes never re-render for it */
function sessionLook(h: HubData, kind: string, ref: string): string {
  if (kind !== 'session') return '';
  const s = h.sessions[ref];
  if (!s) return '';
  if (s.status === 'waiting') return 'loud';
  for (const a of Object.values(h.approvals)) if (a.status === 'pending' && a.session_id === ref) return 'loud';
  return s.status === 'running' ? `run ${computeColor(computeKey(s), h.hosts)}` : '';
}

/** The running session's halo and sweeping ring; both stop while the node is off-screen (and below the live zoom, in CSS). */
function RunRing({ color }: { color: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, useContext(ViewportCtx));
  const still = inView ? '' : ' still';
  return (
    <>
      <span aria-hidden="true" className={`halo${still}`} style={{ color }} />
      <span ref={ref} aria-hidden="true" className={`ring${still}`} style={{ color }}><i /></span>
    </>
  );
}

/**
 * One node on the canvas. Memoized on primitive props: a drag tick, a pan or an unrelated hub event renders none of
 * these. Selection, glow and a session's ring are read here, per node. While a node is dragged or resized the canvas
 * moves its element directly (a held animation / inline size, through refs) and commits the new box once on pointerup.
 */
const NodeWrap = memo(function NodeWrap({ id, kind, refId, x, y, w, h, op, ex, phone, acts }: {
  id: string; kind: Kind; refId: string; x: number; y: number; w: number; h: number; op: number; ex: boolean; phone: boolean; acts: NodeActs;
}) {
  const sel = useUI((u) => !!u.selected[id]);
  const lit = useUI((u) => !!u.glow[id]);
  const look = useHub((hd) => sessionLook(hd, kind, refId));
  const reg = useCallback((el: HTMLDivElement | null) => acts.reg(id, el), [acts, id]);
  const loud = look === 'loud';
  const color = look.startsWith('run ') ? look.slice(4) : '';
  return (
    <div
      ref={reg}
      className={`node${sel ? ' selected' : ''}${lit ? ' glow' : ''}`}
      data-node={kind}
      data-node-key={id}
      data-selected={sel ? '1' : undefined}
      style={{ left: x, top: y, width: w, height: h, opacity: op, zIndex: ex ? 20 : sel ? 8 : loud ? 5 : 1 }}
      onPointerDown={(e) => acts.down(e, id)}
      onContextMenu={(e) => acts.ctx(e, id, kind)}
    >
      {color ? <RunRing color={color} /> : null}
      {loud ? <span aria-hidden="true" className="loud" /> : null}
      <NodeView kind={kind} id={id} refId={refId} mode={ex ? 'expanded' : 'collapsed'} />
      {!phone ? (
        <div className="rz" data-testid="resize-handle" title="Drag to resize · double-click to reset" onPointerDown={(e) => acts.rzDown(e, id)} onDoubleClick={(e) => { e.stopPropagation(); acts.rzReset(id); }}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M9 1L1 9M9 5L5 9" stroke="#8A8F98" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </div>
      ) : null}
    </div>
  );
});

/** Edge geometry: a curved link in the left → right tree, else a straight segment clipped to both boxes. */
function edgeGeom(a: Box, b: Box, tree: boolean): { d: string } | { x1: number; y1: number; x2: number; y2: number } | null {
  if (tree && b.x > a.x + a.w + 20) {
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, mx = (x1 + x2) / 2;
    return { d: `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}` };
  }
  return clipSeg(a, b);
}

/** pending approvals → session ids, as a stable string (the graph only needs who is waiting) */
const attentionKeyOf = (h: HubData) => Object.values(h.approvals).filter((a) => a.status === 'pending').map((a) => a.session_id).sort().join(',');

export function Canvas() {
  // the graph depends on a structural key, not on whole maps: a session's last_event or a grant's usage tick does not rebuild it
  const gKey = useHub(graphKey);
  const attentionKey = useHub(attentionKeyOf);
  const saved = useHub((h) => h.layout);
  const ready = useHub((h) => h.ready);
  const mode = useUI((u) => u.layoutMode);
  const customBase = useUI((u) => u.customBase);
  const expanded = useUI((u) => u.expanded);
  const search = useUI((u) => u.search);
  const filter = useUI((u) => u.filter);
  const panTo = useUI((u) => u.panTo);
  const phone = useIsPhone();
  const q = search.trim().toLowerCase();
  // while searching, node text can change with any hub event
  const searchDep = useHub((h) => (q ? h : null));

  const vpRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const marqueeRef = useRef<HTMLDivElement>(null);
  const [vpEl, setVpEl] = useState<HTMLElement | null>(null);

  const attention = useMemo(() => Object.fromEntries(attentionKey ? attentionKey.split(',').map((id) => [id, true]) : []) as Record<string, boolean>, [attentionKey]);
  // user-resized sizes: only their values matter for the graph, not every position save
  const sizesKey = useMemo(() => JSON.stringify(Object.entries(saved).filter(([, l]) => l.size && Object.keys(l.size).length).map(([k, l]) => [k, l.size])), [saved]);
  const sizes = useMemo(() => Object.fromEntries(JSON.parse(sizesKey)) as Record<string, NodeSize>, [sizesKey]);
  const G = useMemo(() => buildGraph({ ...hub.get(), expanded, phone, attention, sizes }), [gKey, expanded, phone, attention, sizes]); // eslint-disable-line react-hooks/exhaustive-deps
  const auto = useMemo(() => autoLayout(mode === 'custom' ? customBase : mode, G), [mode, customBase, G]);
  const GRef = useRef(G);
  GRef.current = G;

  const [local, setLocal] = useState<Record<string, { x: number; y: number }>>({});
  // live drag / resize values sit in refs only (applied to the DOM directly); end() commits them to state once
  const dragRef = useRef<Record<string, { x: number; y: number }> | null>(null);
  const resizingRef = useRef<{ id: string; w: number; h: number } | null>(null);
  useEffect(() => { setLocal({}); }, [mode]);

  const pos = useMemo(() => {
    let p: Record<string, Box> = auto.pos;
    if (mode === 'custom') p = applySaved(p, G, saved);
    const out: Record<string, Box> = { ...p };
    Object.keys(local).forEach((id) => { if (out[id]) out[id] = { ...out[id], ...local[id] }; });
    return out;
  }, [auto, mode, G, saved, local]);
  const posRef = useRef(pos);
  posRef.current = pos;

  // ---- view report: tell the hub what this view shows, so Claude's canvas tools see the same positions and selection.
  // Debounced (camera moves too), skipped when unchanged, paused while the page is hidden; the hub prefers visible pages.
  const viewPayload = useRef<() => Record<string, unknown> | null>(() => null);
  viewPayload.current = () => {
    if (!ready) return null;
    const v = view.get();
    const u = ui.get();
    const p = posRef.current;
    const nodes = G.nodes.filter((n) => p[n.id]).map((n) => {
      const b = p[n.id];
      return { id: n.id, kind: n.kind, title: nodeText(n).replace(/\s+/g, ' ').trim().slice(0, 100), parent: n.parent, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), ex: !!u.expanded[n.id] };
    });
    const visible = v.z > 0 ? { x: Math.round(-v.x / v.z), y: Math.round(-v.y / v.z), w: Math.round(v.w / v.z), h: Math.round(v.h / v.z) } : null;
    return { mode, nodes, selected: Object.keys(u.selected), focusId: u.focusId, visible };
  };
  const scheduleView = useRef<() => void>(() => {});
  useEffect(() => {
    let timer: number | undefined;
    let last = '';
    let lastBody: Record<string, unknown> | null = null;
    const send = (force: boolean, shown = !document.hidden) => {
      window.clearTimeout(timer);
      const body = shown ? viewPayload.current() : lastBody;
      if (!body) return;
      const key = JSON.stringify(body);
      const focused = shown && document.hasFocus();
      if (!force && key === last) return;
      last = shown ? key : ''; // after hiding, the next visible report always goes out
      lastBody = body;
      api.canvasView({ clientId: CLIENT_ID, ...body, pageVisible: shown, focused }, { keepalive: !shown }).catch(() => { last = ''; /* offline: resent on the next change */ });
    };
    const schedule = () => {
      window.clearTimeout(timer);
      if (document.hidden) return; // sent once when the page is visible again
      timer = window.setTimeout(() => send(false), 700);
    };
    scheduleView.current = schedule;
    const onVis = () => send(true, !document.hidden);
    const onFocus = () => { if (!document.hidden) send(true); };
    let prev = ui.get();
    const offUi = ui.subscribe(() => {
      const u = ui.get();
      if (u.selected !== prev.selected || u.focusId !== prev.focusId || u.expanded !== prev.expanded) schedule();
      prev = u;
    });
    const offView = view.subscribe(schedule);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onFocus);
    return () => {
      window.clearTimeout(timer);
      offUi(); offView();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onFocus);
    };
  }, []);
  useEffect(() => { scheduleView.current(); }, [ready, G, pos, mode]);

  // ---- camera → DOM (no React re-render while panning). The dot grid is its own layer, moved by transform (a
  // background-position change would repaint). During a pan or pinch both are held by running animations (holdCamera).
  const gridRef = useRef<HTMLDivElement>(null);
  const camHold = useRef<{ world: Animation; grid: Animation } | null>(null);
  const applyCam = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    let lastStep = 0;
    const apply = () => {
      const v = view.get();
      const h = camHold.current;
      // while held (zooming), the grid keeps the spacing it was painted with and only moves; it is repainted at the end
      const step = h && lastStep ? lastStep : GRID * v.z * (v.z < 0.3 ? 4 : v.z < 0.6 ? 2 : 1);
      const mod = (a: number) => ((a % step) + step) % step;
      const tf = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
      const gtf = `translate(${mod(v.x + GRID_PAD)}px, ${mod(v.y + GRID_PAD)}px)`;
      if (h && h.world.effect instanceof KeyframeEffect && h.grid.effect instanceof KeyframeEffect) {
        h.world.effect.setKeyframes([{ transform: tf }, { transform: tf }]);
        h.grid.effect.setKeyframes([{ transform: gtf }, { transform: gtf }]);
      } else {
        if (worldRef.current) worldRef.current.style.transform = tf;
        if (gridRef.current) gridRef.current.style.transform = gtf;
      }
      // below the live zoom the ring / halo animations stop (class only: no React render)
      worldRef.current?.classList.toggle('lowz', v.z < LIVE_ZOOM);
      if (gridRef.current && step !== lastStep) {
        lastStep = step;
        gridRef.current.style.backgroundSize = `${step}px ${step}px`;
      }
    };
    applyCam.current = apply;
    apply();
    return view.subscribe(apply);
  }, []);

  useLayoutEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    setVpEl(el);
    const ro = new ResizeObserver(() => view.set({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    view.set({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // initial fit, once data is there
  const fitted = useRef(false);
  useEffect(() => {
    if (!ready || fitted.current || !Object.keys(pos).length || view.get().w < 10) return;
    fitted.current = true;
    const b = bbox(pos);
    if (phone) {
      // phone: start readable at the top-left column instead of a tiny overview
      const z = 0.5;
      view.set({ z, x: 16 - b.x * z, y: 64 - b.y * z });
    } else fitBox(b, 60, 1, false);
  }, [ready, pos, phone]);

  // pan to a requested node (raw ids of machines/devices/plans/grants resolve to their canvas node)
  useEffect(() => {
    if (!panTo) return;
    const t = setTimeout(() => {
      const id = ['', 'm:', 'dev:', 'hil:', 'grant:'].map((p) => p + panTo.id).find((k) => posRef.current[k]);
      const b = id ? posRef.current[id] : null;
      if (b) centerOn(b, phone ? 0.5 : 0.8);
    }, 30);
    return () => clearTimeout(t);
  }, [panTo, phone]);

  // ---- wheel (native, non-passive)
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement;
      const inner = t.closest?.('[data-wheel="inner"]') as HTMLElement | null;
      if (inner && !e.ctrlKey && !e.metaKey) return; // let transcripts scroll
      e.preventDefault();
      // a burst of wheel events moves the camera like a pan: held by animations until it settles
      holdCamera(true);
      window.clearTimeout(wheelEnd);
      wheelEnd = window.setTimeout(() => { if (!gesture.current && !pinch.current) holdCamera(false); }, 200);
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const trackpadPan = !e.ctrlKey && !e.metaKey && (Math.abs(e.deltaX) > 0.5 || (e.deltaMode === 0 && !Number.isInteger(e.deltaY)));
      if (trackpadPan) {
        const v = view.get();
        view.set({ x: v.x - e.deltaX, y: v.y - e.deltaY });
      } else {
        zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), cx, cy);
      }
    };
    let wheelEnd: number | undefined;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { window.clearTimeout(wheelEnd); el.removeEventListener('wheel', onWheel); };
  }, []);

  // ---- live gesture → DOM (no React render per pointer move)
  // A drag moves the nodes with a running Web Animation whose keyframes are replaced each tick: a running transform
  // animation is composited with "assumed overlap", so a tick neither repaints nor re-layerizes the canvas (setting an
  // inline transform would, once per frame). Edges touching the moved nodes are hidden and drawn by copies in an
  // overlay that is itself held by a running animation; only that overlay repaints.
  const els = useRef(new Map<string, HTMLDivElement>());
  const liveSvgRef = useRef<SVGSVGElement>(null);
  /** edges touching the nodes being moved / resized: the original element and its live copy */
  const liveEdges = useRef<{ from: string; to: string; el: SVGElement; copy: SVGElement }[]>([]);
  const liveAnims = useRef(new Map<string, Animation>());
  const overlayAnim = useRef<Animation | null>(null);
  /** ids whose element carries live styles (animation / size / class) */
  const settleIds = useRef<string[]>([]);
  /** a gesture's result was committed to state: its commit's layout effect settles the live styles */
  const settlePending = useRef(false);
  const gestureBusy = (on: boolean, cursor?: string) => {
    // .world ignores the pointer during gestures so iframes and inner handlers never steal it
    if (worldRef.current) worldRef.current.style.pointerEvents = on ? 'none' : '';
    if (vpRef.current) vpRef.current.style.cursor = cursor || '';
  };
  const hold = (el: Element, tf: string) => el.animate?.([{ transform: tf }, { transform: tf }], { duration: 1e9, fill: 'forwards' }) ?? null;
  /** pan / pinch: camera updates go to running animations (a transform change on a held layer neither repaints nor re-layerizes) */
  const holdCamera = (on: boolean) => {
    const w = worldRef.current, g = gridRef.current;
    if (on) {
      if (camHold.current || !w || !g) return;
      const a = hold(w, w.style.transform), b = hold(g, g.style.transform);
      if (a && b) camHold.current = { world: a, grid: b };
      else { a?.cancel(); b?.cancel(); }
      return;
    }
    const h = camHold.current;
    if (!h) return;
    camHold.current = null;
    applyCam.current(); // final camera as inline transforms (re-rastered at the final zoom), then drop the animations
    h.world.cancel();
    h.grid.cancel();
  };
  const beginLive = (ids: string[], cls: 'dragging' | 'resizing') => {
    const set = new Set(ids);
    const svg = svgRef.current, overlay = liveSvgRef.current;
    liveEdges.current = [];
    if (svg && overlay) {
      GRef.current.edges.forEach((ed) => {
        if (!set.has(ed.from) && !set.has(ed.to)) return;
        const el = svg.querySelector(`[data-e="${CSS.escape(`${ed.from}>${ed.to}`)}"]`) as SVGElement | null;
        if (!el) return;
        const copy = el.cloneNode() as SVGElement;
        copy.removeAttribute('data-e');
        overlay.appendChild(copy);
        el.style.visibility = 'hidden';
        liveEdges.current.push({ from: ed.from, to: ed.to, el, copy });
      });
      if (liveEdges.current.length) {
        // a fixed, practically invisible backdrop keeps the overlay's paint bounds constant while its lines move, so a
        // tick repaints the overlay without re-layerizing the whole canvas (that costs ~100 ms with hundreds of nodes)
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r.setAttribute('x', '-50000'); r.setAttribute('y', '-50000'); r.setAttribute('width', '100000'); r.setAttribute('height', '100000');
        r.setAttribute('fill', 'rgba(11,12,14,0.01)');
        overlay.insertBefore(r, overlay.firstChild);
        overlayAnim.current = hold(overlay, 'translate(0px, 0px)');
      }
    }
    ids.forEach((id) => els.current.get(id)?.classList.add(cls));
    settleIds.current = ids;
  };
  const liveBox = (id: string): Box | undefined => {
    const b = posRef.current[id];
    if (!b) return b;
    const d = dragRef.current?.[id];
    const r = resizingRef.current;
    return { x: d ? d.x : b.x, y: d ? d.y : b.y, w: r && r.id === id ? r.w : b.w, h: r && r.id === id ? r.h : b.h };
  };
  const setGeom = (el: SVGElement, g: ReturnType<typeof edgeGeom>) => {
    if (!g || ('d' in g) !== (el.tagName === 'path')) { el.style.display = 'none'; return; }
    el.style.display = '';
    if ('d' in g) el.setAttribute('d', g.d);
    else { el.setAttribute('x1', String(g.x1)); el.setAttribute('y1', String(g.y1)); el.setAttribute('x2', String(g.x2)); el.setAttribute('y2', String(g.y2)); }
  };
  const applyLive = () => {
    const d = dragRef.current;
    const r = resizingRef.current;
    if (d) Object.keys(d).forEach((id) => {
      const el = els.current.get(id), b = posRef.current[id];
      if (!el || !b) return;
      const tf = `translate(${d[id].x - b.x}px, ${d[id].y - b.y}px)`;
      const a = liveAnims.current.get(id);
      if (a?.effect instanceof KeyframeEffect) a.effect.setKeyframes([{ transform: tf }, { transform: tf }]);
      else {
        const h = hold(el, tf);
        if (h) liveAnims.current.set(id, h);
        else el.style.transform = tf;
      }
    });
    if (r) {
      const el = els.current.get(r.id);
      if (el) { el.style.width = `${r.w}px`; el.style.height = `${r.h}px`; }
    }
    const tree = ui.get().layoutMode === 'tree';
    liveEdges.current.forEach(({ from, to, copy }) => {
      const a = liveBox(from), b = liveBox(to);
      setGeom(copy, a && b ? edgeGeom(a, b, tree) : null);
    });
  };
  /** drop live styles: boxes and edges come from the committed positions again (without a transition from the old spot) */
  const settle = () => {
    const ids = settleIds.current;
    if (!ids.length) return;
    settleIds.current = [];
    ids.forEach((id) => {
      const el = els.current.get(id), b = posRef.current[id];
      if (!el) return;
      if (b) { el.style.left = `${b.x}px`; el.style.top = `${b.y}px`; el.style.width = `${b.w}px`; el.style.height = `${b.h}px`; }
      liveAnims.current.get(id)?.cancel();
      el.style.transform = '';
      void el.offsetWidth; // apply the final box while transitions are still off
      el.classList.remove('dragging', 'resizing');
    });
    liveAnims.current.clear();
    // the originals were re-rendered at the committed positions (or never moved): show them, drop the copies
    liveEdges.current.forEach(({ el }) => { el.style.visibility = ''; });
    liveEdges.current = [];
    liveSvgRef.current?.replaceChildren();
    overlayAnim.current?.cancel();
    overlayAnim.current = null;
  };
  // after the commit that carries a gesture's result, the DOM matches React again (never mid-gesture)
  useLayoutEffect(() => {
    if (!settlePending.current) return;
    settlePending.current = false;
    settle();
  });
  const showMarquee = (m: { x0: number; y0: number; x1: number; y1: number } | null) => {
    const el = marqueeRef.current;
    if (!el) return;
    if (!m) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.left = `${Math.min(m.x0, m.x1)}px`; el.style.top = `${Math.min(m.y0, m.y1)}px`;
    el.style.width = `${Math.abs(m.x1 - m.x0)}px`; el.style.height = `${Math.abs(m.y1 - m.y0)}px`;
  };

  // ---- pointers: pan, marquee, node drag, resize, pinch
  type Gest =
    | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean; menu?: { x: number; y: number; parentId: string | null; kind?: string }; tap?: boolean }
    | { kind: 'marquee'; sx: number; sy: number; moved: boolean; base: Record<string, true> }
    | { kind: 'node'; id: string; sx: number; sy: number; moved: boolean; shift: boolean; origins: Record<string, { x: number; y: number }> }
    | { kind: 'resize'; id: string; sx: number; sy: number; moved: boolean; ow: number; oh: number };
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gest | null>(null);
  const pinch = useRef<null | { d: number; mx: number; my: number }>(null);
  const ctxUntil = useRef(0); // swallow the contextmenu event that follows a right-button gesture (Windows fires it on mouseup)

  const localXY = (e: { clientX: number; clientY: number }) => {
    const r = vpRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const isMouse = (e: React.PointerEvent) => e.pointerType === 'mouse';

  /** abandon a drag / resize / marquee in progress (a second finger turns it into a pinch) */
  const cancelLive = () => {
    dragRef.current = null;
    resizingRef.current = null;
    showMarquee(null);
    settle();
  };

  const capture = (e: React.PointerEvent) => {
    const p = localXY(e);
    ptrs.current.set(e.pointerId, p);
    try { vpRef.current?.setPointerCapture(e.pointerId); } catch { /* */ }
    if (ptrs.current.size === 2) {
      const [a, b] = Array.from(ptrs.current.values());
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      gesture.current = null;
      cancelLive();
      holdCamera(true);
      return null;
    }
    return p;
  };

  const beginPan = (e: React.PointerEvent, menu?: { parentId: string | null; kind?: string }) => {
    const p = capture(e);
    if (!p) return;
    const v = view.get();
    gesture.current = { kind: 'pan', sx: p.x, sy: p.y, vx: v.x, vy: v.y, moved: false, menu: menu ? { x: e.clientX, y: e.clientY, ...menu } : undefined, tap: !menu };
    gestureBusy(true, 'grabbing');
    holdCamera(true);
  };

  /** pointerdown on empty canvas */
  const onCanvasDown = (e: React.PointerEvent) => {
    if (!isMouse(e)) return beginPan(e);
    if (e.button === 1 || e.button === 2) return beginPan(e, e.button === 2 ? { parentId: null } : undefined);
    if (e.button !== 0 || e.ctrlKey) return; // ctrl-click: the macOS context menu
    const p = capture(e);
    if (!p) return;
    gesture.current = { kind: 'marquee', sx: p.x, sy: p.y, moved: false, base: e.shiftKey ? { ...ui.get().selected } : {} };
  };

  const subtree = (G: Graph, roots: string[]) => {
    const out = new Set<string>();
    const walk = (id: string, d: number) => { if (out.has(id) || d > 80) return; out.add(id); (G.kids[id] || []).forEach((k) => walk(k, d + 1)); };
    roots.forEach((r) => walk(r, 0));
    return Array.from(out);
  };

  /** pointerdown on a node body */
  const onNodeDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const n = GRef.current.byId[id];
    if (!n) return;
    if (isMouse(e) && (e.button === 1 || e.button === 2)) return beginPan(e, e.button === 2 ? { parentId: n.id, kind: n.kind } : undefined);
    if (isMouse(e) && (e.button !== 0 || e.ctrlKey)) return;
    const p = capture(e);
    if (!p) return;
    const sel = ui.get().selected;
    const inSel = !!sel[n.id];
    if (!inSel && !e.shiftKey) ui.set({ selected: { [n.id]: true } });
    const base = inSel ? Object.keys(sel) : [n.id];
    const ids = e.shiftKey ? subtree(GRef.current, inSel ? base : [n.id]) : base;
    const origins: Record<string, { x: number; y: number }> = {};
    ids.forEach((nid) => { const b = posRef.current[nid]; if (b) origins[nid] = { x: b.x, y: b.y }; });
    gesture.current = { kind: 'node', id: n.id, sx: p.x, sy: p.y, moved: false, shift: e.shiftKey, origins };
  };

  /** pointerdown on a node's resize handle */
  const onResizeDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    if (isMouse(e) && e.button !== 0) return;
    const p = capture(e);
    if (!p) return;
    const b = posRef.current[id];
    if (!b) return;
    gesture.current = { kind: 'resize', id, sx: p.x, sy: p.y, moved: false, ow: b.w, oh: b.h };
  };

  const onMove = (e: React.PointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    const p = localXY(e);
    ptrs.current.set(e.pointerId, p);
    if (pinch.current && ptrs.current.size >= 2) {
      const [a, b] = Array.from(ptrs.current.values());
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const v = view.get();
      const z = clampZ(v.z * (d / Math.max(pinch.current.d, 1)));
      const k = z / v.z;
      view.set({ z, x: mx - (pinch.current.mx - v.x) * k, y: my - (pinch.current.my - v.y) * k });
      pinch.current = { d, mx, my };
      return;
    }
    const g = gesture.current;
    if (!g) return;
    const dx = p.x - g.sx, dy = p.y - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    const first = !g.moved;
    g.moved = true;
    const z = view.get().z;
    if (g.kind === 'pan') view.set({ x: g.vx + dx, y: g.vy + dy });
    else if (g.kind === 'node') {
      if (first) { beginLive(Object.keys(g.origins), 'dragging'); gestureBusy(true); }
      const out: Record<string, { x: number; y: number }> = {};
      Object.keys(g.origins).forEach((id) => { out[id] = { x: Math.round(g.origins[id].x + dx / z), y: Math.round(g.origins[id].y + dy / z) }; });
      dragRef.current = out;
      applyLive();
    } else if (g.kind === 'resize') {
      if (first) { beginLive([g.id], 'resizing'); gestureBusy(true); }
      resizingRef.current = { id: g.id, w: Math.max(160, Math.round(g.ow + dx / z)), h: Math.max(56, Math.round(g.oh + dy / z)) };
      applyLive();
    } else if (g.kind === 'marquee') {
      if (first) gestureBusy(true);
      showMarquee({ x0: g.sx, y0: g.sy, x1: p.x, y1: p.y });
      const v = view.get();
      const wx0 = (Math.min(g.sx, p.x) - v.x) / v.z, wx1 = (Math.max(g.sx, p.x) - v.x) / v.z;
      const wy0 = (Math.min(g.sy, p.y) - v.y) / v.z, wy1 = (Math.max(g.sy, p.y) - v.y) / v.z;
      const sel: Record<string, true> = { ...g.base };
      Object.entries(posRef.current).forEach(([id, b]) => { if (b.x < wx1 && b.x + b.w > wx0 && b.y < wy1 && b.y + b.h > wy0) sel[id] = true; });
      const cur = ui.get().selected;
      const same = Object.keys(sel).length === Object.keys(cur).length && Object.keys(sel).every((k) => cur[k]);
      if (!same) ui.set({ selected: sel });
    }
  };

  const saveLayout = (entries: Record<string, { x: number; y: number; size?: NodeSize }>) => {
    const ex = ui.get().expanded;
    hub.set((s) => {
      const layout = { ...s.layout };
      Object.entries(entries).forEach(([id, e]) => {
        const prev = layout[id];
        const size = e.size ? { ...(prev?.size || {}), ...e.size } : prev?.size;
        layout[id] = { ...(prev || {}), x: e.x, y: e.y, ...(size ? { size } : {}) };
      });
      return { layout };
    });
    Object.entries(entries).forEach(([id, e]) => {
      const b = posRef.current[id];
      api.layout({ nodeId: id, x: e.x, y: e.y, w: b?.w, h: b?.h, collapsed: !ex[id], ...(e.size ? { size: e.size } : {}) }).catch(() => { /* offline: keep local */ });
    });
  };

  const end = (e: React.PointerEvent) => {
    ptrs.current.delete(e.pointerId);
    try { vpRef.current?.releasePointerCapture(e.pointerId); } catch { /* */ }
    if (ptrs.current.size < 2) pinch.current = null;
    const g = gesture.current;
    if (ptrs.current.size > 0) return;
    gesture.current = null;
    const moved = dragRef.current;
    const r = resizingRef.current;
    // always leave the gesture state clean, so .world never stays pointer-events: none
    dragRef.current = null;
    resizingRef.current = null;
    gestureBusy(false);
    holdCamera(false);
    showMarquee(null);
    if (!g) return settle();
    if (g.kind === 'node') {
      if (g.moved && moved) {
        // one commit; its layout effect drops the live transforms (settle)
        settlePending.current = true;
        setLocal((l) => ({ ...l, ...moved }));
        saveLayout(moved);
        // like Claude's moves: a position only sticks in Custom, which starts from the auto layout that is showing
        if (ui.get().layoutMode !== 'custom') setLayoutMode('custom');
        return;
      }
      if (!g.moved) {
        if (g.shift && e.type === 'pointerup') {
          // shift-click toggles the node in the selection
          const sel = { ...ui.get().selected };
          if (sel[g.id]) delete sel[g.id]; else sel[g.id] = true;
          ui.set({ selected: sel });
        } else {
          ui.set({ selected: { [g.id]: true } });
          // click: expand a collapsed session
          if (hub.get().sessions[g.id] && !ui.get().expanded[g.id]) setExpanded(g.id, true);
          ui.set({ focusId: g.id });
        }
      }
    } else if (g.kind === 'resize') {
      const b = posRef.current[g.id];
      if (g.moved && r && b) {
        const key = ui.get().expanded[g.id] && !phone ? 'x' : 'c';
        settlePending.current = true;
        setLocal((l) => ({ ...l, [g.id]: { x: b.x, y: b.y } }));
        saveLayout({ [g.id]: { x: b.x, y: b.y, size: { [key]: [r.w, r.h] } } });
        return;
      }
    } else if (g.kind === 'pan') {
      if (g.menu) {
        ctxUntil.current = Date.now() + 600;
        if (!g.moved && e.type === 'pointerup') ui.set({ addMenu: { x: g.menu.x, y: g.menu.y, parentId: g.menu.parentId, kind: g.menu.kind } });
      } else if (!g.moved && g.tap) ui.set({ focusId: null, selected: {} });
    } else if (g.kind === 'marquee' && !g.moved) {
      ui.set({ focusId: null, selected: {} });
    }
    settle();
  };

  /** double-click a resize handle: back to the default size for this state */
  const resetSize = (id: string) => {
    const b = posRef.current[id];
    if (!b) return;
    const key = ui.get().expanded[id] && !phone ? 'x' : 'c';
    saveLayout({ [id]: { x: b.x, y: b.y, size: { [key]: null } } });
  };

  // keyboard: Escape clears the selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !Object.keys(ui.get().selected).length) return;
      const t = e.target as HTMLElement | null;
      if (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable || t.closest?.('.xterm'))) return;
      ui.set({ selected: {} });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // contextmenu: right-button gestures open the menu on release; keyboard / ctrl-click open it right away
  const onCtx = (e: React.MouseEvent, parentId: string | null, kind?: string) => {
    e.preventDefault();
    e.stopPropagation();
    const g = gesture.current;
    if ((g?.kind === 'pan' && g.menu) || Date.now() < ctxUntil.current) return;
    ui.set({ addMenu: { x: e.clientX, y: e.clientY, parentId, kind } });
  };

  // stable callbacks for the memoized node wrappers (they call the latest handlers through a ref)
  const handlers = useRef({ onNodeDown, onCtx, onResizeDown, resetSize });
  handlers.current = { onNodeDown, onCtx, onResizeDown, resetSize };
  const acts = useMemo<NodeActs>(() => ({
    down: (e, id) => handlers.current.onNodeDown(e, id),
    ctx: (e, id, kind) => handlers.current.onCtx(e, id, kind),
    rzDown: (e, id) => handlers.current.onResizeDown(e, id),
    rzReset: (id) => handlers.current.resetSize(id),
    reg: (id, el) => { if (el) els.current.set(id, el); else els.current.delete(id); },
  }), []);

  // ---- opacity from search / compute filter
  const opacity = useMemo(() => {
    const o: Record<string, number> = {};
    G.nodes.forEach((n) => {
      let v = 1;
      if (q && !nodeText(n).toLowerCase().includes(q)) v = 0.15;
      if (filter) {
        if (!n.compute) v = Math.min(v, 0.45);
        else if (n.compute !== filter) v = Math.min(v, 0.18);
      }
      o[n.id] = v;
    });
    return o;
  }, [G, q, filter, searchDep]); // eslint-disable-line react-hooks/exhaustive-deps

  const headers = mode === 'custom' ? [] : auto.headers;
  const tree = mode === 'tree';

  return (
    <ViewportCtx.Provider value={vpEl}>
      <div
        ref={vpRef}
        className="viewport"
        data-testid="canvas"
        onPointerDown={onCanvasDown}
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerCancel={end}
        onContextMenu={(e) => onCtx(e, null)}
      >
        <div ref={gridRef} className="grid" aria-hidden="true" />
        <div ref={worldRef} className="world">
          <svg ref={svgRef} width="1" height="1" style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}>
            {G.edges.map((ed) => {
              const a = pos[ed.from], b = pos[ed.to];
              if (!a || !b || !G.byId[ed.from] || !G.byId[ed.to]) return null;
              const o = Math.min(opacity[ed.from] ?? 1, opacity[ed.to] ?? 1) * (ed.op ?? 1);
              const g = edgeGeom(a, b, tree);
              if (!g) return null;
              const k = `${ed.from}>${ed.to}`;
              return 'd' in g
                ? <path key={k} data-e={k} d={g.d} fill="none" stroke={ed.color} strokeWidth={1.5} strokeDasharray={ed.dash} opacity={o} />
                : <line key={k} data-e={k} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke={ed.color} strokeWidth={1.5} strokeDasharray={ed.dash} opacity={o} />;
            })}
          </svg>
          {/* live copies of the edges touching dragged / resized nodes (see beginLive) */}
          <svg ref={liveSvgRef} width="1" height="1" style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }} />
          {headers.map((h) => (
            <div key={h.key} style={{ position: 'absolute', left: h.x, top: h.y, display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
              <span className="dot" style={{ width: 9, height: 9, background: h.color, boxShadow: `0 0 10px ${h.color}88` }} />
              <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>{h.label}</span>
              {h.sub ? <span className="mono" style={{ fontSize: 11, color: '#8A8F98' }}>{h.sub}</span> : null}
            </div>
          ))}
          {G.nodes.map((n) => {
            const p = pos[n.id];
            if (!p) return null;
            return <NodeWrap key={n.id} id={n.id} kind={n.kind} refId={n.ref} x={p.x} y={p.y} w={p.w} h={p.h} op={opacity[n.id] ?? 1} ex={!!expanded[n.id] && !phone} phone={phone} acts={acts} />;
          })}
        </div>
        <div ref={marqueeRef} className="marquee" data-testid="marquee" style={{ display: 'none' }} />
        {ready && !G.nodes.length ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{ textAlign: 'center', color: '#8A8F98', fontSize: 13, lineHeight: 1.6 }}>No projects, sessions or nodes yet.<br />Use <b style={{ color: '#E7E8EA' }}>+ Add</b> to start a session or place a node.</div>
          </div>
        ) : null}
      </div>
      <BottomBar pos={pos} />
      <ChangePill />
    </ViewportCtx.Provider>
  );
}

/** "Claude arranged 4 nodes · Undo": the latest batch of canvas edits made through the canvas tools. */
function ChangePill() {
  const c = useUI((u) => u.changes[0]);
  const [hidden, setHidden] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!c) return;
    const t = setTimeout(() => setHidden(c.batchId), 15000);
    return () => clearTimeout(t);
  }, [c?.batchId, c?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c || hidden === c.batchId) return null;
  const undo = async () => {
    setBusy(true);
    try { await api.canvasUndo(c.batchId); } catch (e) { toast(`Undo failed: ${(e as Error).message}`, 'error'); }
    setBusy(false);
  };
  return (
    <div className="change-pill" data-testid="change-pill" data-batch={c.batchId}>
      <span className="dot" style={{ background: '#E0896B', boxShadow: '0 0 8px #E0896B' }} />
      <span className="ell" style={{ maxWidth: 420 }}><b style={{ fontWeight: 600 }}>{c.by}</b> {c.undone ? 'changes undone' : c.summary.join(' · ')}</span>
      {!c.undone ? <button className="b" style={{ height: 26 }} disabled={busy} data-testid="change-undo" onClick={undo}>Undo</button> : null}
      <button className="x" aria-label="Dismiss" onClick={() => setHidden(c.batchId)}><Icon name="x" size={11} /></button>
    </div>
  );
}

function BottomBar({ pos }: { pos: Record<string, Box> }) {
  const zoom = useView((v) => Math.round(v.z * 100));
  const hosts = useHub((h) => h.hosts);
  const sessions = useHub((h) => h.sessions);
  const filter = useUI((u) => u.filter);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    Object.values(sessions).forEach((s) => { if (isActive(s)) { const k = computeKey(s); c[k] = (c[k] || 0) + 1; } });
    return c;
  }, [sessions]);
  const keys = [...Object.values(hosts).sort((a, b) => a.label.localeCompare(b.label)).map((h) => h.id), 'cloud:claude', 'cloud:codex'];
  const zoomBy = (f: number) => { const v = view.get(); zoomAt(f, v.w / 2, v.h / 2); };
  const pick = (k: string | null) => ui.set({ filter: k });
  return (
    <div className="bottombar noscrollbar" data-testid="bottom-bar">
      <div className="pill">
        <button className="b ghost" aria-label="Zoom out" style={{ width: 28, padding: 0, justifyContent: 'center' }} onClick={() => zoomBy(1 / 1.2)}>−</button>
        <span className="mono" data-testid="zoom-pct" style={{ fontSize: 11.5, width: 42, textAlign: 'center', color: '#C9CCD2' }}>{zoom}%</span>
        <button className="b ghost" aria-label="Zoom in" style={{ width: 28, padding: 0, justifyContent: 'center' }} onClick={() => zoomBy(1.2)}>+</button>
        <button className="b ghost" onClick={() => fitBox(bbox(pos), 40, 1)}>Fit</button>
        <button className="b ghost" onClick={() => ui.set({ expanded: {}, focusId: null })}>Collapse all</button>
      </div>
      <div className="pill" role="group" aria-label="Filter by compute">
        <button className={`chip${filter ? '' : ' on'}`} onClick={() => pick(null)}>All compute</button>
        {keys.map((k) => {
          const h = hosts[k];
          const name = h ? h.label : CLOUD_NAMES[k];
          const color = computeColor(k, hosts);
          return (
            <button key={k} className={`chip${filter === k ? ' on' : ''}`} onClick={() => pick(filter === k ? null : k)} title={h ? `${h.label} · ${h.status}` : name} data-testid={`filter-${k}`}>
              <span className="dot" style={{ background: color, opacity: h && h.status !== 'online' ? 0.4 : 1 }} />{name}
              <span className="mono" style={{ fontSize: 11, color: '#8A8F98' }}>{counts[k] || 0}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
