// TERMINAL: a real shell on a host (tmux-backed). xterm is mounted only while live (LOD);
// otherwise the last lines seen are shown as text.
import { memo, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { hub, toast, useHub } from '../store';
import type { CNode, TerminalData } from '../types';
import { Chevron, RemoveBtn, SheetBack, stop, useLive, type NodeMode } from './common';
import type { TermStatus, XtermHandle } from './xtermView';

const lastLines = new Map<string, string[]>();

function TerminalNodeImpl({ id, mode }: { id: string; mode: NodeMode }) {
  const node = useHub((h) => h.cnodes[id]) as CNode<TerminalData> | undefined;
  const host = useHub((h) => (node ? h.hosts[node.data.hostId] : undefined));
  const sessTitle = useHub((h) => (node?.data.sessionId ? h.sessions[node.data.sessionId]?.title : ''));
  const outerRef = useRef<HTMLDivElement>(null);
  const termEl = useRef<HTMLDivElement>(null);
  const handle = useRef<XtermHandle | null>(null);
  const live = useLive(outerRef, id, mode);
  const closed = node?.data.status === 'closed';
  const [status, setStatus] = useState<TermStatus>('connecting');
  const [lines, setLines] = useState<string[]>(() => lastLines.get(id) || []);

  useEffect(() => {
    if (!live || closed || !termEl.current) return;
    let alive = true;
    const el = termEl.current;
    import('./xtermView').then((m) => {
      if (!alive) return;
      handle.current = m.mountXterm(el, id, {
        onStatus: (s) => { if (alive) setStatus(s); },
        shouldReconnect: () => hub.get().cnodes[id]?.data?.status !== 'closed',
        fontSize: mode === 'collapsed' ? 11.5 : 12.5,
      });
    }).catch((e) => toast(`Terminal failed to load: ${(e as Error).message}`, 'error'));
    return () => {
      alive = false;
      const h = handle.current;
      handle.current = null;
      if (h) { const l = h.dispose(); if (l.length) { lastLines.set(id, l); setLines(l); } }
    };
  }, [live, closed, id, mode]);

  if (!node) return null;
  const d = node.data;
  const color = host?.color || '#8A8F98';
  const sheet = mode === 'sheet';
  const close = async () => {
    try { handle.current?.dispose(); handle.current = null; await api.closeTerminal(id); } catch (e) { toast(`Close failed: ${(e as Error).message}`, 'error'); }
  };
  const note = closed ? 'closed' : !live ? 'tmux · zoom in to attach' : status === 'open' ? 'tmux · live' : status === 'reconnecting' ? 'reconnecting…' : status === 'closed' ? 'disconnected' : 'connecting…';

  return (
    <div ref={outerRef} data-testid="terminal-node" data-node-id={id} data-live={live && !closed ? '1' : '0'} data-status={closed ? 'closed' : status}
      style={{ height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: '#08090A', border: sheet ? 0 : `1px solid ${closed ? '#24272D' : color + '55'}`, borderRadius: sheet ? 0 : 14, display: 'flex', flexDirection: 'column', paddingBottom: sheet ? 'env(safe-area-inset-bottom)' : 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px 7px 12px', borderBottom: '1px solid #1E2025', minWidth: 0, flex: 'none' }}>
        <SheetBack id={id} mode={mode} />
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#A3A7AF" strokeWidth="2" aria-hidden="true" style={{ flex: 'none' }}><path d="M5 7l5 5-5 5M12 17h7" /></svg>
        <span className="dot" style={{ width: 8, height: 8, background: closed ? '#5A5E67' : color }} />
        <span className="mono ell" style={{ fontSize: 11.5, color: '#C9CCD2', flex: 1 }} title={sessTitle ? `shell for ${sessTitle}` : undefined}>{host?.label || d.hostId}:{d.cwd || '~'}{sessTitle ? ` · ${sessTitle}` : ''}</span>
        <span style={{ fontSize: 10.5, color: '#8A8F98', whiteSpace: 'nowrap' }}>{note}</span>
        {!closed ? <button className="b ghost" style={{ height: 22, fontSize: 11, padding: '0 6px' }} data-testid="terminal-close" onPointerDown={stop} onClick={close}>Close</button> : <RemoveBtn id={id} />}
        <Chevron id={id} mode={mode} />
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }} onPointerDown={live && !closed ? stop : undefined} data-wheel={live && !closed ? 'inner' : undefined}>
        {live && !closed ? (
          <div ref={termEl} data-testid="terminal-xterm" style={{ position: 'absolute', inset: '6px 4px 4px 10px' }} onClick={() => handle.current?.focus()} />
        ) : (
          <div className="mono" style={{ position: 'absolute', inset: 0, padding: '8px 12px', fontSize: 11.5, lineHeight: 1.45, color: '#C9CCD2', overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', whiteSpace: 'pre', userSelect: 'text' }}>
            {lines.length ? lines.slice(-14).map((l, i) => <span key={i}>{l || ' '}</span>) : <span style={{ color: '#6E727A' }}>{closed ? 'Shell closed.' : 'Zoom in or focus to attach to the shell.'}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export const TerminalNode = memo(TerminalNodeImpl);
