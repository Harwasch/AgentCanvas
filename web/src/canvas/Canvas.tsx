// Infinite canvas: pan / zoom / pinch, draggable nodes, auto layout, edges.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { AppNode, ViewportCtx } from '../nodes/AppNode';
import { CheckoutNode } from '../nodes/CheckoutNode';
import { SessionNode } from '../nodes/SessionNode';
import { hub, setExpanded, ui, useHub, useUI } from '../store';
import { CLOUD_NAMES, computeColor, computeKey, isActive, useIsPhone } from '../ui';
import { applySaved, autoLayout, bbox, buildGraph, clipSeg, type Box } from './layout';
import { centerOn, clampZ, fitBox, useView, view, zoomAt } from './view';

const GRID = 22;

function nodeText(id: string): string {
  const h = hub.get();
  const s = h.sessions[id];
  if (s) return [s.title, s.branch, s.vendor, s.kind, h.hosts[s.host_id || '']?.label, h.accounts[s.account_id]?.label, s.status, s.kind === 'cloud' ? CLOUD_NAMES[computeKey(s)] : ''].join(' ');
  const c = h.checkouts[id];
  if (c) return [c.repoName, c.branch, c.path, h.hosts[c.host_id]?.label, c.head_subject].join(' ');
  const n = h.nodes[id];
  if (n) return [n.title, n.appId, n.dir, h.hosts[n.hostId]?.label].join(' ');
  return '';
}

