// BRANCH: base, goal, local vs base / remote, PR + CI, commits, apps, actions.
import { memo, useState } from 'react';
import { api } from '../api';
import { focusNode, mergeLocal, toast, ui, useHub } from '../store';
import type { Branch, FileSource } from '../types';
import { Icon, shortSha, timeAgo } from '../ui';
import { Chevron, SheetBack, openSpawn, stop, type NodeMode } from './common';
import { CI_COLOR, CiChip, PR_COLOR, PrChip, Worktrees } from './RepoBits';

export function branchSource(b: Branch): FileSource {
  return b.pushed || !b.checkouts.length ? { kind: 'github', projectId: b.projectId, ref: b.name } : { kind: 'checkout', checkoutId: b.checkouts[0] };
}

export function launchHere(b: Branch, checkouts: Record<string, { id: string; host_id: string }>, projectCheckouts: string[]) {
  const co = b.checkouts.find((c) => checkouts[c]);
  if (co) openSpawn({ checkoutId: co, hostId: checkouts[co].host_id, branch: b.name });
  else openSpawn({ checkoutId: projectCheckouts.find((c) => checkouts[c]), branch: b.name, hostId: b.pushed ? 'cloud' : undefined });
}

export function BranchCommits({ b }: { b: Branch }) {
  if (!b.commits.length) return <span style={{ fontSize: 12, color: '#6E727A' }}>No commits on this branch yet.</span>;
  return (
    <>
      {b.commits.slice(0, 8).map((c) => (
        <div key={c.sha} data-testid="branch-commit" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, minWidth: 0 }}>
          <span className="mono" style={{ color: '#8A8F98', fontSize: 11, flex: 'none' }}>{shortSha(c.sha)}</span>
          <span className="ell" style={{ flex: 1 }}>{c.subject}</span>
          <span style={{ color: '#6E727A', fontSize: 11, flex: 'none', whiteSpace: 'nowrap' }}>{c.author} · {timeAgo(c.at)}</span>
        </div>
      ))}
    </>
  );
}

const BTN = { height: 24, padding: '0 8px', fontSize: 11.5 } as const;

