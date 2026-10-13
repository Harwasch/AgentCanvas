// Pieces shared by project and branch nodes and the repo browser: PR / CI chips, worktree list.
import { useState } from 'react';
import { api } from '../api';
import { toast, useHub } from '../store';
import type { Branch, Checkout } from '../types';
import { Icon, shortSha } from '../ui';
import { stop } from './common';

export const CI_LABEL: Record<string, string> = { success: 'passing', failure: 'failing', pending: 'pending', none: 'no CI' };
export const CI_COLOR: Record<string, string> = { success: '#43D1B0', failure: '#E5484D', pending: '#FFD23F', none: '#5A5E67' };
export const PR_COLOR: Record<string, string> = { open: '#43D1B0', draft: '#8A8F98', merged: '#A48BFA', closed: '#E5484D' };

export function PrChip({ pr }: { pr: Branch['pr'] }) {
  if (!pr) return <span data-testid="branch-pr" data-state="none" style={{ fontSize: 11, color: '#6E727A', border: '1px dashed #2E3138', borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap' }}>no PR</span>;
  const r = pr.reviews || { approved: 0, changesRequested: 0, commented: 0 };
  const rv = [r.approved ? `✓${r.approved}` : '', r.changesRequested ? `✕${r.changesRequested}` : '', r.commented ? `💬${r.commented}` : ''].filter(Boolean).join(' ');
  return (
    <a className="lnk" data-testid="branch-pr" data-state={pr.state} href={pr.url} target="_blank" rel="noopener noreferrer" onPointerDown={stop} title={pr.title}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#C9CCD2', border: `1px solid ${PR_COLOR[pr.state] || '#3A3E46'}66`, borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap' }}>
      <span className="dot" style={{ width: 7, height: 7, background: PR_COLOR[pr.state] || '#8A8F98' }} />
      <span className="mono">#{pr.number}</span> · {pr.state}{rv ? <span className="mono" style={{ color: '#A3A7AF' }}> · {rv}</span> : null}
    </a>
  );
}

export function CiChip({ ci }: { ci: Branch['ci'] }) {
  const st = ci?.state || 'none';
  const inner = (
    <>
      {st === 'pending' ? <span className="spin" style={{ width: 9, height: 9 }} /> : <span className="dot" style={{ width: 7, height: 7, background: CI_COLOR[st] }} />}
      {st === 'none' ? 'no CI' : `CI ${CI_LABEL[st]}`}{ci && ci.total ? <span className="mono" style={{ color: '#A3A7AF' }}> {ci.passed}/{ci.total}</span> : null}
    </>
  );
  const style = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#C9CCD2', border: `1px solid ${CI_COLOR[st]}55`, borderRadius: 999, padding: '1px 8px', whiteSpace: 'nowrap' as const };
  return ci?.url
    ? <a className="lnk" data-testid="branch-ci" data-state={st} href={ci.url} target="_blank" rel="noopener noreferrer" onPointerDown={stop} style={style}>{inner}</a>
    : <span data-testid="branch-ci" data-state={st} style={style}>{inner}</span>;
}

/** "worktrees: mini-1 ~/code/… (branch)" with dirty state; optional checkout apps with Publish. */
export function Worktrees({ ids, showBranch = true, showApps = false, max = 3 }: { ids: string[]; showBranch?: boolean; showApps?: boolean | ((co: Checkout) => boolean); max?: number }) {
  const checkouts = useHub((h) => h.checkouts);
  const hosts = useHub((h) => h.hosts);
  const list = ids.map((i) => checkouts[i]).filter(Boolean) as Checkout[];
  const [busy, setBusy] = useState<string | null>(null);
  if (!list.length) return null;
  const publish = async (co: Checkout, dir: string) => {
    setBusy(co.id + dir);
    try { await api.publishApp(co.host_id, dir); toast('Published as a preview'); } catch (e) { toast(`Publish failed: ${(e as Error).message}`, 'error'); }
    setBusy(null);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 'none' }} data-testid="worktrees">
      {list.slice(0, max).map((co, i) => (
        <div key={co.id} style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <div className="mono" data-testid="worktree" data-checkout-id={co.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#A3A7AF', minWidth: 0 }}>
            <span style={{ color: '#6E727A', width: i ? undefined : undefined, flex: 'none' }}>{i ? '' : 'worktrees:'}</span>
            <span className="dot" style={{ width: 7, height: 7, background: hosts[co.host_id]?.color || '#8A8F98' }} />
            <span style={{ color: '#E7E8EA', flex: 'none' }}>{hosts[co.host_id]?.label || co.host_id}</span>
            <span className="ell" title={co.path}>{co.path}</span>
            {showBranch ? <span className="ell" style={{ color: '#8A8F98', maxWidth: 140 }}>({co.branch || 'detached'})</span> : null}
            <span style={{ marginLeft: 'auto', flex: 'none', color: co.dirty ? '#FFD23F' : '#6E727A' }}>{co.dirty ? `${co.dirty} dirty` : `@ ${shortSha(co.head)}`}</span>
          </div>
          {(typeof showApps === 'function' ? showApps(co) : showApps) ? co.apps?.slice(0, 3).map((a) => (
            <div key={a.dir} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 24, paddingLeft: 12 }}>
              <Icon name="app" size={12} sw={1.8} style={{ color: '#8A8F98', flex: 'none' }} />
              <span className="ell" style={{ fontSize: 12, flex: 1 }}>{a.title} <span className="mono" style={{ fontSize: 10.5, color: '#6E727A' }}>{a.dir}</span></span>
              {a.published ? <span style={{ fontSize: 11, color: '#8A8F98' }}>published</span> : (
                <button className="b" style={{ height: 22, fontSize: 11 }} onPointerDown={stop} disabled={busy === co.id + a.dir} onClick={() => publish(co, a.dir)} data-testid="app-publish">
                  {busy === co.id + a.dir ? 'Publishing…' : 'Publish'}
                </button>
              )}
            </div>
          )) : null}
        </div>
      ))}
      {list.length > max ? <span style={{ fontSize: 11, color: '#6E727A' }}>+{list.length - max} more</span> : null}
    </div>
  );
}
