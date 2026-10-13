import { memo, useContext, useRef, useState } from 'react';
import { api } from '../api';
import { LIVE_ZOOM, useView } from '../canvas/view';
import { setExpanded, toast, ui, useHub, useUI } from '../store';
import type { AppNode as AppNodeT } from '../types';
import { Icon } from '../ui';
import { AppFrame } from './AppFrame';
import { ViewportCtx, useInView } from './common';

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

export { ViewportCtx };

export const STATUS_COLORS: Record<string, string> = { running: '#43D1B0', starting: '#FFD23F', stopped: '#8A8F98', error: '#E5484D' };

function AppNodeImpl({ id }: { id: string }) {
  const node = useHub((h) => h.nodes[id]);
  const host = useHub((h) => (node ? h.hosts[node.hostId] : undefined));
  const zoomLive = useView((v) => v.z >= LIVE_ZOOM);
  const focused = useUI((u) => u.focusId === id || !!u.expanded[id]);
  const root = useContext(ViewportCtx);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inView = useInView(bodyRef, root);
  const [reloadKey, setReloadKey] = useState(0);
  if (!node) return null;
  const mw = node.manifest?.node?.width || 640;
  const mh = node.manifest?.node?.height || 440;
  const live = (zoomLive || focused) && inView && !!node.url && node.status !== 'stopped';
  const promoted = node.state === 'promoted';
  const color = host?.color || '#8A8F98';

  const reload = async () => {
    try { await api.reload(node.id); setReloadKey((k) => k + 1); } catch (e) { toast(`Reload failed: ${(e as Error).message}`, 'error'); }
  };

  return (
    <div data-testid="app-node" data-node-id={node.id} data-state={node.state} data-live={live ? '1' : '0'}
      style={{ height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: '#121418', border: `1px solid ${color}55`, borderRadius: 14, display: 'flex', flexDirection: 'column', boxShadow: '0 10px 28px rgba(0,0,0,.4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px 0 12px', height: 40, flex: 'none', minWidth: 0 }}>
        <Icon name="app" size={15} sw={1.8} style={{ color: '#C9CCD2', flex: 'none' }} />
        <span className="ell" style={{ fontWeight: 600, fontSize: 13.5, flex: 1 }}>{node.title}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#C9CCD2', whiteSpace: 'nowrap' }}>
          <span className="dot" style={{ width: 7, height: 7, background: STATUS_COLORS[node.status] || '#8A8F98' }} />{node.status}
        </span>
        <span className="mono" style={{ fontSize: 11, color: '#A3A7AF', border: '1px solid #2E3138', borderRadius: 6, padding: '1px 6px' }}>v{node.version}</span>
        <span data-testid="app-state" title={promoted ? 'Promoted: actuate tools granted' : 'Preview: read-only tools only'}
          style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.04em', borderRadius: 5, padding: '2px 6px', whiteSpace: 'nowrap', ...(promoted ? { background: '#E7E8EA', color: '#0B0C0E' } : { color: '#FFD23F', border: '1px solid rgba(255,210,63,.5)' }) }}>
          {promoted ? 'PROMOTED' : 'PREVIEW'}
        </span>
        <button className="b ghost" style={{ height: 24, padding: '0 6px', fontSize: 11 }} onPointerDown={stop} onClick={reload}>Reload</button>
        <button className="b" style={{ height: 24, padding: '0 8px', fontSize: 11 }} onPointerDown={stop} data-testid="app-promote" onClick={() => ui.set({ promoteId: node.id })}>{promoted ? 'Review' : 'Promote'}</button>
        <button className="b ghost" style={{ width: 26, height: 26, padding: 0, justifyContent: 'center', flex: 'none' }} aria-label={focused ? 'Release live view' : 'Keep live'} title={focused ? 'Release live view' : 'Keep live at any zoom'} onPointerDown={stop} onClick={() => setExpanded(node.id, !focused)}>
          <Icon name="expand" />
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 12px 8px', background: '#0B0C0E', border: '1px solid #24272D', borderRadius: 7, padding: '0 8px', height: 26, boxSizing: 'border-box', flex: 'none', minWidth: 0 }}>
        <span className="mono" style={{ fontSize: 10, color: '#0B0C0E', background: color, borderRadius: 4, padding: '1px 5px' }}>MCP</span>
        <span className="mono ell" style={{ fontSize: 11, color: '#A3A7AF', flex: 1 }}>{node.manifest?.ui || `ui://${node.appId}/main`} · {host?.label || node.hostId}</span>
        {node.errors?.length ? <span style={{ fontSize: 10.5, color: '#FFB3B6' }} title={node.errors.join('\n')}>{node.errors.length} error{node.errors.length > 1 ? 's' : ''}</span> : null}
        <span style={{ fontSize: 10.5, color: '#6E727A' }}>sandboxed</span>
      </div>
      <div ref={bodyRef} onPointerDown={live ? stop : undefined} data-wheel={live ? 'inner' : undefined}
        style={{ position: 'relative', width: mw, height: mh, margin: '0 8px 8px', borderRadius: 10, overflow: 'hidden', background: '#0B0C0E', outline: '1px solid #1E2025', flex: 'none' }}>
        {!live ? (
          node.thumbnail ? <img src={node.thumbnail} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }} />
            : <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6E727A', fontSize: 12 }}>Zoom in to load the live app</div>
        ) : null}
        <AppFrame node={node} live={live} width={mw} height={mh} reloadKey={reloadKey} />
      </div>
    </div>
  );
}

export const AppNode = memo(AppNodeImpl);

/** `/?shot=<id>`: the app alone at manifest size, always live. */
export function ShotApp({ node }: { node: AppNodeT }) {
  const [ready, setReady] = useState(false);
  const mw = node.manifest?.node?.width || 640;
  const mh = node.manifest?.node?.height || 440;
  return (
    <div data-testid="app-node" data-node-id={node.id} data-state={node.state} data-app-ready={ready ? '1' : undefined}
      style={{ position: 'relative', width: mw, height: mh, overflow: 'hidden', background: '#0B0C0E' }}>
      <AppFrame node={node} live width={mw} height={mh} onReady={() => setTimeout(() => setReady(true), 300)} />
    </div>
  );
}
