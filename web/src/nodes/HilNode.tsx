// HIL test run (design "HIL test run" inside the app chrome): plan, setup chain, counters,
// progress, per-test rows, log tail, Run / Abort / Re-run failed.
import { memo, useMemo, useState } from 'react';
import { api } from '../api';
import { mergeLocal, toast, useHub } from '../store';
import type { HilRow } from '../types';
import { duration, timeAgo } from '../ui';
import { stop, useSessionTitle, type NodeMode } from './common';

const ROW_COLOR: Record<HilRow['status'], { bar: string; fg: string; label: string; bg?: string }> = {
  pending: { bar: '#24272D', fg: '#6E727A', label: 'pending' },
  run: { bar: '#E7E8EA', fg: '#E7E8EA', label: 'running', bg: 'rgba(231,232,234,.04)' },
  pass: { bar: '#43D1B0', fg: '#43D1B0', label: 'PASS' },
  fail: { bar: '#E5484D', fg: '#FFB3B6', label: 'FAIL', bg: 'rgba(229,72,77,.07)' },
  skip: { bar: '#5A5E67', fg: '#8A8F98', label: 'skip' },
};
const tsv = (t: string | number) => (typeof t === 'number' ? t : Date.parse(t) || 0);
const RUN_DOT: Record<string, string> = { running: '#43D1B0', passed: '#43D1B0', failed: '#E5484D', aborted: '#8A8F98' };

