// Infinite canvas: pan / zoom / pinch, draggable + resizable nodes, marquee selection, auto layout, edges.
//   Mouse: left-drag on empty canvas selects (shift adds), right- or middle-drag pans, right-click opens the add menu.
//   Nodes: drag moves the node (or the whole selection); shift-drag also moves every descendant.
//   Touch: one finger pans or drags a node, two fingers pinch.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { ViewportCtx } from '../nodes/common';
import { NodeView } from '../nodes/NodeView';
import { hub, setExpanded, toast, ui, useHub, useUI } from '../store';
import { CLOUD_NAMES, Icon, computeColor, computeKey, isActive, useIsPhone } from '../ui';
import { applySaved, autoLayout, bbox, buildGraph, clipSeg, type Box, type GNode, type Graph, type NodeSize } from './layout';
import { centerOn, clampZ, fitBox, useView, view, zoomAt } from './view';

const GRID = 22;
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

export function Canvas() {
  const hosts = useHub((h) => h.hosts);
  const checkouts = useHub((h) => h.checkouts);
  const sessions = useHub((h) => h.sessions);
  const nodes = useHub((h) => h.nodes);
  const approvals = useHub((h) => h.approvals);
  const projects = useHub((h) => h.projects);
  const branches = useHub((h) => h.branches);
  const machines = useHub((h) => h.machines);
  const devices = useHub((h) => h.devices);
  const cnodes = useHub((h) => h.cnodes);
  const todos = useHub((h) => h.todos);
  const grants = useHub((h) => h.grants);
  const hilPlans = useHub((h) => h.hilPlans);
  const saved = useHub((h) => h.layout);
  const ready = useHub((h) => h.ready);
  const mode = useUI((u) => u.layoutMode);
  const customBase = useUI((u) => u.customBase);
  const glow = useUI((u) => u.glow);
  const focusId = useUI((u) => u.focusId);
  const expanded = useUI((u) => u.expanded);
  const search = useUI((u) => u.search);
  const filter = useUI((u) => u.filter);
  const panTo = useUI((u) => u.panTo);
  const selected = useUI((u) => u.selected);
  const phone = useIsPhone();

  const vpRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [vpEl, setVpEl] = useState<HTMLElement | null>(null);

  const attention = useMemo(() => {
    const a: Record<string, boolean> = {};
    Object.values(approvals).forEach((x) => { if (x.status === 'pending') a[x.session_id] = true; });
    return a;
  }, [approvals]);

  // machines tick often: only their membership matters for the graph
  const machineKeys = useMemo(() => Object.values(machines).map((m) => `${m.id}|${m.kind}|${m.label}|${m.color}`).join(','), [machines]);
  // user-resized sizes: only their values matter for the graph, not every position save
  const sizesKey = useMemo(() => JSON.stringify(Object.entries(saved).filter(([, l]) => l.size && Object.keys(l.size).length).map(([k, l]) => [k, l.size])), [saved]);
  const sizes = useMemo(() => Object.fromEntries(JSON.parse(sizesKey)) as Record<string, NodeSize>, [sizesKey]);
  const G = useMemo(() => buildGraph({ hosts, checkouts, sessions, nodes, projects, branches, machines: hub.get().machines, devices, cnodes, todos, grants, hilPlans, expanded, phone, attention, sizes }),
    [hosts, checkouts, sessions, nodes, projects, branches, machineKeys, devices, cnodes, todos, grants, hilPlans, expanded, phone, attention, sizes]); // eslint-disable-line react-hooks/exhaustive-deps
  const auto = useMemo(() => autoLayout(mode === 'custom' ? customBase : mode, G), [mode, customBase, G]);
  const GRef = useRef(G);
  GRef.current = G;

  const [local, setLocal] = useState<Record<string, { x: number; y: number }>>({});
  const [drag, setDrag] = useState<Record<string, { x: number; y: number }> | null>(null);
  const [resizing, setResizing] = useState<{ id: string; w: number; h: number } | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  useEffect(() => { setLocal({}); }, [mode]);

  const pos = useMemo(() => {
    let p: Record<string, Box> = auto.pos;
    if (mode === 'custom') p = applySaved(p, G, saved);
    const out: Record<string, Box> = { ...p };
    Object.keys(local).forEach((id) => { if (out[id]) out[id] = { ...out[id], ...local[id] }; });
    if (drag) Object.keys(drag).forEach((id) => { if (out[id]) out[id] = { ...out[id], ...drag[id] }; });
    if (resizing && out[resizing.id]) out[resizing.id] = { ...out[resizing.id], w: resizing.w, h: resizing.h };
    return out;
  }, [auto, mode, G, saved, local, drag, resizing]);
  const posRef = useRef(pos);
  posRef.current = pos;

  // tell the hub what this view shows, so Claude's canvas tools see the same positions and selection
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => {
      const v = view.get();
      const nodes = G.nodes.filter((n) => pos[n.id]).map((n) => {
        const p = pos[n.id];
        return { id: n.id, kind: n.kind, title: nodeText(n).replace(/\s+/g, ' ').trim().slice(0, 100), parent: n.parent, x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), h: Math.round(p.h), ex: !!expanded[n.id] };
      });
      const visible = v.z > 0 ? { x: Math.round(-v.x / v.z), y: Math.round(-v.y / v.z), w: Math.round(v.w / v.z), h: Math.round(v.h / v.z) } : null;
      api.canvasView({ clientId: CLIENT_ID, mode, nodes, selected: Object.keys(selected), focusId, visible }).catch(() => { /* offline */ });
    }, 700);
    return () => clearTimeout(t);
  }, [ready, G, pos, selected, focusId, mode, expanded]);

  // ---- camera → DOM (no React re-render while panning)
  useLayoutEffect(() => {
    const apply = () => {
      const v = view.get();
      if (worldRef.current) worldRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
      if (vpRef.current) {
        const step = GRID * v.z * (v.z < 0.3 ? 4 : v.z < 0.6 ? 2 : 1);
        vpRef.current.style.backgroundSize = `${step}px ${step}px`;
        vpRef.current.style.backgroundPosition = `${v.x}px ${v.y}px`;
      }
    };
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
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

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
  const [panning, setPanning] = useState(false);

  const localXY = (e: { clientX: number; clientY: number }) => {
    const r = vpRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const isMouse = (e: React.PointerEvent) => e.pointerType === 'mouse';

  const capture = (e: React.PointerEvent) => {
    const p = localXY(e);
    ptrs.current.set(e.pointerId, p);
    try { vpRef.current?.setPointerCapture(e.pointerId); } catch { /* */ }
    if (ptrs.current.size === 2) {
      const [a, b] = Array.from(ptrs.current.values());
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      gesture.current = null;
      setDrag(null); setMarquee(null); setResizing(null);
      return null;
    }
    return p;
  };

  const beginPan = (e: React.PointerEvent, menu?: { parentId: string | null; kind?: string }) => {
    const p = capture(e);
    if (!p) return;
    const v = view.get();
    gesture.current = { kind: 'pan', sx: p.x, sy: p.y, vx: v.x, vy: v.y, moved: false, menu: menu ? { x: e.clientX, y: e.clientY, ...menu } : undefined, tap: !menu };
    setPanning(true);
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
  const onNodeDown = (e: React.PointerEvent, n: GNode) => {
    e.stopPropagation();
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
    ids.forEach((id) => { const b = posRef.current[id]; if (b) origins[id] = { x: b.x, y: b.y }; });
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
    g.moved = true;
    const z = view.get().z;
    if (g.kind === 'pan') view.set({ x: g.vx + dx, y: g.vy + dy });
    else if (g.kind === 'node') {
      const out: Record<string, { x: number; y: number }> = {};
      Object.keys(g.origins).forEach((id) => { out[id] = { x: Math.round(g.origins[id].x + dx / z), y: Math.round(g.origins[id].y + dy / z) }; });
      setDrag(out);
    } else if (g.kind === 'resize') {
      setResizing({ id: g.id, w: Math.max(160, Math.round(g.ow + dx / z)), h: Math.max(56, Math.round(g.oh + dy / z)) });
    } else if (g.kind === 'marquee') {
      setMarquee({ x0: g.sx, y0: g.sy, x1: p.x, y1: p.y });
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
    setPanning(false);
    setMarquee(null);
    if (!g) return;
    if (g.kind === 'node') {
      if (g.moved && drag) {
        const moved = drag;
        setLocal((l) => ({ ...l, ...moved }));
        setDrag(null);
        saveLayout(moved);
      } else if (!g.moved) {
        setDrag(null);
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
      const r = resizing;
      setResizing(null);
      const b = posRef.current[g.id];
      if (g.moved && r && b) {
        const key = ui.get().expanded[g.id] && !phone ? 'x' : 'c';
        setLocal((l) => ({ ...l, [g.id]: { x: b.x, y: b.y } }));
        saveLayout({ [g.id]: { x: b.x, y: b.y, size: { [key]: [r.w, r.h] } } });
      }
    } else if (g.kind === 'pan') {
      if (g.menu) {
        ctxUntil.current = Date.now() + 600;
        if (!g.moved && e.type === 'pointerup') ui.set({ addMenu: { x: g.menu.x, y: g.menu.y, parentId: g.menu.parentId, kind: g.menu.kind } });
      } else if (!g.moved && g.tap) ui.set({ focusId: null, selected: {} });
    } else if (g.kind === 'marquee' && !g.moved) {
      ui.set({ focusId: null, selected: {} });
    }
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
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
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

  // ---- opacity from search / compute filter
  const q = search.trim().toLowerCase();
  const opacityOf = useCallback((n: GNode) => {
    let o = 1;
    if (q && !nodeText(n).toLowerCase().includes(q)) o = 0.15;
    if (filter) {
      if (!n.compute) o = Math.min(o, 0.45);
      else if (n.compute !== filter) o = Math.min(o, 0.18);
    }
    return o;
  }, [q, filter, cnodes, todos]); // eslint-disable-line react-hooks/exhaustive-deps

  const sessionCount = useMemo(() => {
    const c: Record<string, number> = {};
    Object.values(sessions).forEach((s) => { if (s.checkout_id && isActive(s)) c[s.checkout_id] = (c[s.checkout_id] || 0) + 1; });
    return c;
  }, [sessions]);

  const headers = mode === 'custom' ? [] : auto.headers;

  return (
    <ViewportCtx.Provider value={vpEl}>
      <div
        ref={vpRef}
        className="viewport"
        data-testid="canvas"
        style={{ cursor: panning ? 'grabbing' : 'default' }}
        onPointerDown={onCanvasDown}
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerCancel={end}
        onContextMenu={(e) => onCtx(e, null)}
      >
        <div ref={worldRef} className="world" style={{ pointerEvents: panning || drag || marquee || resizing ? 'none' : undefined }}>
          <svg width="1" height="1" style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}>
            {G.edges.map((ed) => {
              const a = pos[ed.from], b = pos[ed.to];
              if (!a || !b) return null;
              const fa = G.byId[ed.from], fb = G.byId[ed.to];
              if (!fa || !fb) return null;
              const o = Math.min(opacityOf(fa), opacityOf(fb)) * (ed.op ?? 1);
              if (mode === 'tree' && b.x > a.x + a.w + 20) {
                // left → right tree: a smooth link from the parent's right edge to the child's left edge
                const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, mx = (x1 + x2) / 2;
                return <path key={`${ed.from}-${ed.to}`} d={`M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`} fill="none" stroke={ed.color} strokeWidth={1.5} strokeDasharray={ed.dash} opacity={o} />;
              }
              const s = clipSeg(a, b);
              if (!s) return null;
              return <line key={`${ed.from}-${ed.to}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={ed.color} strokeWidth={1.5} strokeDasharray={ed.dash} opacity={o} />;
            })}
          </svg>
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
            const ex = !!expanded[n.id];
            const s = n.kind === 'session' ? sessions[n.ref] : null;
            const color = s ? computeColor(computeKey(s), hosts) : '';
            const loud = !!s && (s.status === 'waiting' || attention[s.id]);
            const running = !!s && !loud && s.status === 'running';
            const dragging = !!drag?.[n.id];
            const sizing = resizing?.id === n.id;
            const sel = !!selected[n.id];
            const lit = !!glow[n.id];
            return (
              <div
                key={n.id}
                className={`node${dragging ? ' dragging' : ''}${sel ? ' selected' : ''}${sizing ? ' resizing' : ''}${lit ? ' glow' : ''}`}
                data-node={n.kind}
                data-node-key={n.id}
                data-selected={sel ? '1' : undefined}
                style={{
                  left: p.x, top: p.y, width: p.w, height: p.h, opacity: opacityOf(n),
                  zIndex: dragging || sizing ? 50 : ex && !phone ? 20 : sel ? 8 : loud ? 5 : 1, cursor: dragging ? 'grabbing' : 'grab',
                  transition: dragging || sizing ? 'none' : 'left .3s ease, top .3s ease, width .2s ease, height .2s ease, opacity .2s',
                }}
                onPointerDown={(e) => onNodeDown(e, n)}
                onContextMenu={(e) => onCtx(e, n.id, n.kind)}
              >
                {running ? <><span aria-hidden="true" className="halo" style={{ color }} /><span aria-hidden="true" className="ring" style={{ color }} /></> : null}
                {loud ? <span aria-hidden="true" className="loud" /> : null}
                <NodeView kind={n.kind} id={n.id} refId={n.ref} mode={ex && !phone ? 'expanded' : 'collapsed'} sessionCount={sessionCount[n.id] || 0} h={{ checkouts, hosts }} />
                {!phone ? (
                  <div className="rz" data-testid="resize-handle" title="Drag to resize · double-click to reset" onPointerDown={(e) => onResizeDown(e, n.id)} onDoubleClick={(e) => { e.stopPropagation(); resetSize(n.id); }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M9 1L1 9M9 5L5 9" stroke="#8A8F98" strokeWidth="1.4" strokeLinecap="round" /></svg>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {marquee ? (
          <div className="marquee" data-testid="marquee" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />
        ) : null}
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
