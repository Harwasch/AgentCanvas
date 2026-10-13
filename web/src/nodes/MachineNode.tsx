// MACHINE: live CPU / memory / GPU / load for a host (or a managed cloud), agents on it, Terminal.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { focusNode, mergeLocal, toast, useHub } from '../store';
import { ProviderBadge, isActive } from '../ui';
import { Bar, Chevron, SheetBack, fmtGB, stop, type NodeMode } from './common';

// CPU history per machine for the sparkline (kept across re-mounts)
const hist = new Map<string, number[]>();

export async function openTerminal(hostId: string, opts: { parentId?: string; cwd?: string; sessionId?: string } = {}) {
  try {
    const c = await api.createCNode({ type: 'terminal', parentId: opts.parentId ?? hostId, data: { hostId, cwd: opts.cwd, sessionId: opts.sessionId } });
    mergeLocal('cnodes', c);
    setTimeout(() => focusNode(c.id), 80);
    return c;
  } catch (e) { toast(`Could not open a terminal: ${(e as Error).message}`, 'error'); return null; }
}

function MachineNodeImpl({ id, canvasId, mode }: { id: string; canvasId: string; mode: NodeMode }) {
  const m = useHub((h) => h.machines[id]);
  const sessions = useHub((h) => h.sessions);
  const devices = useHub((h) => h.devices);
  const [spark, setSpark] = useState<number[]>(() => hist.get(id) || []);
  const last = useRef<string | number | null>(null);
  useEffect(() => {
    if (!m?.cpu || last.current === m.updatedAt) return;
    last.current = m.updatedAt;
    const arr = [...(hist.get(id) || []), m.cpu.pct].slice(-28);
    hist.set(id, arr);
    setSpark(arr);
  }, [m?.updatedAt, m?.cpu, id]);
  const agents = useMemo(() => Object.values(sessions).filter((s) => isActive(s) && (m?.kind === 'cloud'
    ? s.kind === 'cloud' && (id === 'claude-cloud' ? s.vendor === 'claude' : s.vendor === 'codex')
    : s.kind === 'local' && s.host_id === id)), [sessions, id, m?.kind]);
  const nDev = useMemo(() => Object.values(devices).filter((d) => d.hostId === id).length, [devices, id]);
  if (!m) return null;
  const big = mode !== 'collapsed';
  const sheet = mode === 'sheet';
  const off = m.status === 'offline';
  const memPct = m.mem ? (m.mem.usedMB / Math.max(1, m.mem.totalMB)) * 100 : 0;
  const gpu = m.gpu?.[0];
  const kindLabel = m.kind === 'cloud' ? 'managed cloud' : off ? 'offline' : 'host';

  return (
    <div data-testid="machine-node" data-host-id={m.id} data-status={m.status}
      style={{
        height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: '#121418', border: sheet ? 0 : `1px solid ${m.color}${off ? '33' : '55'}`, borderRadius: sheet ? 0 : 14,
        padding: sheet ? '12px 14px calc(12px + env(safe-area-inset-bottom))' : '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, boxShadow: sheet ? 'none' : '0 8px 24px rgba(0,0,0,.3)', opacity: off ? 0.6 : 1,
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <SheetBack id={canvasId} mode={mode} />
        <span className="dot" style={{ width: 10, height: 10, background: m.color }} />
        <span className="ell" style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{m.label}</span>
        <span style={{ fontSize: 11, color: '#A3A7AF', whiteSpace: 'nowrap' }}>{kindLabel}</span>
        <Chevron id={canvasId} mode={mode} />
      </div>
      {m.cpu ? (
        <>
          <span style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 26, flex: 'none' }} aria-hidden="true">
            {Array.from({ length: 28 }, (_, i) => spark[spark.length - 28 + i]).map((v, i) => (
              <span key={i} style={{ flex: 1, borderRadius: 1, background: m.color, opacity: v == null ? 0.12 : 0.75, height: `${v == null ? 8 : Math.max(6, v)}%` }} />
            ))}
          </span>
          <span className="mono" style={{ display: 'flex', gap: 12, fontSize: 11, color: '#C9CCD2', flexWrap: 'wrap' }}>
            <span data-testid="machine-cpu" data-pct={m.cpu.pct}>CPU {Math.round(m.cpu.pct)}%</span>
            {m.mem ? <span>MEM {fmtGB(m.mem.usedMB)}/{fmtGB(m.mem.totalMB)}</span> : null}
            <span>{gpu ? `GPU ${Math.round(gpu.utilPct)}%` : 'no GPU'}</span>
            <span style={{ marginLeft: 'auto', color: '#8A8F98' }}>{agents.length} agent{agents.length === 1 ? '' : 's'}</span>
          </span>
        </>
      ) : (
        <span style={{ fontSize: 12, color: '#8A8F98' }}>{m.kind === 'cloud' ? 'Vendor-managed VMs · logs only, no shell' : off ? 'Host offline' : 'No metrics yet'} · {agents.length} agent{agents.length === 1 ? '' : 's'}</span>
      )}
      {big ? (
        <div className="scroll" data-wheel="inner" onPointerDown={stop} style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid #24272D', paddingTop: 10 }}>
          {m.cpu ? (
            <div className="mono" style={{ display: 'grid', gridTemplateColumns: '44px minmax(0,1fr) 116px', gap: '6px 10px', alignItems: 'center', fontSize: 11 }}>
              <span style={{ color: '#8A8F98' }}>CPU</span><Bar pct={m.cpu.pct} color={m.color} h={7} /><span style={{ textAlign: 'right' }}>{Math.round(m.cpu.pct)}% · {m.cpu.cores}c</span>
              {m.mem ? <><span style={{ color: '#8A8F98' }}>MEM</span><Bar pct={memPct} color={m.color} h={7} /><span style={{ textAlign: 'right' }}>{fmtGB(m.mem.usedMB)} / {fmtGB(m.mem.totalMB)}</span></> : null}
              {m.gpu.map((g, i) => (
                <span key={i} style={{ display: 'contents' }}>
                  <span style={{ color: '#8A8F98' }} className="ell" title={g.name}>GPU{m.gpu.length > 1 ? i : ''}</span><Bar pct={g.utilPct} color={m.color} h={7} /><span style={{ textAlign: 'right' }}>{Math.round(g.utilPct)}% · {fmtGB(g.memUsedMB)}/{fmtGB(g.memTotalMB)}</span>
                </span>
              ))}
              {m.load != null ? <><span style={{ color: '#8A8F98' }}>LOAD</span><span>{m.load.toFixed(2)}</span><span /></> : null}
            </div>
          ) : null}
          {m.gpu.length ? <span className="ell" style={{ fontSize: 11.5, color: '#8A8F98' }}>{m.gpu.map((g) => g.name).join(', ')}</span> : null}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="cap">Agents · {agents.length}</span>
            {agents.map((s) => (
              <button key={s.id} className="pi" style={{ padding: '4px 6px' }} onClick={() => focusNode(s.id, true)}>
                <ProviderBadge vendor={s.vendor} size={16} /><span className="ell" style={{ flex: 1, fontSize: 12 }}>{s.title}</span><span style={{ fontSize: 11, color: '#8A8F98' }}>{s.status}</span>
              </button>
            ))}
            {!agents.length ? <span style={{ fontSize: 12, color: '#6E727A' }}>No active agents.</span> : null}
          </div>
          {nDev ? <span style={{ fontSize: 12, color: '#8A8F98' }}>{nDev} device{nDev === 1 ? '' : 's'} attached</span> : null}
        </div>
      ) : null}
      {m.kind === 'host' ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: big ? 0 : 'auto', flex: 'none' }} onPointerDown={stop}>
          {m.load != null && !big ? <span className="mono" style={{ fontSize: 11, color: '#8A8F98', flex: 1 }}>load {m.load.toFixed(2)}</span> : <span style={{ flex: 1 }} />}
          <button className="b" style={{ height: 24, fontSize: 11.5 }} data-testid="terminal-open" disabled={off} onClick={() => openTerminal(m.id)}>
            <span className="mono" style={{ fontSize: 10.5 }}>&gt;_</span>Terminal
          </button>
        </div>
      ) : null}
    </div>
  );
}

export const MachineNode = memo(MachineNodeImpl);