function HilNodeImpl({ id }: { id: string; mode: NodeMode }) {
  const plan = useHub((h) => h.hilPlans[id]);
  const runsAll = useHub((h) => h.hilRuns);
  const host = useHub((h) => (plan ? h.hosts[plan.hostId] : undefined));
  const runs = useMemo(() => Object.values(runsAll).filter((r) => r.planId === id).sort((a, b) => tsv(b.startedAt) - tsv(a.startedAt)), [runsAll, id]);
  const [busy, setBusy] = useState(false);
  const run = runs[0];
  const by = useSessionTitle(run && run.startedBy !== 'you' ? run.startedBy : null);
  if (!plan) return null;
  const running = run?.status === 'running';
  const act = async (f: () => Promise<unknown>, what: string) => {
    setBusy(true);
    try { const r = await f(); if (r && typeof r === 'object' && 'planId' in (r as object)) mergeLocal('hilRuns', r as { id: string }); } catch (e) { toast(`${what} failed: ${(e as Error).message}`, 'error'); }
    setBusy(false);
  };
  const color = host?.color || '#8A8F98';
  const runNo = run ? run.id.replace(/^\D+/, '') : '';

  return (
    <div data-testid="hil-node" data-plan-id={plan.id} data-run-status={run?.status || 'none'}
      style={{ height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: '#121418', border: `1px solid ${run?.status === 'failed' ? '#E5484D66' : color + '55'}`, borderRadius: 14, display: 'flex', flexDirection: 'column', boxShadow: '0 10px 28px rgba(0,0,0,.4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px 7px', minWidth: 0 }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C9CCD2" strokeWidth="1.8" aria-hidden="true" style={{ flex: 'none' }}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></svg>
        <span className="ell" style={{ fontWeight: 600, fontSize: 13.5, flex: 1 }}>HIL · {plan.title}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#C9CCD2', flex: 'none' }}>
          {running ? <span className="spin" style={{ width: 9, height: 9 }} /> : <span className="dot" style={{ width: 7, height: 7, background: run ? RUN_DOT[run.status] : '#5A5E67' }} />}
          {run ? run.status : 'never run'}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 12px 8px', background: '#0B0C0E', border: '1px solid #24272D', borderRadius: 7, padding: '3px 8px', minWidth: 0 }}>
        <span className="mono" style={{ fontSize: 10, color: '#0B0C0E', background: color, borderRadius: 4, padding: '1px 5px', flex: 'none' }}>HIL</span>
        <span className="mono ell" style={{ fontSize: 11, color: '#A3A7AF', flex: 1 }}>{plan.plan ? `plan ${plan.plan}` : 'no plan doc'} · {host?.label || plan.hostId}</span>
        <span style={{ fontSize: 10.5, color: '#6E727A', flex: 'none' }}>{run ? (run.finishedAt ? `finished ${timeAgo(run.finishedAt)}` : `running ${duration(run.startedAt)}`) : ''}</span>
      </div>
      <div className="scroll" data-wheel="inner" onPointerDown={stop}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', margin: '0 8px 8px', background: '#0B0C0E', border: '1px solid #1E2025', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 12, cursor: 'default', userSelect: 'text' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flex: 'none' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 180 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>{plan.title}{run ? ` · run #${runNo}` : ''}</span>
            <span className="mono ell" style={{ fontSize: 11, color: '#8A8F98' }}>{run ? `started by ${run.startedBy === 'you' ? 'you' : by || run.startedBy} · ${timeAgo(run.startedAt)}` : 'No runs yet'}</span>
          </div>
          <span className="mono" data-testid="hil-summary" data-pass={run?.pass ?? 0} data-fail={run?.fail ?? 0} data-left={run?.left ?? 0} style={{ fontSize: 12, color: '#C9CCD2' }}>
            {run ? `${run.pass} pass · ${run.fail} fail · ${run.left} left` : '—'}
          </span>
          {running ? (
            <button className="b" style={{ height: 28 }} disabled={busy} data-testid="hil-abort" onClick={() => act(() => api.hilAbort(run.id), 'Abort')}>Abort</button>
          ) : (
            <button className="b bp" style={{ height: 28 }} disabled={busy} data-testid="hil-run" onClick={() => act(() => api.hilRun(plan.id), 'Run')}>Run</button>
          )}
          <button className="b" style={{ height: 28 }} disabled={busy || running || !run || !run.fail} data-testid="hil-rerun" onClick={() => run && act(() => api.hilRerun(run.id), 'Re-run')}>Re-run failed</button>
        </div>
        <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', background: '#1E2025', gap: 1, flex: 'none' }} aria-hidden="true">
          {(run?.rows || []).map((r) => <span key={r.id} style={{ flex: 1, background: ROW_COLOR[r.status]?.bar || '#24272D' }} />)}
        </div>
        {plan.setup.length ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11, flex: 'none' }}>
            <span className="cap" style={{ marginRight: 4 }}>Setup</span>
            {plan.setup.map((s, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {i ? <span style={{ color: '#6E727A' }}>→</span> : null}
                <span style={{ border: `1px solid ${i ? '#3A3E46' : color + '55'}`, borderRadius: 6, padding: '2px 7px', color: '#C9CCD2' }}>{s}</span>
              </span>
            ))}
          </div>
        ) : null}
        <div style={{ border: '1px solid #24272D', borderRadius: 9, overflow: 'hidden', flex: 'none' }}>
          <div className="mono" style={{ display: 'grid', gridTemplateColumns: '54px 92px minmax(0, 1fr) 72px 56px', gap: 8, padding: '6px 10px', fontSize: 10.5, color: '#8A8F98', background: '#111215' }}>
            <span>ID</span><span>REQ</span><span>TEST</span><span>STATUS</span><span style={{ textAlign: 'right' }}>TIME</span>
          </div>
          {(run?.rows || []).map((r) => {
            const c = ROW_COLOR[r.status] || ROW_COLOR.pending;
            return (
              <div key={r.id} data-testid="hil-row" data-row-id={r.id} data-status={r.status}
                style={{ display: 'grid', gridTemplateColumns: '54px 92px minmax(0, 1fr) 72px 56px', gap: 8, padding: '6px 10px', fontSize: 12, alignItems: 'center', borderTop: '1px solid #1A1C21', background: c.bg }}>
                <span className="mono" style={{ fontSize: 11, color: '#A3A7AF' }}>{r.id}</span>
                <span className="mono ell" style={{ fontSize: 11, color: '#8A8F98' }}>{r.req}</span>
                <span className="ell" style={{ color: r.status === 'pending' ? '#8A8F98' : '#E7E8EA' }}>{r.name}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: c.fg }}>
                  {r.status === 'run' ? <span className="spin" style={{ width: 9, height: 9 }} /> : null}{c.label}
                </span>
                <span className="mono" style={{ fontSize: 11, color: '#8A8F98', textAlign: 'right' }}>{r.durMs != null ? `${(r.durMs / 1000).toFixed(1)} s` : ''}</span>
              </div>
            );
          })}
          {!run ? <div style={{ padding: '10px', fontSize: 12, color: '#6E727A' }}>Press Run to start the plan on {host?.label || plan.hostId}.</div> : null}
        </div>
        {run?.log?.length ? (
          <div className="mono" data-testid="hil-log" style={{ background: '#08090A', border: '1px solid #1E2025', borderRadius: 8, padding: '8px 10px', fontSize: 11, lineHeight: 1.6, display: 'flex', flexDirection: 'column', flex: 'none' }}>
            {run.log.slice(-10).map((l, i) => (
              <span key={i} style={{ whiteSpace: 'pre-wrap', color: /fail|abort|error/i.test(l) ? '#FFB3B6' : l.startsWith('##hil pass') ? '#8FE3CF' : l.startsWith('##') ? '#8A8F98' : '#C9CCD2' }}>{l}</span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const HilNode = memo(HilNodeImpl);
