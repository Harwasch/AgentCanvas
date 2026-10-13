// PROJECT (= the repo's default branch): GitHub account, stats, folder sizes, README, worktrees.
import { memo, useMemo } from 'react';
import { ui, useHub } from '../store';
import { Icon, isActive } from '../ui';
import { Chevron, SheetBack, stop, type NodeMode } from './common';
import { Markdown } from './Markdown';
import { CiChip, Worktrees } from './RepoBits';

const FOLDER_COLORS = ['#6AA8FF', '#43D1B0', '#A6E15A', '#E8B04B', '#E0896B', '#A48BFA', '#F27BB0', '#8A8F98'];
const num = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));

function ProjectNodeImpl({ id, mode }: { id: string; mode: NodeMode }) {
  const p = useHub((h) => h.projects[id]);
  const branches = useHub((h) => h.branches);
  const sessions = useHub((h) => h.sessions);
  const checkouts = useHub((h) => h.checkouts);
  const mainBranch = p ? branches[`${p.id}#${p.defaultBranch}`] : undefined;
  const counts = useMemo(() => {
    if (!p) return { br: 0, act: 0 };
    const br = Object.values(branches).filter((b) => b.projectId === p.id && b.name !== p.defaultBranch).length;
    const act = Object.values(sessions).filter((s) => isActive(s) && s.checkout_id && checkouts[s.checkout_id]?.repo_id === p.id).length;
    return { br, act };
  }, [p, branches, sessions, checkouts]);
  if (!p) return null;
  const sheet = mode === 'sheet';
  const totalMb = p.folders.reduce((a, f) => a + Math.max(0, f.mb), 0) || 1;
  const mainCos = p.checkouts.filter((c) => checkouts[c]?.branch === p.defaultBranch);
  const firstCo = p.checkouts.find((c) => checkouts[c]);
  const source = mainBranch?.pushed || !firstCo ? { kind: 'github' as const, projectId: p.id, ref: p.defaultBranch } : { kind: 'checkout' as const, checkoutId: mainCos[0] || firstCo };
  const stats: [string, string][] = [
    ['Files', num(p.stats.files)], ['Commits', num(p.stats.commits)], ['Repo', `${p.stats.sizeMB} MB`],
    ['Branches', String(p.stats.branches)], ['Sessions', String(p.stats.sessions)],
  ];

  return (
    <div data-testid="project-node" data-project-id={p.id}
      style={{
        height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: '#15171B', border: sheet ? 0 : '1px solid #2E3138', borderRadius: sheet ? 0 : 16,
        padding: sheet ? '12px 14px calc(12px + env(safe-area-inset-bottom))' : '16px 18px', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: sheet ? 'none' : '0 10px 30px rgba(0,0,0,.35)',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 'none' }}>
        <SheetBack id={id} mode={mode} />
        <Icon name="repo" size={18} sw={1.6} style={{ color: '#C9CCD2', flex: 'none' }} />
        <div className="ell" style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em', flex: 1 }}>{p.name}</div>
        <span className="mono" data-testid="project-default-branch" style={{ fontSize: 11, color: '#C9CCD2', border: '1px solid #3A3E46', borderRadius: 6, padding: '2px 6px', flex: 'none' }}>{p.defaultBranch}</span>
        {p.gh ? <span className="mono" data-testid="project-gh" style={{ fontSize: 11, color: '#A3A7AF', border: '1px solid #2E3138', borderRadius: 6, padding: '2px 6px', flex: 'none', whiteSpace: 'nowrap' }}>GH · {p.gh.account}</span>
          : <span style={{ fontSize: 11, color: '#6E727A', border: '1px dashed #2E3138', borderRadius: 6, padding: '2px 6px', flex: 'none' }}>local</span>}
        <Chevron id={id} mode={mode} />
      </div>
      <div className="mono ell" style={{ fontSize: 11, color: '#8A8F98', marginTop: -4, flex: 'none' }}>{p.gh ? `${p.gh.owner}/${p.gh.repo}` : p.remoteUrl || 'no remote'}</div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px 8px', borderTop: '1px solid #24272D', paddingTop: 10, flex: 'none' }}>
        {stats.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><span style={{ fontSize: 11, color: '#8A8F98' }}>{k}</span><span className="mono" style={{ fontSize: 14 }}>{v}</span></div>
        ))}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}><span style={{ fontSize: 11, color: '#8A8F98' }}>{p.defaultBranch} CI</span><CiChip ci={mainBranch?.ci || null} /></div>
      </div>

      {p.folders.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 'none' }} data-testid="project-folders">
          <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', gap: 2 }}>
            {p.folders.map((f, i) => <span key={f.name} title={`/${f.name} ${f.mb} MB`} style={{ flex: Math.max(f.mb, totalMb * 0.01), background: FOLDER_COLORS[i % FOLDER_COLORS.length] }} />)}
          </div>
          <div className="mono" style={{ display: 'flex', gap: 8, fontSize: 10.5, color: '#A3A7AF', flexWrap: 'wrap' }}>
            {p.folders.map((f, i) => <span key={f.name} style={{ color: FOLDER_COLORS[i % FOLDER_COLORS.length] }}>/{f.name} {f.mb}M</span>)}
          </div>
        </div>
      ) : null}

      <Worktrees ids={p.checkouts} showApps={(co) => co.branch === p.defaultBranch} max={mode === 'collapsed' ? 2 : 6} />

      {p.readme ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#0E0F12', border: '1px solid #24272D', borderRadius: 10, overflow: 'hidden' }} onPointerDown={stop}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid #1E2025', flex: 'none' }}>
            <Icon name="file" size={12} style={{ color: '#8A8F98' }} />
            <span className="mono" style={{ fontSize: 11, color: '#A3A7AF', flex: 1 }}>README.md</span>
            <span className="mono" style={{ fontSize: 10.5, color: '#6E727A' }}>{p.defaultBranch} · rendered</span>
          </div>
          <div className="scroll" data-wheel="inner" data-testid="project-readme" style={{ flex: 1, overflow: 'auto', padding: '12px 14px', userSelect: 'text' }}>
            <Markdown md={p.readme} ctx={{ source, path: 'README.md' }} />
          </div>
        </div>
      ) : <div style={{ flex: 1, fontSize: 12, color: '#6E727A' }}>No README on {p.defaultBranch}.</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: 'none' }} onPointerDown={stop}>
        <span style={{ color: '#8A8F98', fontSize: 12, flex: 1, whiteSpace: 'nowrap' }}>{counts.br} branch{counts.br === 1 ? '' : 'es'} · {counts.act} active</span>
        <button className="b" style={{ height: 26 }} data-testid="project-repo-browser" onClick={() => ui.set({ tab: 'repos', reviewId: null, repoCheckout: firstCo || null, repoSource: firstCo ? null : source })}>Repo browser</button>
        <button className="b" style={{ height: 26 }} data-testid="project-files" onClick={() => ui.set({ quickOpen: { source, parentId: p.id, scopeLabel: p.name } })}>Files</button>
        <button className="b" style={{ height: 26 }} data-testid="new-branch" onClick={() => ui.set({ branchModal: { projectId: p.id, base: p.defaultBranch, checkoutId: mainCos[0] || firstCo } })}>New branch</button>
        {p.gh ? <a className="b lnk" style={{ height: 26 }} href={p.gh.url} target="_blank" rel="noopener noreferrer">GitHub ↗</a> : null}
      </div>
    </div>
  );
}

export const ProjectNode = memo(ProjectNodeImpl);
