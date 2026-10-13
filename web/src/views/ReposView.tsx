// Repo browser (design 02 / d386): review queue, host checkouts and GitHub branches → file tree,
// rendered viewer, status panel. A selected review opens in the artifact-review layout.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { kindOf, sourceKey } from '../files';
import { BranchCommits } from '../nodes/BranchNode';
import { FileBody } from '../nodes/FileBody';
import { CiChip, PrChip } from '../nodes/RepoBits';
import { Comments, CommentInput, REVIEW_STATUS, useReviewActions } from '../nodes/ReviewNode';
import { focusNode, mergeLocal, toast, ui, useHub, useUI } from '../store';
import type { CNode, Checkout, FileSource, ReviewData } from '../types';
import { Icon, ProviderBadge, computeKey, computeName, shortSha, timeAgo, useIsPhone } from '../ui';

interface FileRow { path: string; xy: string | null }
const letter = (xy: string | null | undefined) => {
  if (!xy) return '';
  const t = xy.trim();
  if (t === '??' || t === '?') return '?';
  return t.slice(0, 1);
};
const LETTER_COLOR: Record<string, string> = { M: '#FFD23F', A: '#43D1B0', '?': '#6AA8FF', D: '#FFB3B6', R: '#A48BFA' };

function ghOwner(co: Checkout) {
  const m = co.remote_url?.match(/[:/]([^/:]+)\/[^/]+?(?:\.git)?$/);
  return m ? m[1] : 'local';
}

interface TreeItem { name: string; path: string; dir: boolean; depth: number; xy: string | null }
function buildTree(files: FileRow[], open: Record<string, boolean>): TreeItem[] {
  const out: TreeItem[] = [];
  const dirs = new Set<string>();
  const sorted = files.slice().sort((a, b) => a.path.localeCompare(b.path));
  sorted.forEach((f) => {
    const parts = f.path.split('/');
    let visible = true;
    for (let i = 0; i < parts.length - 1; i++) {
      const dp = parts.slice(0, i + 1).join('/');
      if (!visible) break;
      if (!dirs.has(dp)) {
        dirs.add(dp);
        out.push({ name: parts[i] + '/', path: dp, dir: true, depth: i, xy: null });
      }
      if (!open[dp]) visible = false;
    }
    if (visible) out.push({ name: parts[parts.length - 1], path: f.path, dir: false, depth: parts.length - 1, xy: f.xy });
  });
  return out;
}

async function pinToCanvas(source: FileSource, path: string, parentId: string | null) {
  try {
    const c = await api.createCNode({ type: 'file', parentId, data: { source, path } });
    mergeLocal('cnodes', c);
    toast(`Pinned ${path} to the canvas`);
    setTimeout(() => focusNode(c.id), 80);
  } catch (e) { toast(`Pin failed: ${(e as Error).message}`, 'error'); }
}

export function ReposView() {
  const reviewId = useUI((u) => u.reviewId);
  const review = useHub((h) => (reviewId ? h.cnodes[reviewId] : undefined));
  if (reviewId && review?.type === 'review') return <ReviewPage id={reviewId} />;
  return <Browser />;
}

