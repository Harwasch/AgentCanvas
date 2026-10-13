// Repo browser (design 02): checkouts → file tree, file viewer, status panel.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { toast, ui, useHub, useUI } from '../store';
import type { Checkout } from '../types';
import { Icon, shortSha, timeAgo, useIsPhone } from '../ui';

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

export function ReposView() {
  const checkouts = useHub((h) => h.checkouts);
  const hosts = useHub((h) => h.hosts);
  const sel = useUI((u) => u.repoCheckout);
  const phone = useIsPhone();
  const list = useMemo(() => Object.values(checkouts).sort((a, b) => a.repoName.localeCompare(b.repoName) || a.host_id.localeCompare(b.host_id)), [checkouts]);
  const co = (sel && checkouts[sel]) || list[0];
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [path, setPath] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [ferr, setFerr] = useState<string | null>(null);

  useEffect(() => {
    setFiles(null); setPath(null); setContent(null); setOpen({});
    if (!co) return;
    let alive = true;
    api.files(co.id).then((r) => {
      if (!alive) return;
      const fl = r.files || [];
      setFiles(fl);
      const readme = fl.find((f) => /^readme(\.md)?$/i.test(f.path));
      if (readme && !phone) setPath(readme.path);
      // open dirs containing changed files
      const o: Record<string, boolean> = {};
      fl.filter((f) => f.xy).forEach((f) => { const p = f.path.split('/'); for (let i = 1; i < p.length; i++) o[p.slice(0, i).join('/')] = true; });
      setOpen(o);
    }).catch((e) => { if (alive) { setFiles([]); toast(`Could not list files: ${(e as Error).message}`, 'error'); } });
    return () => { alive = false; };
  }, [co?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setContent(null); setFerr(null);
    if (!co || !path) return;
    let alive = true;
    api.file(co.id, path).then((r) => { if (alive) setContent(r.content); }).catch((e) => { if (alive) setFerr((e as Error).message); });
    return () => { alive = false; };
  }, [co?.id, path]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!co) return <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8A8F98' }}>No checkouts indexed yet.</div>;
  const host = hosts[co.host_id];
  const tree = files ? buildTree(files, open) : [];
  const showTree = !phone || !path;
  const showViewer = !phone || !!path;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#0B0C0E' }} data-testid="repos-view">
      <div className="noscrollbar" style={{ minHeight: 52, flex: 'none', borderBottom: '1px solid #1E2025', background: '#0E0F12', display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', overflowX: 'auto' }}>
        <button className="b ghost" aria-label="Back to canvas" style={{ width: 30, padding: 0, justifyContent: 'center', flex: 'none' }} onClick={() => ui.set({ tab: 'canvas' })}><Icon name="back" /></button>
        <span style={{ fontSize: 12, color: '#A3A7AF', border: '1px solid #24272D', borderRadius: 7, padding: '4px 8px', whiteSpace: 'nowrap' }}>GH · {ghOwner(co)}</span>
        <span style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' }}>{co.repoName}</span>
        <span className="b mono" data-testid="repo-branch" style={{ flex: 'none' }}>{co.branch || '(detached)'}<Icon name="chev" size={12} /></span>
        <span data-testid="repo-head" style={{ fontSize: 12, color: '#8A8F98', whiteSpace: 'nowrap' }}>@ <span className="mono">{shortSha(co.head)}</span> · {co.head_subject} {co.head_time ? `· ${timeAgo(co.head_time)}` : ''}</span>
        <div style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#C9CCD2', whiteSpace: 'nowrap' }}><span className="dot" style={{ background: host?.color || '#8A8F98' }} />{host?.label || co.host_id}<span className="mono" style={{ color: '#6E727A', fontSize: 11 }}>{co.path}</span></span>
        <button className="b" style={{ flex: 'none' }} onClick={() => api.refreshCheckout(co.id).then(() => toast('Refreshed')).catch((e) => toast(String(e.message), 'error'))}>Refresh</button>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0, flexDirection: phone ? 'column' : 'row' }}>
        {showTree ? (
          <div className="scroll" style={{ width: phone ? 'auto' : 280, flex: phone ? 1 : 'none', borderRight: '1px solid #1E2025', background: '#0E0F12', overflow: 'auto', padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: 10, boxSizing: 'border-box' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="cap" style={{ padding: '0 6px 4px' }}>Checkouts</span>
              {list.map((c) => (
                <button key={c.id} onClick={() => ui.set({ repoCheckout: c.id })} data-testid="repo-checkout" style={{ background: c.id === co.id ? '#1A1C21' : 'transparent', border: 0, borderRadius: 7, color: '#E7E8EA', textAlign: 'left', padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="dot" style={{ background: hosts[c.host_id]?.color || '#8A8F98' }} />
                  <span className="ell" style={{ flex: 1, fontSize: 12.5 }}>{c.repoName}</span>
                  <span className="mono ell" style={{ fontSize: 10.5, color: '#8A8F98', maxWidth: 90 }}>{c.branch}</span>
                </button>
              ))}
            </div>
            <div style={{ height: 1, background: '#1E2025' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {!files ? <span style={{ fontSize: 12, color: '#8A8F98', padding: '0 8px' }}>Loading files…</span> : null}
              {tree.map((f) => {
                const l = letter(f.xy);
                const on = f.path === path;
                return (
                  <button key={f.path + (f.dir ? '/' : '')} data-testid={f.dir ? undefined : 'repo-file'}
                    onClick={() => (f.dir ? setOpen((o) => ({ ...o, [f.path]: !o[f.path] })) : setPath(f.path))}
                    style={{ background: on ? '#1A1C21' : 'transparent', border: 0, color: f.dir ? '#A3A7AF' : '#E7E8EA', textAlign: 'left', borderRadius: 7, height: 28, padding: `0 8px 0 ${8 + f.depth * 14}px`, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flex: 'none' }} className="mono">
                    <span style={{ width: 14, textAlign: 'center', color: f.dir ? '#8A8F98' : (LETTER_COLOR[l] || '#8A8F98'), fontSize: 11 }}>{f.dir ? (open[f.path] ? '▾' : '▸') : (l || '·')}</span>
                    <span className="ell" style={{ flex: 1 }}>{f.name}</span>
                  </button>
                );
              })}
              {files && !files.length ? <span style={{ fontSize: 12, color: '#8A8F98', padding: '0 8px' }}>No files.</span> : null}
            </div>
          </div>
        ) : null}
        {showViewer ? (
          <div className="scroll" style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', background: '#0B0C0E' }}>
            <div style={{ maxWidth: 860, margin: '0 auto', padding: phone ? '16px' : '28px 32px 60px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {phone && path ? <button className="b" style={{ alignSelf: 'flex-start' }} onClick={() => setPath(null)}><Icon name="back" size={12} />Files</button> : null}
              {path ? (
                <>
                  <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#8A8F98', fontSize: 12 }}><span className="ell" style={{ flex: 1 }}>{path}</span><span>{letter(files?.find((f) => f.path === path)?.xy) === 'M' ? 'modified' : ''}</span></div>
                  {ferr ? <div style={{ color: '#FFB3B6', fontSize: 12.5 }}>Could not read file: {ferr}</div> : null}
                  {content == null && !ferr ? <div style={{ color: '#8A8F98', fontSize: 12.5 }}>Loading…</div> : null}
                  {content != null ? (
                    <div className="mono" style={{ background: '#0E0F12', border: '1px solid #24272D', borderRadius: 12, padding: '14px 0', fontSize: 12.5, lineHeight: 1.7, overflowX: 'auto', userSelect: 'text' }}>
                      {content.split('\n').slice(0, 4000).map((ln, i) => (
                        <div key={i} style={{ display: 'flex', whiteSpace: 'pre' }}><span style={{ width: 44, flex: 'none', textAlign: 'right', color: '#5A5E67', paddingRight: 14, userSelect: 'none' }}>{i + 1}</span><span style={{ color: '#C9CCD2', paddingRight: 16 }}>{ln}</span></div>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : <div style={{ color: '#8A8F98', fontSize: 13, padding: '40px 0', textAlign: 'center' }}>Pick a file to view it.</div>}
            </div>
          </div>
        ) : null}
        {!phone || !path ? <StatusPanel co={co} phone={phone} onPick={setPath} /> : null}
      </div>
    </div>
  );
}

function StatusPanel({ co, phone, onPick }: { co: Checkout; phone: boolean; onPick: (p: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="cap">Apps found</span>
        {co.apps?.length ? co.apps.map((a) => (
          <div key={a.dir} className="card" style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="app" size={14} sw={1.8} style={{ color: '#8A8F98' }} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}><span className="ell" style={{ fontSize: 12.5, fontWeight: 500 }}>{a.title}</span><span className="mono ell" style={{ fontSize: 10.5, color: '#8A8F98' }}>{a.dir}</span></div>
            {a.published ? <button className="b" style={{ height: 24, fontSize: 11.5 }} onClick={() => { if (a.nodeId) { ui.set({ tab: 'canvas', focusId: a.nodeId, panTo: { id: a.nodeId, n: Date.now() } }); } }}>On canvas</button>
              : <button className="b bp" style={{ height: 24, fontSize: 11.5 }} disabled={busy === a.dir} onClick={() => publish(a.dir)}>{busy === a.dir ? 'Publishing…' : 'Publish'}</button>}
          </div>
        )) : <span style={{ fontSize: 12, color: '#8A8F98' }}>No app.json found in this checkout.</span>}
      </div>
    </div>
  );
}
