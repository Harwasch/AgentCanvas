import { memo, useState } from 'react';
import { api } from '../api';
import { toast, ui } from '../store';
import type { Checkout, Host } from '../types';
import { Icon, shortSha, timeAgo } from '../ui';

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

function CheckoutNodeImpl({ co, host, sessionCount }: { co: Checkout; host?: Host; sessionCount: number }) {
  const [busy, setBusy] = useState<string | null>(null);
  const publish = async (dir: string) => {
    setBusy(dir);
    try { await api.publishApp(co.host_id, dir); toast('Published as a preview'); } catch (e) { toast(`Publish failed: ${(e as Error).message}`, 'error'); }
    setBusy(null);
  };
  return (
    <div data-testid="checkout-node" data-checkout-id={co.id} style={{ height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: '#15171B', border: '1px solid #2E3138', borderRadius: 16, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 9, boxShadow: '0 10px 30px rgba(0,0,0,.35)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <Icon name="repo" size={17} sw={1.6} style={{ color: '#C9CCD2', flex: 'none' }} />
        <div className="ell" style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', flex: 1 }}>{co.repoName}</div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#C9CCD2', border: `1px solid ${(host?.color || '#8A8F98')}55`, borderRadius: 999, padding: '2px 9px', flex: 'none' }}>
          <span className="dot" style={{ width: 7, height: 7, background: host?.color || '#8A8F98' }} />{host?.label || co.host_id}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span className="mono ell" style={{ fontSize: 11.5, color: '#E7E8EA', border: '1px solid #3A3E46', borderRadius: 6, padding: '2px 7px', display: 'inline-flex', gap: 6, alignItems: 'center', maxWidth: '60%' }}>
          <Icon name="branch" size={11} sw={1.8} style={{ color: '#A3A7AF', flex: 'none' }} />{co.branch || '(detached)'}
        </span>
        <span className="ell" style={{ fontSize: 11.5, color: '#8A8F98', flex: 1 }}><span className="mono">@ {shortSha(co.head)}</span> · {co.head_subject}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, borderTop: '1px solid #24272D', paddingTop: 9 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span style={{ fontSize: 11, color: '#8A8F98' }}>Working tree</span><span className="mono" style={{ fontSize: 13, color: co.dirty ? '#FFD23F' : '#E7E8EA' }}>{co.dirty ? `${co.dirty} dirty` : 'clean'}</span></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span style={{ fontSize: 11, color: '#8A8F98' }}>Upstream</span><span className="mono" style={{ fontSize: 13 }}>↑{co.ahead || 0} ↓{co.behind || 0}</span></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span style={{ fontSize: 11, color: '#8A8F98' }}>Updated</span><span className="mono" style={{ fontSize: 13 }}>{timeAgo(co.head_time || co.updated_at) || '—'}</span></div>
      </div>
      {co.apps?.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="cap">Apps found</span>
          {co.apps.slice(0, 4).map((a) => (
            <div key={a.dir} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 26 }}>
              <Icon name="app" size={13} sw={1.8} style={{ color: '#8A8F98', flex: 'none' }} />
              <span className="ell" style={{ fontSize: 12.5, flex: 1 }}>{a.title} <span className="mono" style={{ fontSize: 10.5, color: '#6E727A' }}>{a.dir}</span></span>
              {a.published ? (
                <span style={{ fontSize: 11, color: '#8A8F98' }}>published</span>
              ) : (
                <button className="b" style={{ height: 24, fontSize: 11.5 }} onPointerDown={stop} disabled={busy === a.dir} onClick={() => publish(a.dir)} data-testid="app-publish">
                  {busy === a.dir ? 'Publishing…' : 'Publish'}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 'auto' }}>
        <span style={{ color: '#8A8F98', fontSize: 12, flex: 1 }}>{sessionCount} session{sessionCount === 1 ? '' : 's'}</span>
        <button className="b" style={{ height: 26 }} onPointerDown={stop} onClick={() => ui.set({ tab: 'repos', repoCheckout: co.id })}>Repo browser</button>
        <button className="b" style={{ height: 26 }} onPointerDown={stop} onClick={() => ui.set({ spawnOpen: true, spawnPreset: { checkoutId: co.id } })}>New session</button>
      </div>
    </div>
  );
}

export const CheckoutNode = memo(CheckoutNodeImpl);