// ---------------------------------------------------------------- sidebar: review queue + sources
function SourceList({ coId, ghKey }: { coId: string | null; ghKey: string | null }) {
  const checkouts = useHub((h) => h.checkouts);
  const hosts = useHub((h) => h.hosts);
  const projects = useHub((h) => h.projects);
  const branches = useHub((h) => h.branches);
  const cnodes = useHub((h) => h.cnodes);
  const reviewId = useUI((u) => u.reviewId);
  const list = useMemo(() => Object.values(checkouts).sort((a, b) => a.repoName.localeCompare(b.repoName) || a.host_id.localeCompare(b.host_id)), [checkouts]);
  const reviews = useMemo(() => Object.values(cnodes).filter((c) => c.type === 'review')
    .sort((a, b) => Number(b.data.status === 'pending') - Number(a.data.status === 'pending') || String(b.updatedAt).localeCompare(String(a.updatedAt), undefined, { numeric: true })), [cnodes]);
  const gh = useMemo(() => Object.values(projects).filter((p) => p.gh).sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({
    p, refs: Object.values(branches).filter((b) => b.projectId === p.id && b.pushed).sort((a, b) => (a.name === p.defaultBranch ? -1 : b.name === p.defaultBranch ? 1 : a.name.localeCompare(b.name))),
  })), [projects, branches]);
  const pending = reviews.filter((r) => r.data.status === 'pending').length;
  return (
    <>
      {reviews.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }} data-testid="review-queue">
          <span className="cap" style={{ padding: '0 6px 4px' }}>Review queue{pending ? ` · ${pending} pending` : ''}</span>
          {reviews.map((r) => {
            const st = REVIEW_STATUS[r.data.status] || REVIEW_STATUS.pending;
            return (
              <button key={r.id} data-testid="review-queue-item" data-node-id={r.id} data-status={r.data.status} onClick={() => ui.set({ reviewId: r.id })}
                style={{ background: r.id === reviewId ? '#1A1C21' : 'transparent', border: 0, borderRadius: 7, color: '#E7E8EA', textAlign: 'left', padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 9.5, fontWeight: 600, color: '#0B0C0E', background: st.bg, borderRadius: 4, padding: '1px 4px', flex: 'none' }}>{r.data.status === 'pending' ? 'REVIEW' : r.data.status === 'approved' ? 'OK' : 'CHG'}</span>
                <span className="ell" style={{ flex: 1, fontSize: 12.5 }}>{r.data.title}</span>
              </button>
            );
          })}
          <div style={{ height: 1, background: '#1E2025', margin: '8px 0 2px' }} />
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span className="cap" style={{ padding: '0 6px 4px' }}>Checkouts</span>
        {list.map((c) => (
          <button key={c.id} onClick={() => ui.set({ repoCheckout: c.id, repoSource: null, reviewId: null })} data-testid="repo-checkout" data-checkout-id={c.id}
            style={{ background: c.id === coId && !ghKey ? '#1A1C21' : 'transparent', border: 0, borderRadius: 7, color: '#E7E8EA', textAlign: 'left', padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="dot" style={{ background: hosts[c.host_id]?.color || '#8A8F98' }} />
            <span className="ell" style={{ flex: 1, fontSize: 12.5 }}>{c.repoName}</span>
            <span className="mono ell" style={{ fontSize: 10.5, color: '#8A8F98', maxWidth: 90 }}>{c.branch}</span>
          </button>
        ))}
        {!list.length ? <span style={{ fontSize: 12, color: '#6E727A', padding: '0 8px' }}>No checkouts indexed.</span> : null}
      </div>
      {gh.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="cap" style={{ padding: '6px 6px 4px' }}>GitHub</span>
          {gh.map(({ p, refs }) => (refs.length ? refs : [{ name: p.defaultBranch, id: `${p.id}#${p.defaultBranch}` }]).map((b) => {
            const key = `gh:${p.id}@${b.name}`;
            return (
              <button key={key} data-testid="repo-gh-ref" onClick={() => ui.set({ repoSource: { kind: 'github', projectId: p.id, ref: b.name }, reviewId: null })}
                style={{ background: key === ghKey ? '#1A1C21' : 'transparent', border: 0, borderRadius: 7, color: '#E7E8EA', textAlign: 'left', padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="mono" style={{ fontSize: 9.5, color: '#A3A7AF', border: '1px solid #2E3138', borderRadius: 4, padding: '0 3px', flex: 'none' }}>GH</span>
                <span className="ell" style={{ fontSize: 12.5, color: '#C9CCD2', flex: 'none', maxWidth: 110 }}>{p.name}</span>
                <span className="mono ell" style={{ fontSize: 10.5, color: '#8A8F98', flex: 1, textAlign: 'right' }}>{b.name}</span>
              </button>
            );
          }))}
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- browser
function Browser() {
  const checkouts = useHub((h) => h.checkouts);
  const hosts = useHub((h) => h.hosts);
  const projects = useHub((h) => h.projects);
  const branches = useHub((h) => h.branches);
  const sel = useUI((u) => u.repoCheckout);
  const repoSource = useUI((u) => u.repoSource);
  const phone = useIsPhone();
  const list = useMemo(() => Object.values(checkouts).sort((a, b) => a.repoName.localeCompare(b.repoName) || a.host_id.localeCompare(b.host_id)), [checkouts]);
  const gh = repoSource && repoSource.kind === 'github' ? repoSource : null;
  const co = gh ? undefined : (sel && checkouts[sel]) || list[0];
  const source: FileSource | null = gh || (co ? { kind: 'checkout', checkoutId: co.id } : null);
  const srcKey = source ? sourceKey(source) : '';
  const project = gh ? projects[gh.projectId] : co ? projects[co.repo_id] : undefined;
  const branch = gh ? branches[`${gh.projectId}#${gh.ref}`] : co ? branches[`${co.repo_id}#${co.branch}`] : undefined;
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [path, setPath] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [ferr, setFerr] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    setFiles(null); setPath(null); setContent(null); setOpen({});
    if (!source) return;
    let alive = true;
    const p = source.kind === 'checkout' ? api.files(source.checkoutId).then((r) => r.files || [])
      : api.listFiles(source, '').then((r) => (r.files || []).map((f) => ({ path: f.path, xy: null })));
    p.then((fl) => {
      if (!alive) return;
      setFiles(fl);
      const readme = fl.find((f) => /^readme(\.md)?$/i.test(f.path));
      if (readme && !phone) setPath(readme.path);
      const o: Record<string, boolean> = {};
      fl.filter((f) => f.xy).forEach((f) => { const ps = f.path.split('/'); for (let i = 1; i < ps.length; i++) o[ps.slice(0, i).join('/')] = true; });
      setOpen(o);
    }).catch((e) => { if (alive) { setFiles([]); toast(`Could not list files: ${(e as Error).message}`, 'error'); } });
    return () => { alive = false; };
  }, [srcKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const kind = path ? kindOf(path) : 'text';
  const textual = kind === 'doc' || kind === 'code' || kind === 'text';
  useEffect(() => {
    setContent(null); setFerr(null);
    if (!co || !path || !textual) return;
    let alive = true;
    api.file(co.id, path).then((r) => { if (alive) setContent(r.content); }).catch((e) => { if (alive) setFerr((e as Error).message); });
    return () => { alive = false; };
  }, [co?.id, path, textual]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!source) return <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8A8F98' }}>No checkouts indexed yet.</div>;
  const host = co ? hosts[co.host_id] : undefined;
  const tree = files ? buildTree(files, open) : [];
  const showTree = !phone || !path;
  const showViewer = !phone || !!path;
  const parentForPin = branch && projects[branch.projectId]?.defaultBranch !== branch.name ? branch.id : project?.id || null;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#0B0C0E' }} data-testid="repos-view">
      <div className="noscrollbar" style={{ minHeight: 52, flex: 'none', borderBottom: '1px solid #1E2025', background: '#0E0F12', display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', overflowX: 'auto' }}>
        <button className="b ghost" aria-label="Back to canvas" style={{ width: 30, padding: 0, justifyContent: 'center', flex: 'none' }} onClick={() => ui.set({ tab: 'canvas' })}><Icon name="back" /></button>
        <span style={{ fontSize: 12, color: '#A3A7AF', border: '1px solid #24272D', borderRadius: 7, padding: '4px 8px', whiteSpace: 'nowrap' }}>GH · {project?.gh?.account || (co ? ghOwner(co) : 'local')}</span>
        <span style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' }}>{co ? co.repoName : project?.name || gh?.projectId}</span>
        <span className="b mono" data-testid="repo-branch" style={{ flex: 'none' }}>{co ? co.branch || '(detached)' : gh?.ref}<Icon name="chev" size={12} /></span>
        {co ? (
          <span data-testid="repo-head" style={{ fontSize: 12, color: '#8A8F98', whiteSpace: 'nowrap' }}>@ <span className="mono">{shortSha(co.head)}</span> · {co.head_subject} {co.head_time ? `· ${timeAgo(co.head_time)}` : ''}</span>
        ) : (
          <span data-testid="repo-head" style={{ fontSize: 12, color: '#8A8F98', whiteSpace: 'nowrap' }}>@ <span className="mono">{shortSha(branch?.remoteSha)}</span>{branch?.commits?.[0] ? ` · ${branch.commits[0].subject} · ${timeAgo(branch.commits[0].at)}` : ''}</span>
        )}
        <div style={{ flex: 1 }} />
        {co ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#C9CCD2', whiteSpace: 'nowrap' }}><span className="dot" style={{ background: host?.color || '#8A8F98' }} />{host?.label || co.host_id}<span className="mono" style={{ color: '#6E727A', fontSize: 11 }}>{co.path}</span></span>
          : <span style={{ fontSize: 12, color: '#8A8F98', whiteSpace: 'nowrap' }}>GitHub · read-only</span>}
        {path ? <button className="b" style={{ flex: 'none' }} data-testid="repo-pin" onClick={() => pinToCanvas(source, path, parentForPin)}>⇱ Pin to canvas</button> : null}
        {co ? <button className="b" style={{ flex: 'none' }} onClick={() => api.refreshCheckout(co.id).then(() => toast('Refreshed')).catch((e) => toast(String(e.message), 'error'))}>Refresh</button>
          : branch ? <button className="b" style={{ flex: 'none' }} onClick={() => api.refreshBranch(branch.id).then((b) => { mergeLocal('branches', b); toast('Refreshed'); }).catch((e) => toast(String(e.message), 'error'))}>Refresh</button> : null}
        {project?.gh ? <a className="b lnk" style={{ flex: 'none' }} href={`${project.gh.url}/tree/${co ? co.branch : gh?.ref}`} target="_blank" rel="noopener noreferrer">Open on GitHub</a> : null}
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0, flexDirection: phone ? 'column' : 'row' }}>
        {showTree ? (
          <div className="scroll" style={{ width: phone ? 'auto' : 280, flex: phone ? 1 : 'none', borderRight: '1px solid #1E2025', background: '#0E0F12', overflow: 'auto', padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: 10, boxSizing: 'border-box' }}>
            <SourceList coId={co?.id || null} ghKey={gh ? sourceKey(gh) : null} />
            <div style={{ height: 1, background: '#1E2025' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {!files ? <span style={{ fontSize: 12, color: '#8A8F98', padding: '0 8px' }}>Loading files…</span> : null}
              {tree.map((f) => {
                const l = letter(f.xy);
                const on = f.path === path;
                return (
                  <div key={f.path + (f.dir ? '/' : '')} style={{ display: 'flex', alignItems: 'center', borderRadius: 7, background: on ? '#1A1C21' : 'transparent', flex: 'none' }}>
                    <button data-testid={f.dir ? undefined : 'repo-file'} data-path={f.dir ? undefined : f.path}
                      onClick={() => (f.dir ? setOpen((o) => ({ ...o, [f.path]: !o[f.path] })) : setPath(f.path))}
                      style={{ background: 'transparent', border: 0, color: f.dir ? '#A3A7AF' : '#E7E8EA', textAlign: 'left', borderRadius: 7, height: 28, padding: `0 8px 0 ${8 + f.depth * 14}px`, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flex: 1, minWidth: 0 }} className="mono">
                      <span style={{ width: 14, textAlign: 'center', color: f.dir ? '#8A8F98' : (LETTER_COLOR[l] || '#8A8F98'), fontSize: 11 }}>{f.dir ? (open[f.path] ? '▾' : '▸') : (l || '·')}</span>
                      <span className="ell" style={{ flex: 1 }}>{f.name}</span>
                    </button>
                    {!f.dir ? <button aria-label={`Pin ${f.path} to the canvas`} title="Pin to canvas" onClick={() => pinToCanvas(source, f.path, parentForPin)}
                      style={{ width: 26, height: 26, flex: 'none', background: 'transparent', border: 0, borderRadius: 6, color: '#6E727A', fontSize: 12 }}>⇱</button> : null}
                  </div>
                );
              })}
              {files && !files.length ? <span style={{ fontSize: 12, color: '#8A8F98', padding: '0 8px' }}>No files.</span> : null}
            </div>
          </div>
        ) : null}
        {showViewer ? (
          <div className="scroll" style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', background: '#0B0C0E' }}>
            <div style={{ maxWidth: 860, margin: '0 auto', padding: phone ? '16px' : '28px 32px 60px', display: 'flex', flexDirection: 'column', gap: 14, minHeight: kind === 'model3d' || kind === 'pdf' ? '80%' : undefined, boxSizing: 'border-box' }}>
              {phone && path ? <button className="b" style={{ alignSelf: 'flex-start' }} onClick={() => setPath(null)}><Icon name="back" size={12} />Files</button> : null}
              {path ? (
                <>
                  <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#8A8F98', fontSize: 12 }}>
                    <span className="ell" style={{ flex: 1 }}>{path}</span>
                    <span>{letter(files?.find((f) => f.path === path)?.xy) === 'M' ? 'modified' : ''}</span>
                    {kind === 'doc' ? (
                      <div className="seg" style={{ fontFamily: 'Geist, sans-serif' }}>
                        <button className={raw ? '' : 'on'} onClick={() => setRaw(false)}>Rendered</button>
                        <button className={raw ? 'on' : ''} onClick={() => setRaw(true)}>Source</button>
                      </div>
                    ) : null}
                  </div>
                  {ferr ? <div style={{ color: '#FFB3B6', fontSize: 12.5 }}>Could not read file: {ferr}</div> : null}
                  {co && textual && (raw || kind !== 'doc') ? (
                    content == null && !ferr ? <div style={{ color: '#8A8F98', fontSize: 12.5 }}>Loading…</div> : content != null ? (
                      <div className="mono" style={{ background: '#0E0F12', border: '1px solid #24272D', borderRadius: 12, padding: '14px 0', fontSize: 12.5, lineHeight: 1.7, overflowX: 'auto', userSelect: 'text' }}>
                        {content.split('\n').slice(0, 4000).map((ln, i) => (
                          <div key={i} style={{ display: 'flex', whiteSpace: 'pre' }}><span style={{ width: 44, flex: 'none', textAlign: 'right', color: '#5A5E67', paddingRight: 14, userSelect: 'none' }}>{i + 1}</span><span style={{ color: '#C9CCD2', paddingRight: 16 }}>{ln}</span></div>
                        ))}
                      </div>
                    ) : null
                  ) : (
                    <div style={{ position: 'relative', flex: kind === 'model3d' || kind === 'pdf' ? 1 : undefined, minHeight: kind === 'model3d' || kind === 'pdf' ? 420 : undefined, background: kind === 'code' || (kind === 'doc' && raw) ? '#0E0F12' : undefined, border: kind === 'code' || raw ? '1px solid #24272D' : undefined, borderRadius: 12, padding: kind === 'code' || raw ? '12px 0' : 0 }}>
                      <FileBody source={source} path={path} sha={co ? undefined : branch?.remoteSha} kind={raw && kind === 'doc' ? 'code' : kind} size="lg" nodeKey={`repo:${srcKey}:${path}`} />
                    </div>
                  )}
                </>
              ) : <div style={{ color: '#8A8F98', fontSize: 13, padding: '40px 0', textAlign: 'center' }}>Pick a file to view it.</div>}
            </div>
          </div>
        ) : null}
        {!phone || !path ? (co ? <StatusPanel co={co} phone={phone} onPick={setPath} /> : branch ? <BranchPanel id={branch.id} phone={phone} /> : null) : null}
      </div>
    </div>
  );
}

function StatusPanel({ co, phone, onPick }: { co: Checkout; phone: boolean; onPick: (p: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const branch = useHub((h) => h.branches[`${co.repo_id}#${co.branch}`]);
  const publish = async (dir: string) => {
    setBusy(dir);
    try { await api.publishApp(co.host_id, dir); toast('Published as a preview'); } catch (e) { toast(`Publish failed: ${(e as Error).message}`, 'error'); }
    setBusy(null);
  };
  return (
    <div className="scroll" style={{ width: phone ? 'auto' : 320, flex: 'none', borderLeft: phone ? 0 : '1px solid #1E2025', borderTop: phone ? '1px solid #1E2025' : 0, background: '#0E0F12', overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16, maxHeight: phone ? '40%' : undefined, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <span className="cap">Working tree</span>
        <span data-testid="repo-dirty" style={{ fontSize: 13, fontWeight: 500, color: co.dirty ? '#FFD23F' : '#E7E8EA' }}>{co.dirty ? `${co.dirty} dirty` : 'clean'}</span>
        {co.changes?.map((c) => (
          <button key={c.path} onClick={() => onPick(c.path)} className="mono" style={{ background: 'transparent', border: 0, color: '#E7E8EA', textAlign: 'left', padding: '2px 0', display: 'flex', gap: 8, fontSize: 12 }}>
            <span style={{ width: 14, color: LETTER_COLOR[letter(c.xy)] || '#8A8F98' }}>{letter(c.xy)}</span><span className="ell">{c.path}</span>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="cap">Upstream</span>
        <span style={{ fontSize: 12.5 }}><span className="mono">↑{co.ahead || 0} ↓{co.behind || 0}</span> <span style={{ color: '#8A8F98' }}>vs {co.upstream || 'no upstream'}</span></span>
      </div>
      {branch ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="cap">Pull request · CI</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><PrChip pr={branch.pr} /><CiChip ci={branch.ci} /></div>
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="cap">Apps found</span>
        {co.apps?.length ? co.apps.map((a) => (
          <div key={a.dir} className="card" style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="app" size={14} sw={1.8} style={{ color: '#8A8F98' }} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}><span className="ell" style={{ fontSize: 12.5, fontWeight: 500 }}>{a.title}</span><span className="mono ell" style={{ fontSize: 10.5, color: '#8A8F98' }}>{a.dir}</span></div>
            {a.published ? <button className="b" style={{ height: 24, fontSize: 11.5 }} onClick={() => { if (a.nodeId) focusNode(a.nodeId); }}>On canvas</button>
              : <button className="b bp" style={{ height: 24, fontSize: 11.5 }} disabled={busy === a.dir} onClick={() => publish(a.dir)}>{busy === a.dir ? 'Publishing…' : 'Publish'}</button>}
          </div>
        )) : <span style={{ fontSize: 12, color: '#8A8F98' }}>No app.json found in this checkout.</span>}
      </div>
    </div>
  );
}

function BranchPanel({ id, phone }: { id: string; phone: boolean }) {
  const b = useHub((h) => h.branches[id]);
  if (!b) return null;
  return (
    <div className="scroll" style={{ width: phone ? 'auto' : 320, flex: 'none', borderLeft: phone ? 0 : '1px solid #1E2025', borderTop: phone ? '1px solid #1E2025' : 0, background: '#0E0F12', overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16, maxHeight: phone ? '40%' : undefined, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="cap">Branch</span>
        <span style={{ fontSize: 12.5, color: '#C9CCD2' }}>{b.goal || 'No goal recorded.'}</span>
        <span className="mono" style={{ fontSize: 11.5, color: '#8A8F98' }}>from {b.base || '—'} · ↑{b.aheadBase} ↓{b.behindBase}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="cap">Pull request · CI</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><PrChip pr={b.pr} /><CiChip ci={b.ci} /></div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="cap">Last commits</span>
        <BranchCommits b={b} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="cap">Apps on this branch</span>
        {b.apps.length ? b.apps.map((a) => <span key={a.path} style={{ fontSize: 12.5 }}>{a.title} <span className="mono" style={{ fontSize: 10.5, color: '#8A8F98' }}>{a.path}</span></span>)
          : <span style={{ fontSize: 12, color: '#8A8F98' }}>None found.</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- review page (d386)
function ReviewPage({ id }: { id: string }) {
  const node = useHub((h) => h.cnodes[id]) as CNode<ReviewData> | undefined;
  const session = useHub((h) => (node ? h.sessions[node.data.sessionId] : undefined));
  const hosts = useHub((h) => h.hosts);
  const projectName = useHub((h) => {
    const s = node?.data.source;
    if (!s) return '';
    return s.kind === 'github' ? h.projects[s.projectId]?.name || '' : h.checkouts[s.checkoutId]?.repoName || '';
  });
  const refName = useHub((h) => {
    const s = node?.data.source;
    if (!s) return '';
    return s.kind === 'github' ? s.ref : h.checkouts[s.checkoutId]?.branch || '';
  });
  const phone = useIsPhone();
  const [note, setNote] = useState('');
  const act = useReviewActions(id, node);
  if (!node) return null;
  const d = node.data;
  const st = REVIEW_STATUS[d.status] || REVIEW_STATUS.pending;
  const fkind = kindOf(d.path);
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#0B0C0E' }} data-testid="review-page" data-node-id={id} data-status={d.status}>
      <div className="noscrollbar" style={{ minHeight: 52, flex: 'none', borderBottom: '1px solid #1E2025', background: '#0E0F12', display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', overflowX: 'auto' }}>
        <button className="b ghost" aria-label="Back to the repo browser" style={{ width: 30, padding: 0, justifyContent: 'center', flex: 'none' }} onClick={() => ui.set({ reviewId: null })}><Icon name="back" /></button>
        <span style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' }}>{projectName}</span>
        {refName ? <span className="b mono" style={{ flex: 'none' }}>{refName}</span> : null}
        <span style={{ fontSize: 12, color: '#8A8F98', whiteSpace: 'nowrap' }}>@ <span className="mono">{shortSha(d.sha)}</span>{session ? ` · by ${session.vendor === 'codex' ? 'Codex' : 'Claude Code'} (${computeName(computeKey(session), hosts)})` : ''}</span>
        <div style={{ flex: 1 }} />
        <button className="b" style={{ flex: 'none' }} onClick={() => focusNode(id, true)}>Show on canvas</button>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0, flexDirection: phone ? 'column' : 'row' }}>
        {!phone ? (
          <div className="scroll" style={{ width: 280, flex: 'none', borderRight: '1px solid #1E2025', background: '#0E0F12', overflow: 'auto', padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: 10, boxSizing: 'border-box' }}>
            <SourceList coId={null} ghKey={null} />
          </div>
        ) : null}
        <div className="scroll" style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', background: '#0B0C0E' }}>
          <div style={{ maxWidth: 760, margin: '0 auto', padding: phone ? 16 : '28px 32px 60px', display: 'flex', flexDirection: 'column', gap: 16, minHeight: fkind === 'model3d' ? '80%' : undefined, boxSizing: 'border-box' }}>
            <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#8A8F98', fontSize: 12, flexWrap: 'wrap' }}>
              <span className="ell" style={{ flex: 1 }}>{d.path}</span><span>{d.kind}{d.promoteTo ? ` · approve to promote → ${d.promoteTo}` : ''}</span>
            </div>
            <div style={{ position: 'relative', flex: fkind === 'model3d' ? 1 : undefined, minHeight: fkind === 'model3d' ? 420 : undefined }}>
              <FileBody source={d.source} path={d.path} sha={d.sha} kind={fkind} size="lg" nodeKey={`review:${id}`} />
            </div>
          </div>
        </div>
        <div style={{ width: phone ? 'auto' : 340, flex: 'none', borderLeft: phone ? 0 : '1px solid #1E2025', borderTop: phone ? '1px solid #1E2025' : 0, background: '#0E0F12', display: 'flex', flexDirection: 'column', maxHeight: phone ? '55%' : undefined }}>
          <div className="scroll" style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="cap">Review request</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{session ? <ProviderBadge vendor={session.vendor} size={18} /> : null}<span style={{ fontWeight: 500 }}>{session?.title || d.title}</span></div>
              {d.note ? <span style={{ fontSize: 12, color: '#A3A7AF', lineHeight: 1.45 }}>{d.note}</span> : null}
              <span data-testid="review-status" style={{ fontSize: 12, fontWeight: 500, color: st.fg }}>{st.label}</span>
            </div>
            {d.checklist.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <span className="cap">Checklist from agent</span>
                {d.checklist.map((c, i) => (
                  <label key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.4 }}>
                    <input type="checkbox" data-testid="review-check" checked={c.done} onChange={() => act.toggleCheck(i)} style={{ accentColor: '#E7E8EA', marginTop: 2 }} />{c.text}
                  </label>
                ))}
              </div>
            ) : null}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="cap">Comments</span>
              <Comments d={d} big />
              <CommentInput onSend={act.comment} />
            </div>
          </div>
          <div style={{ padding: 12, borderTop: '1px solid #24272D', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea aria-label="Note to agent" data-testid="review-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to the agent (sent with your decision)…"
              style={{ height: 64, resize: 'none', boxSizing: 'border-box', background: '#0B0C0E', border: '1px solid #2A2D33', borderRadius: 9, color: '#E7E8EA', padding: '8px 10px', fontFamily: 'inherit', fontSize: 12.5, outline: 'none' }} />
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="b bp" style={{ flex: 1, justifyContent: 'center', height: 34 }} disabled={act.busy} data-testid="review-approve" onClick={async () => { if (await act.decide('approve', note)) setNote(''); }}>Approve</button>
              <button className="b" style={{ flex: 1, justifyContent: 'center', height: 34 }} disabled={act.busy} data-testid="review-changes" onClick={async () => { if (await act.decide('changes', note)) setNote(''); }}>Request changes</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
