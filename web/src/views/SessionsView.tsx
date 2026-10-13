import { useMemo, useState } from 'react';
import { api } from '../api';
import { focusNode, toast, useHub } from '../store';
import type { Session } from '../types';
import { ProviderBadge, StatusPill, computeColor, computeKey, computeName, timeAgo } from '../ui';
import { nativeLabel } from '../nodes/SessionNode';

export function SessionsView() {
  const sessions = useHub((h) => h.sessions);
  const hosts = useHub((h) => h.hosts);
  const accounts = useHub((h) => h.accounts);
  const checkouts = useHub((h) => h.checkouts);
  const approvals = useHub((h) => h.approvals);
  // ended sessions past the hub's retention.stateEndedDays are not in the snapshot; they load on request
  const [archived, setArchived] = useState<Session[] | null>(null);
  const [loadingOld, setLoadingOld] = useState(false);
  const list = useMemo(() => {
    const live = Object.values(sessions).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return archived ? [...live, ...archived.filter((x) => !sessions[x.id])] : live;
  }, [sessions, archived]);
  const loadOld = async () => {
    setLoadingOld(true);
    try {
      const more = await api.sessionsArchive(archived?.length ? Number(archived[archived.length - 1].updated_at) : undefined);
      setArchived((a) => [...(a || []), ...more]);
      if (!more.length) toast('No older ended sessions');
    } catch (e) { toast(`Could not load older sessions: ${(e as Error).message}`, 'error'); }
    setLoadingOld(false);
  };
  const pending = useMemo(() => {
    const p: Record<string, number> = {};
    Object.values(approvals).forEach((a) => { if (a.status === 'pending') p[a.session_id] = (p[a.session_id] || 0) + 1; });
    return p;
  }, [approvals]);
  return (
    <div className="scroll" style={{ position: 'absolute', inset: 0, overflow: 'auto', padding: '16px 16px 40px' }} data-testid="sessions-view">
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 18, fontWeight: 600 }}>Sessions</span>
          <span style={{ fontSize: 12, color: '#8A8F98' }}>{list.length} total · click a row to open it on the canvas</span>
        </div>
        <div style={{ overflowX: 'auto' }} className="scroll">
          <table className="table" style={{ minWidth: 760 }}>
            <thead><tr><th>Session</th><th>Where</th><th>Account</th><th>Repo / branch</th><th>Status</th><th>Updated</th><th>Native</th></tr></thead>
            <tbody>
              {list.map((s) => {
                const key = computeKey(s);
                const co = s.checkout_id ? checkouts[s.checkout_id] : undefined;
                const waiting = s.status === 'waiting' || pending[s.id];
                return (
                  <tr key={s.id} className={sessions[s.id] ? 'click' : undefined} data-testid="session-row" data-session-id={s.id} onClick={() => { if (sessions[s.id]) focusNode(s.id, true); }} style={{ boxShadow: waiting ? 'inset 3px 0 0 #FFD23F' : undefined, opacity: sessions[s.id] ? 1 : 0.6 }}>
                    <td><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ProviderBadge vendor={s.vendor} /><span className="ell" style={{ maxWidth: 300, fontWeight: 500 }}>{s.title || '(untitled)'}</span></span></td>
                    <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}><span className="dot" style={{ background: computeColor(key, hosts) }} />{computeName(key, hosts)}</span></td>
                    <td style={{ color: '#C9CCD2' }}>{accounts[s.account_id]?.label || s.account_id}</td>
                    <td><span className="mono" style={{ fontSize: 11.5 }}>{co?.repoName || '—'}</span>{s.branch ? <span className="mono" style={{ fontSize: 11.5, color: '#8A8F98' }}> · {s.branch}</span> : null}</td>
                    <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12 }}><StatusPill status={waiting ? 'waiting' : s.status} onClick={() => focusNode(s.id, true)} /></span></td>
                    <td style={{ color: '#8A8F98', whiteSpace: 'nowrap' }}>{timeAgo(s.updated_at)}</td>
                    <td>{s.native_url ? <a className="b lnk" style={{ height: 24, fontSize: 11.5 }} href={s.native_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{nativeLabel(s)} ↗</a> : <span style={{ color: '#6E727A' }}>—</span>}</td>
                  </tr>
                );
              })}
              {!list.length ? <tr><td colSpan={7} style={{ color: '#8A8F98', padding: 24, textAlign: 'center' }}>No sessions yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 12 }}>
          <button className="b" disabled={loadingOld} data-testid="sessions-older" onClick={() => void loadOld()}>{archived ? 'Load more ended sessions' : 'Show older ended sessions'}</button>
        </div>
      </div>
    </div>
  );
}
