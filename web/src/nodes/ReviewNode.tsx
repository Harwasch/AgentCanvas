// REVIEW: an artifact an agent asks you to check — rendered file, checklist, comments, decision.
import { memo, useRef, useState } from 'react';
import { api } from '../api';
import { kindOf } from '../files';
import { mergeLocal, toast, ui, useHub } from '../store';
import type { CNode, ReviewData } from '../types';
import { ProviderBadge, computeColor, computeKey, computeName, shortSha, timeAgo } from '../ui';
import { Chevron, FolderChip, SheetBack, stop, useLive, type NodeMode } from './common';
import { FileBody } from './FileBody';

export const REVIEW_STATUS: Record<string, { label: string; bg: string; fg: string }> = {
  pending: { label: 'Pending your review', bg: '#E7E8EA', fg: '#FFD23F' },
  approved: { label: 'Approved', bg: '#43D1B0', fg: '#43D1B0' },
  changes: { label: 'Changes requested', bg: '#FFB3B6', fg: '#FFB3B6' },
};

export function useReviewActions(id: string, node: CNode<ReviewData> | undefined) {
  const [busy, setBusy] = useState(false);
  const toggleCheck = (i: number) => {
    if (!node) return;
    const checklist = node.data.checklist.map((c, j) => (j === i ? { ...c, done: !c.done } : c));
    mergeLocal('cnodes', { ...node, data: { ...node.data, checklist } });
    api.updateCNode(id, { checklist }).then((c) => mergeLocal('cnodes', c)).catch((e) => { mergeLocal('cnodes', node); toast(`Checklist not saved: ${(e as Error).message}`, 'error'); });
  };
  const decide = async (decision: 'approve' | 'changes', note: string) => {
    if (!node) return false;
    setBusy(true);
    try {
      await api.reviewDecision(id, decision, note.trim() || undefined);
      mergeLocal('cnodes', { ...node, data: { ...node.data, status: decision === 'approve' ? 'approved' : 'changes' } });
      toast(decision === 'approve' ? 'Approved · sent to the agent' : 'Changes requested · sent to the agent');
      setBusy(false);
      return true;
    } catch (e) { toast(`Decision failed: ${(e as Error).message}`, 'error'); setBusy(false); return false; }
  };
  const comment = async (text: string) => {
    if (!text.trim()) return false;
    try { await api.reviewComment(id, text.trim()); return true; } catch (e) { toast(`Comment failed: ${(e as Error).message}`, 'error'); return false; }
  };
  return { busy, toggleCheck, decide, comment };
}

export function Comments({ d, big = false }: { d: ReviewData; big?: boolean }) {
  if (!d.comments.length) return <span style={{ fontSize: 12, color: '#6E727A' }}>No comments yet.</span>;
  return (
    <>
      {d.comments.map((c, i) => (
        <div key={c.id} data-testid="review-comment" style={{ background: c.author === 'you' ? '#1A1C21' : '#111215', border: '1px solid #24272D', borderRadius: big ? 10 : 9, padding: big ? '9px 11px' : '7px 10px', display: 'flex', flexDirection: 'column', gap: 3, flex: 'none' }}>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: '#8A8F98' }}>
            <span style={{ width: 18, height: 18, borderRadius: '50% 50% 50% 3px', background: c.author === 'you' ? '#E7E8EA' : '#5A5E67', color: '#0B0C0E', fontSize: 10, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
            {c.author === 'you' ? 'You' : 'Agent'} · {timeAgo(c.at)}
          </span>
          <span style={{ fontSize: big ? 12.5 : 12, lineHeight: 1.45, wordBreak: 'break-word' }}>{c.text}</span>
        </div>
      ))}
    </>
  );
}

export function CommentInput({ onSend }: { onSend: (t: string) => Promise<boolean> }) {
  const [t, setT] = useState('');
  const send = async () => { const v = t; setT(''); if (!(await onSend(v))) setT(v); };
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <input className="in" style={{ flex: 1 }} data-testid="review-comment-input" aria-label="Comment" placeholder="Comment…" value={t} onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && t.trim()) void send(); }} />
      <button className="b" style={{ height: 30 }} disabled={!t.trim()} onClick={send} data-testid="review-comment-send">Comment</button>
    </div>
  );
}

