// Shared bits for canvas nodes: level of detail, chrome pieces, small helpers.
import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../api';
import { LIVE_ZOOM, useView } from '../canvas/view';
import { hub, setExpanded, toast, ui, useHub, useUI } from '../store';
import type { Session } from '../types';
import { Icon } from '../ui';

export type NodeMode = 'collapsed' | 'expanded' | 'sheet';

export const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/** The canvas viewport element (IntersectionObserver root). */
export const ViewportCtx = createContext<HTMLElement | null>(null);

export function useInView(ref: React.RefObject<HTMLElement>, root: HTMLElement | null) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setInView(true); return; }
    const io = new IntersectionObserver((es) => es.forEach((e) => setInView(e.isIntersecting)), { root, rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, root]);
  return inView;
}

/** Live (heavy) rendering: zoomed in past LIVE_ZOOM or focused/expanded, and on screen. Sheets are always live. */
export function useLive(ref: React.RefObject<HTMLElement>, canvasId: string, mode: NodeMode) {
  const zoomLive = useView((v) => v.z >= LIVE_ZOOM);
  const focused = useUI((u) => u.focusId === canvasId || !!u.expanded[canvasId]);
  const root = useContext(ViewportCtx);
  const inView = useInView(ref, mode === 'sheet' ? null : root);
  return mode === 'sheet' || ((zoomLive || focused) && inView);
}

export function Chevron({ id, mode, label }: { id: string; mode: NodeMode; label?: string }) {
  if (mode === 'sheet') return null;
  const big = mode !== 'collapsed';
  return (
    <button className="b ghost" style={{ width: 26, height: 26, padding: 0, justifyContent: 'center', flex: 'none' }} aria-label={label || (big ? 'Collapse' : 'Expand')}
      data-testid="node-chevron" onPointerDown={stop} onClick={() => setExpanded(id, !big)}>
      <Icon name="chev" style={{ transform: `rotate(${big ? 180 : 0}deg)`, transition: 'transform .2s' }} />
    </button>
  );
}

export function SheetBack({ id, mode }: { id: string; mode: NodeMode }) {
  if (mode !== 'sheet') return null;
  return <button className="b ghost" style={{ width: 30, padding: 0, justifyContent: 'center', flex: 'none' }} aria-label="Back to canvas" onClick={() => setExpanded(id, false)}><Icon name="back" /></button>;
}

export function RemoveBtn({ id, label = 'Remove from canvas' }: { id: string; label?: string }) {
  return (
    <button className="x" aria-label={label} title={label} data-testid="node-remove" onPointerDown={stop}
      onClick={() => api.deleteCNode(id).then(() => hub.set((s) => { const c = { ...s.cnodes }; delete c[id]; return { cnodes: c }; })).catch((e) => toast(`Remove failed: ${(e as Error).message}`, 'error'))}>
      <Icon name="x" size={10} />
    </button>
  );
}

/** Node frame: rounded card, used by most v2 nodes. */
export function Frame({ children, mode, style, testid, attrs }: {
  children: ReactNode; mode: NodeMode; style?: CSSProperties; testid: string; attrs?: Record<string, string | undefined>;
}) {
  const sheet = mode === 'sheet';
  return (
    <div data-testid={testid} {...attrs}
      style={{
        height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: '#15171B', border: sheet ? 0 : '1px solid #2A2D33',
        borderRadius: sheet ? 0 : 14, padding: sheet ? '12px 14px calc(12px + env(safe-area-inset-bottom))' : '12px 14px', display: 'flex', flexDirection: 'column', gap: 8,
        boxShadow: sheet ? 'none' : '0 8px 24px rgba(0,0,0,.3)', position: 'relative', ...style,
      }}>
      {children}
    </div>
  );
}

export function FolderChip({ path }: { path: string }) {
  const top = path.includes('/') ? path.split('/')[0] : '/';
  const human = !/^(ai|\.)/i.test(top);
  return <span className="mono" style={{ border: `1px solid ${human ? '#5A5E67' : '#3A3E46'}`, color: human ? '#C9CCD2' : '#8A8F98', borderRadius: 4, padding: '0 4px', fontSize: 10.5, flex: 'none' }}>{top}</span>;
}

export const sessionTitle = (s?: Session | null) => (s ? s.title || '(untitled session)' : '');
export function useSessionTitle(id: string | null | undefined) {
  return useHub((h) => (id && h.sessions[id] ? h.sessions[id].title || '(untitled session)' : ''));
}

export const fmtGB = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)}G` : `${Math.round(mb)}M`);

export function Bar({ pct, color, h = 4, bg = '#24272D' }: { pct: number; color: string; h?: number; bg?: string }) {
  return (
    <span style={{ flex: 1, height: h, background: bg, borderRadius: h, overflow: 'hidden', display: 'block', minWidth: 20 }}>
      <span style={{ display: 'block', height: h, width: `${Math.max(0, Math.min(100, pct))}%`, background: color, transition: 'width .4s' }} />
    </span>
  );
}

/** Open the spawn dialog prefilled (from branch / project / suggestion actions). */
export function openSpawn(preset: { checkoutId?: string; branch?: string; prompt?: string; hostId?: string }) {
  ui.set({ spawnOpen: true, spawnPreset: preset });
}