function BranchNodeImpl({ id, mode }: { id: string; mode: NodeMode }) {
  const b = useHub((h) => h.branches[id]);
  const p = useHub((h) => (b ? h.projects[b.projectId] : undefined));
  const checkouts = useHub((h) => h.checkouts);
  const cloudSession = useHub((h) => (b?.cloud?.sessionId ? h.sessions[b.cloud.sessionId] : undefined));
  const [busy, setBusy] = useState<string | null>(null);
  if (!b) return null;
  const big = mode !== 'collapsed';
  const sheet = mode === 'sheet';
  const ghUrl = p?.gh ? `${p.gh.url}/tree/${b.name}` : null;
  const src = branchSource(b);
  const local = b.checkouts.length > 0;
  const dots = [b.ci ? CI_COLOR[b.ci.state] : null, b.pr ? PR_COLOR[b.pr.state] : null].filter(Boolean) as string[];

  const viewAppJson = async (path: string) => {
    setBusy(path);
    try {
      const c = await api.createCNode({ type: 'file', parentId: b.id, data: { source: { kind: 'github', projectId: b.projectId, ref: b.name }, path: `${path}/app.json` } });
      mergeLocal('cnodes', c);
      setTimeout(() => focusNode(c.id), 60);
    } catch (e) { toast(`Could not open app.json: ${(e as Error).message}`, 'error'); }
    setBusy(null);
  };
  const coApps = new Set(b.checkouts.flatMap((c) => checkouts[c]?.apps?.map((a) => a.dir) || []));
  const remoteApps = b.apps.filter((a) => !coApps.has(a.path));

  return (
    <div data-testid="branch-node" data-branch-id={b.id}
      style={{
        height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: '#121418', border: sheet ? 0 : '1px solid #2A2D33', borderRadius: sheet ? 0 : 14,
        padding: sheet ? '12px 14px calc(12px + env(safe-area-inset-bottom))' : '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, boxShadow: sheet ? 'none' : '0 8px 24px rgba(0,0,0,.28)',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 'none' }}>
        <SheetBack id={id} mode={mode} />
        <Icon name="branch" size={15} sw={1.8} style={{ color: '#A3A7AF', flex: 'none' }} />
        <span className="mono ell" style={{ fontSize: 13, flex: 1 }} title={b.name}>{b.name}</span>
        {b.cloud ? <span data-testid="branch-cloud" title={cloudSession ? `result branch of ${cloudSession.title}` : 'cloud result branch'} style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.04em', color: '#0B0C0E', background: cloudSession?.vendor === 'codex' ? '#A48BFA' : '#E0896B', borderRadius: 4, padding: '1px 5px', flex: 'none' }}>CLOUD</span> : null}
        <span style={{ display: 'flex', gap: 3, flex: 'none' }}>{dots.map((c, i) => <span key={i} className="dot" style={{ width: 7, height: 7, background: c }} />)}</span>
        <Chevron id={id} mode={mode} />
      </div>
      <div className="ell" style={{ color: '#8A8F98', fontSize: 12, flex: 'none' }}>
        from <span className="mono" style={{ color: '#C9CCD2' }}>{b.base || '—'}</span>
        {b.base ? <span className="mono"> · ↑{b.aheadBase} ↓{b.behindBase}</span> : null}
        {b.createdBy === 'agent' ? ' · by agent' : b.createdBy === 'hub' ? ' · from hub' : ''}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#A3A7AF', minWidth: 0, flex: 'none' }}>
        {local ? <span className="mono ell">local @ {shortSha(b.head)}</span> : <span style={{ color: '#6E727A' }}>no local worktree</span>}
        <span style={{ color: '#5A5E67' }}>·</span>
        {b.pushed ? <span className="mono" data-testid="branch-remote" style={{ whiteSpace: 'nowrap' }}>origin {shortSha(b.remoteSha)}{local ? ` ↑${b.aheadRemote} ↓${b.behindRemote}` : ''}</span>
          : <span data-testid="branch-remote" style={{ color: '#FFD23F', border: '1px solid rgba(255,210,63,.4)', borderRadius: 999, padding: '0 7px', fontSize: 10.5, whiteSpace: 'nowrap' }}>not pushed</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: 'none' }}>
        <PrChip pr={b.pr} />
        <CiChip ci={b.ci} />
      </div>
      {!big ? <Worktrees ids={b.checkouts} showBranch={false} max={1} /> : null}
      {!big && b.goal ? <div className="ell" style={{ fontSize: 12, color: '#C9CCD2' }} title={b.goal}>{b.goal}</div> : null}

      {big ? (
        <div className="scroll" data-wheel="inner" onPointerDown={stop} style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12, borderTop: '1px solid #24272D', paddingTop: 10, userSelect: 'text' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="cap">Branch goal</span>
            <span style={{ fontSize: 13.5, fontWeight: 500, lineHeight: 1.4, color: b.goal ? '#E7E8EA' : '#6E727A' }}>{b.goal || 'No goal recorded for this branch.'}</span>
          </div>
          <Worktrees ids={b.checkouts} showBranch={false} showApps max={6} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="cap">Last commits</span>
            <BranchCommits b={b} />
          </div>
          {remoteApps.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="cap">Apps on the pushed branch</span>
              {remoteApps.map((a) => (
                <div key={a.path} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 26 }}>
                  <Icon name="app" size={13} sw={1.8} style={{ color: '#8A8F98', flex: 'none' }} />
                  <span className="ell" style={{ fontSize: 12.5, flex: 1 }}>{a.title} <span className="mono" style={{ fontSize: 10.5, color: '#6E727A' }}>{a.path}</span></span>
                  <button className="b" style={{ height: 24, fontSize: 11.5 }} disabled={busy === a.path} onClick={() => viewAppJson(a.path)} data-testid="branch-app-json">View app.json</button>
                </div>
              ))}
              <span style={{ fontSize: 11, color: '#6E727A' }}>Publishing needs a checkout of this branch on a host.</span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: big ? 0 : 'auto', flexWrap: 'wrap', flex: 'none' }} onPointerDown={stop}>
        <button className="b" style={BTN} data-testid="branch-launch" onClick={() => launchHere(b, checkouts, p?.checkouts || [])}>Launch agent here</button>
        <button className="b" style={BTN} data-testid="new-branch" onClick={() => ui.set({ branchModal: { projectId: b.projectId, base: b.name, checkoutId: b.checkouts.find((c) => checkouts[c]) || p?.checkouts[0] } })}>New branch</button>
        <button className="b" style={BTN} data-testid="branch-files" onClick={() => ui.set({ quickOpen: { source: src, parentId: b.id, scopeLabel: b.name } })}>Files</button>
        {ghUrl && b.pushed ? <a className="b lnk" style={BTN} href={ghUrl} target="_blank" rel="noopener noreferrer">GitHub ↗</a> : null}
      </div>
    </div>
  );
}

export const BranchNode = memo(BranchNodeImpl);
