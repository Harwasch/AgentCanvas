// Promote review modal, actuate confirm dialog, toasts, token prompt.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast, ui, useHub, useUI } from '../store';
import type { Review } from '../types';
import { Icon, shortSha } from '../ui';

export function PromoteModal() {
  const id = useUI((u) => u.promoteId);
  const node = useHub((h) => (id ? h.nodes[id] : undefined));
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReview(null); setError(null); setFile(0); setBusy(false);
    if (!id) return;
    let alive = true;
    api.review(id).then((r) => { if (alive) setReview(r); }).catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [id]);

  if (!id || !node) return null;
  const close = () => ui.set({ promoteId: null });
  const dirty = review?.dirtyFiles || [];
  const grant = async () => {
    if (!review) return;
    setBusy(true);
    try {
      await api.promote(node.id, {
        commit: review.candidateCommit, grantActuate: true, reviewHash: review.reviewHash,
        ...(dirty.length ? { commitDirty: true } : {}),
      });
      toast(`${node.title} promoted · actuate granted`);
      close();
    } catch (e) {
      toast(`Promote refused: ${(e as Error).message}`, 'error');
      setBusy(false);
    }
  };
  const tools = review ? Object.entries(review.tools || {}) : [];
  const sf = review?.serverFiles?.[file];

  return (
    <div className="modal-back" onPointerDown={close}>
      <div className="modal" role="dialog" aria-label="Promote app" data-testid="promote-modal" style={{ width: 720 }} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="shield" size={16} sw={1.8} style={{ color: '#C9CCD2' }} />
          <span style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>Review & promote · {node.title}</span>
          <button className="x" aria-label="Close" onClick={close}><Icon name="x" size={12} /></button>
        </div>
        <span style={{ fontSize: 12, color: '#A3A7AF', marginTop: -8, lineHeight: 1.45 }}>
          Promoting pins the app to a commit and grants its <b style={{ color: '#E7E8EA' }}>actuate</b> tools. Confirm-tier tools still ask you before every call.
        </span>
        {error ? <div style={{ color: '#FFB3B6', fontSize: 12.5 }}>Could not load review: {error}</div> : null}
        {!review && !error ? <div style={{ color: '#8A8F98', fontSize: 12.5 }}>Loading review…</div> : null}
        {review ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              <div className="card" style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}><span className="cap">Candidate commit</span><span className="mono" data-testid="promote-commit" style={{ fontSize: 13 }}>{shortSha(review.candidateCommit)}</span></div>
              <div className="card" style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}><span className="cap">Version</span><span className="mono" style={{ fontSize: 13 }}>v{review.version}</span></div>
              <div className="card" style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}><span className="cap">Lifecycle</span><span className="mono" style={{ fontSize: 13 }}>{review.lifecycle || '—'}</span></div>
            </div>
            {dirty.length ? (
              <div style={{ border: '1px solid rgba(255,210,63,.5)', background: 'rgba(255,210,63,.06)', borderRadius: 10, padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 5 }} data-testid="promote-dirty">
                <span style={{ fontSize: 12, color: '#FFD23F', fontWeight: 600 }}>{dirty.length} uncommitted app file{dirty.length > 1 ? 's' : ''} — they will be committed exactly as reviewed, then pinned</span>
                {dirty.map((f) => <span key={f} className="mono" style={{ fontSize: 11.5, color: '#E7E8EA' }}>M {f}</span>)}
              </div>
            ) : null}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="cap">Tools</span>
              <div className="card" style={{ overflow: 'hidden' }}>
                <table className="table" style={{ fontSize: 12 }}>
                  <thead><tr><th>Tool</th><th>Tier</th><th>Confirm</th><th>Max / min</th></tr></thead>
                  <tbody>
                    {tools.map(([name, t]) => (
                      <tr key={name}>
                        <td className="mono">{name}</td>
                        <td><span style={{ fontSize: 10.5, fontWeight: 600, borderRadius: 5, padding: '1px 6px', ...(t.tier === 'actuate' ? { background: '#FFD23F', color: '#0B0C0E' } : { border: '1px solid #3A3E46', color: '#A3A7AF' }) }}>{t.tier}</span></td>
                        <td>{t.confirm ? 'yes' : 'no'}</td>
                        <td className="mono">{t.maxPerMinute ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                <span className="cap" style={{ marginRight: 6 }}>Server source</span>
                {(review.serverFiles || []).map((f, i) => (
                  <button key={f.path} className={`b${i === file ? '' : ' ghost'} mono`} style={{ height: 24, fontSize: 11 }} onClick={() => setFile(i)}>{f.path}</button>
                ))}
              </div>
              {sf ? <pre className="mono scroll" style={{ margin: 0, background: '#0B0C0E', border: '1px solid #24272D', borderRadius: 10, padding: '10px 12px', fontSize: 11.5, lineHeight: 1.6, color: '#C9CCD2', maxHeight: 260, overflow: 'auto', userSelect: 'text' }}>{sf.content}</pre> : null}
            </div>
          </>
        ) : null}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button className="b" style={{ height: 32 }} onClick={close}>Cancel</button>
          <button className="b bp" style={{ height: 32 }} disabled={!review || busy} data-testid="promote-grant" onClick={grant}>
            {busy ? 'Promoting…' : dirty.length ? 'Commit & pin · grant actuate' : 'Pin & grant actuate'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDialog() {
  const c = useUI((u) => u.confirm);
  if (!c) return null;
  const done = (ok: boolean) => { ui.set({ confirm: null }); c.resolve(ok); };
  let args = '';
  try { args = JSON.stringify(c.args ?? {}, null, 2); } catch { args = String(c.args); }
  return (
    <div className="modal-back" style={{ zIndex: 400 }} onPointerDown={() => done(false)}>
      <div className="modal" role="alertdialog" aria-label="Confirm tool call" data-testid="confirm-dialog" style={{ width: 440, border: '1px solid #FFD23F' }} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') done(false); }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ background: '#FFD23F', color: '#0B0C0E', fontWeight: 700, borderRadius: 999, padding: '2px 8px', fontSize: 11 }}>Confirm</span>
          <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{c.title}</span>
        </div>
        <span style={{ fontSize: 12, color: '#A3A7AF', lineHeight: 1.45 }}>{c.detail} Asked by the app, shown by the hub — the app cannot click this for you.</span>
        <pre className="mono" style={{ margin: 0, background: '#0B0C0E', border: '1px solid #24272D', borderRadius: 8, padding: '8px 10px', fontSize: 11.5, color: '#E7E8EA', whiteSpace: 'pre-wrap' }}>{c.tool}({args})</pre>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="b" style={{ height: 32 }} data-testid="confirm-no" onClick={() => done(false)}>Cancel</button>
          <button className="b bp" style={{ height: 32 }} data-testid="confirm-yes" autoFocus onClick={() => done(true)}>Run {c.tool}</button>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useUI((u) => u.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.level}`} data-testid="toast">{t.text}</div>)}
    </div>
  );
}

export function TokenPrompt() {
  const [tok, setTok] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // POST, so the token never lands in the URL bar, history or logs
  const submit = async () => {
    if (!tok.trim()) return;
    setErr(null);
    try {
      const r = await api.login(tok.trim());
      if (r.ok) location.href = '/';
      else setErr(r.status === 401 ? 'That token is not right.' : `Sign-in failed (${r.status})`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0B0C0E', padding: 16 }}>
      <form className="modal" style={{ width: 380 }} data-testid="token-prompt" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><Icon name="logo" size={20} sw={1.6} /><span style={{ fontWeight: 600, fontSize: 15 }}>Agent Hub</span></div>
        <span style={{ fontSize: 12.5, color: '#A3A7AF', lineHeight: 1.45 }}>This browser is not signed in. Paste the hub token to continue.</span>
        <input className="in mono" type="password" autoFocus autoComplete="current-password" placeholder="hub token" value={tok} onChange={(e) => setTok(e.target.value)} style={{ height: 36 }} />
        {err ? <span style={{ fontSize: 12, color: '#FFB3B6' }} data-testid="token-error">{err}</span> : null}
        <button className="b bp" style={{ height: 34, justifyContent: 'center' }} type="submit">Sign in</button>
      </form>
    </div>
  );
}