export function Canvas() {
  const hosts = useHub((h) => h.hosts);
  const checkouts = useHub((h) => h.checkouts);
  const sessions = useHub((h) => h.sessions);
  const nodes = useHub((h) => h.nodes);
  const approvals = useHub((h) => h.approvals);
  const saved = useHub((h) => h.layout);
  const ready = useHub((h) => h.ready);
  const mode = useUI((u) => u.layoutMode);
  const expanded = useUI((u) => u.expanded);
  const search = useUI((u) => u.search);
  const filter = useUI((u) => u.filter);
  const panTo = useUI((u) => u.panTo);
  const phone = useIsPhone();

  const vpRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [vpEl, setVpEl] = useState<HTMLElement | null>(null);

  const attention = useMemo(() => {
    const a: Record<string, boolean> = {};
    Object.values(approvals).forEach((x) => { if (x.status === 'pending') a[x.session_id] = true; });
    return a;
  }, [approvals]);

  const G = useMemo(() => buildGraph({ hosts, checkouts, sessions, nodes, expanded, phone, attention }), [hosts, checkouts, sessions, nodes, expanded, phone, attention]);
  const auto = useMemo(() => autoLayout(mode === 'cluster' ? 'cluster' : 'columns', { hosts, checkouts, sessions, nodes, expanded, phone, attention }, G), [mode, G, hosts, checkouts, sessions, nodes, expanded, phone, attention]);

  const [local, setLocal] = useState<Record<string, { x: number; y: number }>>({});
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => { setLocal({}); }, [mode]);

  const pos = useMemo(() => {
    let p: Record<string, Box> = auto.pos;
    if (mode === 'custom') p = applySaved(p, G, saved);
    const out: Record<string, Box> = { ...p };
    Object.keys(local).forEach((id) => { if (out[id]) out[id] = { ...out[id], ...local[id] }; });
    if (drag && out[drag.id]) out[drag.id] = { ...out[drag.id], x: drag.x, y: drag.y };
    return out;
  }, [auto, mode, G, saved, local, drag]);
  const posRef = useRef(pos);
  posRef.current = pos;

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

  // pan to a requested node
  useEffect(() => {
    if (!panTo) return;
    const t = setTimeout(() => { const b = posRef.current[panTo.id]; if (b) centerOn(b, phone ? 0.5 : 0.8); }, 30);
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

  // ---- pointers: pan, node drag, pinch
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<null | { kind: 'pan' | 'node'; id?: string; sx: number; sy: number; ox: number; oy: number; vx: number; vy: number; moved: boolean }>(null);
  const pinch = useRef<null | { d: number; mx: number; my: number }>(null);
  const [panning, setPanning] = useState(false);

  const localXY = (e: { clientX: number; clientY: number }) => {
    const r = vpRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const begin = (e: React.PointerEvent, kind: 'pan' | 'node', id?: string) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const p = localXY(e);
    ptrs.current.set(e.pointerId, p);
    try { vpRef.current?.setPointerCapture(e.pointerId); } catch { /* */ }
    if (ptrs.current.size === 2) {
      const [a, b] = Array.from(ptrs.current.values());
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      gesture.current = null;
      setDrag(null);
      return;
    }
    const v = view.get();
    const b = id ? posRef.current[id] : null;
    gesture.current = { kind, id, sx: p.x, sy: p.y, ox: b ? b.x : 0, oy: b ? b.y : 0, vx: v.x, vy: v.y, moved: false };
    if (kind === 'pan') setPanning(true);
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
    if (g.kind === 'pan') view.set({ x: g.vx + dx, y: g.vy + dy });
    else if (g.id) {
      const z = view.get().z;
      setDrag({ id: g.id, x: Math.round(g.ox + dx / z), y: Math.round(g.oy + dy / z) });
    }
  };

  const end = (e: React.PointerEvent) => {
    ptrs.current.delete(e.pointerId);
    try { vpRef.current?.releasePointerCapture(e.pointerId); } catch { /* */ }
    if (ptrs.current.size < 2) pinch.current = null;
    const g = gesture.current;
    if (ptrs.current.size > 0) return;
    gesture.current = null;
    setPanning(false);
    if (!g) return;
    if (g.kind === 'node' && g.id) {
      if (g.moved && drag) {
        const id = g.id, x = drag.x, y = drag.y;
        setLocal((l) => ({ ...l, [id]: { x, y } }));
        setDrag(null);
        const b = posRef.current[id];
        hub.set((s) => ({ layout: { ...s.layout, [id]: { ...(s.layout[id] || {}), x, y, w: b?.w, h: b?.h } } }));
        api.layout({ nodeId: id, x, y, w: b?.w, h: b?.h, collapsed: !ui.get().expanded[id] }).catch(() => { /* offline: keep local */ });
      } else if (!g.moved) {
        setDrag(null);
        // click: expand a collapsed session
        if (hub.get().sessions[g.id] && !ui.get().expanded[g.id]) setExpanded(g.id, true);
        ui.set({ focusId: g.id });
      }
    } else if (g.kind === 'pan' && !g.moved) {
      ui.set({ focusId: null });
    }
  };

  // ---- opacity from search / compute filter
  const q = search.trim().toLowerCase();
  const opacityOf = useCallback((id: string, kind: string) => {
    let o = 1;
    if (q && !nodeText(id).toLowerCase().includes(q)) o = 0.15;
    if (filter) {
      let key = '';
      if (kind === 'session') key = computeKey(sessions[id]);
      else if (kind === 'checkout') key = checkouts[id]?.host_id;
      else key = nodes[id]?.hostId;
      if (key !== filter) o = Math.min(o, 0.18);
    }
    return o;
  }, [q, filter, sessions, checkouts, nodes]);

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
        onPointerDown={(e) => begin(e, 'pan')}
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerCancel={end}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div ref={worldRef} className="world" style={{ pointerEvents: panning || drag ? 'none' : undefined }}>
          <svg width="1" height="1" style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}>
            {G.edges.map((ed) => {
              const a = pos[ed.from], b = pos[ed.to];
              if (!a || !b) return null;
              const s = clipSeg(a, b);
              if (!s) return null;
              const fa = G.byId[ed.from], fb = G.byId[ed.to];
              const o = Math.min(opacityOf(ed.from, fa.kind), opacityOf(ed.to, fb.kind)) * (ed.op ?? 1);
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
            const s = n.kind === 'session' ? sessions[n.id] : null;
            const color = s ? computeColor(computeKey(s), hosts) : '';
            const loud = !!s && (s.status === 'waiting' || attention[s.id]);
            const running = !!s && !loud && s.status === 'running';
            const dragging = drag?.id === n.id;
            return (
              <div
                key={n.id}
                className={`node${dragging ? ' dragging' : ''}`}
                data-node={n.kind}
                style={{
                  left: p.x, top: p.y, width: p.w, height: p.h, opacity: opacityOf(n.id, n.kind),
                  zIndex: dragging ? 50 : ex && n.kind === 'session' ? 20 : loud ? 5 : 1, cursor: dragging ? 'grabbing' : 'grab',
                  transition: dragging ? 'none' : 'left .3s ease, top .3s ease, opacity .2s',
                }}
                onPointerDown={(e) => { e.stopPropagation(); begin(e, 'node', n.id); }}
              >
                {running ? <><span aria-hidden="true" className="halo" style={{ color }} /><span aria-hidden="true" className="ring" style={{ color }} /></> : null}
                {loud ? <span aria-hidden="true" className="loud" /> : null}
                {n.kind === 'checkout' ? <CheckoutNode co={checkouts[n.id]} host={hosts[checkouts[n.id].host_id]} sessionCount={sessionCount[n.id] || 0} /> : null}
                {n.kind === 'session' ? <SessionNode id={n.id} mode={ex && !phone ? 'expanded' : 'collapsed'} /> : null}
                {n.kind === 'app' ? <AppNode id={n.id} /> : null}
              </div>
            );
          })}
        </div>
        {ready && !G.nodes.length ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{ textAlign: 'center', color: '#8A8F98', fontSize: 13, lineHeight: 1.6 }}>No checkouts or sessions yet.<br />Use <b style={{ color: '#E7E8EA' }}>+ Add</b> to start a session.</div>
          </div>
        ) : null}
      </div>
      <BottomBar pos={pos} />
    </ViewportCtx.Provider>
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
