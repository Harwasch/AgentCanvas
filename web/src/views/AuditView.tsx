import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { hub, useHub } from '../store';

export function AuditView() {
  const audit = useHub((h) => h.audit);
  const nodes = useHub((h) => h.nodes);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [onlyBlocked, setOnlyBlocked] = useState(false);

  const load = () => {
    setLoading(true);
    api.audit().then((list) => { hub.set({ audit: list || [] }); setErr(null); }).catch((e) => setErr((e as Error).message)).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const rows = useMemo(() => audit.filter((a) => !onlyBlocked || !a.allowed), [audit, onlyBlocked]);
  return (
    <div className="scroll" style={{ position: 'absolute', inset: 0, overflow: 'auto', padding: '16px 16px 40px' }} data-testid="audit-view">
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 18, fontWeight: 600 }}>Audit</span>
          <span style={{ fontSize: 12, color: '#8A8F98', flex: 1 }}>App tool calls checked by the hub policy</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#C9CCD2' }}><input type="checkbox" checked={onlyBlocked} onChange={(e) => setOnlyBlocked(e.target.checked)} style={{ accentColor: '#E7E8EA' }} />Blocked only</label>
          <button className="b" onClick={load}>{loading ? 'Loading…' : 'Refresh'}</button>
        </div>
        {err ? <div style={{ color: '#FFB3B6', fontSize: 12.5, marginBottom: 10 }}>Could not load audit: {err}</div> : null}
        <div style={{ overflowX: 'auto' }} className="scroll">
          <table className="table" style={{ minWidth: 820 }}>
            <thead><tr><th>Time</th><th>App</th><th>Tool</th><th>Tier</th><th>Caller</th><th>Allowed</th><th>Reason</th><th>Args</th></tr></thead>
            <tbody>
              {rows.map((a) => {
                const t = typeof a.ts === 'number' ? new Date(a.ts < 1e12 ? a.ts * 1000 : a.ts) : new Date(a.ts);
                return (
                  <tr key={a.id} data-testid="audit-row">
                    <td className="mono" style={{ fontSize: 11.5, color: '#A3A7AF', whiteSpace: 'nowrap' }}>{Number.isNaN(t.getTime()) ? String(a.ts) : t.toLocaleTimeString()}</td>
                    <td>{nodes[a.app_node_id]?.title || <span className="mono" style={{ fontSize: 11.5 }}>{a.app_node_id}</span>}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{a.tool}</td>
                    <td><span style={{ fontSize: 10.5, fontWeight: 600, borderRadius: 5, padding: '1px 6px', ...(a.tier === 'actuate' ? { background: '#FFD23F', color: '#0B0C0E' } : { border: '1px solid #3A3E46', color: '#A3A7AF' }) }}>{a.tier}</span></td>
                    <td style={{ color: '#C9CCD2' }}>{a.caller}</td>
                    <td>{a.allowed ? <span style={{ color: '#43D1B0' }}>allowed</span> : <span style={{ color: '#FFB3B6' }}>blocked</span>}</td>
                    <td className="mono" style={{ fontSize: 11.5, color: '#A3A7AF' }}>{a.reason || '—'}</td>
                    <td className="mono ell" style={{ fontSize: 11, color: '#8A8F98', maxWidth: 240 }}>{a.args ? JSON.stringify(a.args) : ''}</td>
                  </tr>
                );
              })}
              {!rows.length && !loading ? <tr><td colSpan={8} style={{ color: '#8A8F98', padding: 24, textAlign: 'center' }}>No app tool calls recorded yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