function ReviewNodeImpl({ id, mode }: { id: string; mode: NodeMode }) {
  const node = useHub((h) => h.cnodes[id]) as CNode<ReviewData> | undefined;
  const session = useHub((h) => (node ? h.sessions[node.data.sessionId] : undefined));
  const hosts = useHub((h) => h.hosts);
  const outerRef = useRef<HTMLDivElement>(null);
  const live = useLive(outerRef, id, mode);
  const [note, setNote] = useState('');
  const act = useReviewActions(id, node);
  if (!node) return null;
  const d = node.data;
  const big = mode !== 'collapsed';
  const sheet = mode === 'sheet';
  const st = REVIEW_STATUS[d.status] || REVIEW_STATUS.pending;
  const fkind = kindOf(d.path);
  const color = session ? computeColor(computeKey(session), hosts) : '#3A3E46';
  const pending = d.status === 'pending';

  return (
    <div ref={outerRef} data-testid="review-node" data-node-id={id} data-status={d.status}
      style={{
        height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: '#15171B', border: sheet ? 0 : `1px solid ${pending ? '#5A5E67' : st.fg + '66'}`, borderRadius: sheet ? 0 : 14,
        padding: sheet ? '12px 14px calc(12px + env(safe-area-inset-bottom))' : '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, boxShadow: sheet ? 'none' : '0 8px 24px rgba(0,0,0,.3)',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 'none' }}>
        <SheetBack id={id} mode={mode} />
        <span data-testid="review-status" style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.04em', color: '#0B0C0E', background: st.bg, borderRadius: 4, padding: '2px 5px', flex: 'none' }}>{pending ? 'REVIEW' : d.status === 'approved' ? 'APPROVED' : 'CHANGES'}</span>
        <span className="mono ell" style={{ fontSize: 12, flex: 1 }} title={d.title}>{d.title}</span>
        {big ? <button className="b ghost desk-only" style={{ height: 24, fontSize: 11 }} onPointerDown={stop} onClick={() => ui.set({ tab: 'repos', reviewId: id })}>Open page ↗</button> : null}
        <Chevron id={id} mode={mode} label={big ? 'Collapse review' : 'Expand review'} />
      </div>
      <div className="mono" style={{ fontSize: 10.5, color: '#8A8F98', display: 'flex', gap: 6, alignItems: 'center', minWidth: 0, flex: 'none' }}>
        <FolderChip path={d.path} /><span className="ell">{d.path}</span><span style={{ flex: 'none', color: '#6E727A' }}>@ {shortSha(d.sha)}</span>
      </div>

      {!big ? (
        <>
          <div style={{ flex: 1, minHeight: 0, background: '#0E0F12', border: '1px solid #24272D', borderRadius: 8, position: 'relative', overflow: 'hidden', padding: fkind === 'image' ? 4 : '6px 8px' }}>
            {live && (fkind === 'image' || fkind === 'doc') ? (
              <div style={{ position: 'absolute', inset: fkind === 'image' ? 4 : '6px 8px', overflow: 'hidden', transform: fkind === 'doc' ? 'scale(.72)' : undefined, transformOrigin: '0 0', width: fkind === 'doc' ? '139%' : undefined, pointerEvents: 'none' }}>
                <FileBody source={d.source} path={d.path} sha={d.sha} kind={fkind} />
              </div>
            ) : <span style={{ fontSize: 11.5, color: '#6E727A', lineHeight: 1.4, display: 'block' }}>{d.note}</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }} onPointerDown={stop}>
            <span className="ell" style={{ fontSize: 11, color: d.status === 'pending' ? '#8A8F98' : st.fg, flex: 1 }}>{d.status === 'pending' ? d.kind : st.label}</span>
            <button className="b" style={{ height: 24 }} data-testid="review-open" onClick={() => ui.set((u) => ({ expanded: { ...u.expanded, [id]: true }, focusId: id }))}>Review</button>
          </div>
        </>
      ) : (
        <>
          <div className="ell" style={{ fontSize: 11.5, color: '#8A8F98', display: 'flex', gap: 6, alignItems: 'center', flex: 'none' }}>
            {session ? <ProviderBadge vendor={session.vendor} size={16} /> : null}
            <span className="ell">Requested by {session?.title || 'an agent'}{session ? ` · ${computeName(computeKey(session), hosts)}` : ''} · {d.kind}</span>
            <span className="dot" style={{ width: 7, height: 7, background: color }} />
          </div>
          {d.note ? <div style={{ fontSize: 12, color: '#C9CCD2', lineHeight: 1.45, flex: 'none' }}>{d.note}</div> : null}
          <div className="scroll" data-wheel="inner" onPointerDown={stop} style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12, paddingRight: 4, userSelect: 'text' }}>
            <div style={{ position: 'relative', minHeight: fkind === 'model3d' ? 280 : undefined, flex: 'none' }}>
              <FileBody source={d.source} path={d.path} sha={d.sha} kind={fkind} live={live} nodeKey={id} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 'none' }}>
              <span className="cap">Comments</span>
              <Comments d={d} />
            </div>
          </div>
          <div style={{ borderTop: '1px solid #24272D', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 8, flex: 'none' }} onPointerDown={stop}>
            {d.checklist.length ? (
              <div style={{ display: 'flex', gap: '6px 14px', flexWrap: 'wrap' }}>
                {d.checklist.map((c, i) => (
                  <label key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11.5, color: '#C9CCD2' }}>
                    <input type="checkbox" data-testid="review-check" checked={c.done} onChange={() => act.toggleCheck(i)} style={{ accentColor: '#E7E8EA' }} />{c.text}
                  </label>
                ))}
              </div>
            ) : null}
            <CommentInput onSend={act.comment} />
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input className="in" style={{ flex: 1, minWidth: 140 }} data-testid="review-note" aria-label="Note to the agent" placeholder="Note to the agent (sent with your decision)…" value={note} onChange={(e) => setNote(e.target.value)} />
              <button className="b bp" style={{ height: 30 }} disabled={act.busy} data-testid="review-approve" onClick={async () => { if (await act.decide('approve', note)) setNote(''); }}>
                Approve{d.promoteTo ? ` → ${d.promoteTo}` : ''}
              </button>
              <button className="b" style={{ height: 30 }} disabled={act.busy} data-testid="review-changes" onClick={async () => { if (await act.decide('changes', note)) setNote(''); }}>Request changes</button>
            </div>
            {!pending ? <span style={{ fontSize: 11.5, color: st.fg }}>{st.label}</span> : null}
          </div>
        </>
      )}
    </div>
  );
}

export const ReviewNode = memo(ReviewNodeImpl);
