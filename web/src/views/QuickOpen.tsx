// QUICK OPEN: place any file (from a host checkout or a project's GitHub branch) as a canvas node.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { KIND_ICON, KIND_LABEL, kindOf, sourceKey } from '../files';
import { focusNode, mergeLocal, toast, ui, useHub, useUI } from '../store';
import type { FileKind, FileSource } from '../types';
import { shortSha } from '../ui';

export function QuickOpen() {
  const req = useUI((u) => u.quickOpen);
  if (!req) return null;
  return <QuickOpenForm />;
}

interface SrcOpt { key: string; label: string; source: FileSource; head: string | null }

function QuickOpenForm() {
  const req = useUI((u) => u.quickOpen)!;
  const checkouts = useHub((h) => h.checkouts);
  const hosts = useHub((h) => h.hosts);
  const projects = useHub((h) => h.projects);
  const branches = useHub((h) => h.branches);
  const attachName = useHub((h) => {
    const p = req.parentId;
    if (!p) return 'nothing (free node)';
    return h.projects[p]?.name || h.branches[p]?.name || h.sessions[p]?.title || h.cnodes[p]?.data?.title || p;
  });
  const opts = useMemo<SrcOpt[]>(() => {
    const out: SrcOpt[] = [];
    Object.values(checkouts).sort((a, b) => a.repoName.localeCompare(b.repoName) || a.host_id.localeCompare(b.host_id)).forEach((c) => {
      out.push({ key: `co:${c.id}`, label: `${c.repoName} · ${hosts[c.host_id]?.label || c.host_id} · ${c.path}${c.branch ? ` (${c.branch})` : ''}`, source: { kind: 'checkout', checkoutId: c.id }, head: c.head });
    });
    Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)).forEach((p) => {
      if (!p.gh) return;
      const bs = Object.values(branches).filter((b) => b.projectId === p.id && b.pushed)
        .sort((a, b) => (a.name === p.defaultBranch ? -1 : b.name === p.defaultBranch ? 1 : a.name.localeCompare(b.name)));
      const refs = bs.length ? bs : [{ name: p.defaultBranch, remoteSha: null } as { name: string; remoteSha: string | null }];
      refs.forEach((b) => out.push({ key: `gh:${p.id}@${b.name}`, label: `${p.name} @ ${b.name} (GitHub)`, source: { kind: 'github', projectId: p.id, ref: b.name }, head: b.remoteSha }));
    });
    if (req.source && !out.find((o) => o.key === sourceKey(req.source!))) out.unshift({ key: sourceKey(req.source), label: sourceKey(req.source), source: req.source, head: null });
    return out;
  }, [checkouts, hosts, projects, branches, req.source]);

  const [srcKey, setSrcKey] = useState(() => (req.source ? sourceKey(req.source) : opts[0]?.key || ''));
  const src = opts.find((o) => o.key === srcKey) || opts[0];
  const [q, setQ] = useState('');
  const [files, setFiles] = useState<{ path: string; kind: FileKind }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (!src) return;
    let alive = true;
    setErr(null);
    const t = setTimeout(() => {
      api.listFiles(src.source, q.trim()).then((r) => { if (alive) { setFiles(r.files || []); setSel(0); } })
        .catch((e) => { if (alive) { setFiles([]); setErr((e as Error).message); } });
    }, 120);
    return () => { alive = false; clearTimeout(t); };
  }, [src?.key, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = (files || []).slice(0, 300);
  const close = () => ui.set({ quickOpen: null });
  const place = async (path: string) => {
    if (!src || busy) return;
    setBusy(true);
    try {
      const c = await api.createCNode({ type: 'file', parentId: req.parentId ?? null, data: { source: src.source, path } });
      mergeLocal('cnodes', c);
      close();
      setTimeout(() => focusNode(c.id), 80);
    } catch (e) { toast(`Could not place ${path}: ${(e as Error).message}`, 'error'); setBusy(false); }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(list.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (list[sel]) void place(list[sel].path); }
  };
  useEffect(() => { (listRef.current?.querySelector(`[data-idx="${sel}"]`) as HTMLElement | null)?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  return (
    <div className="modal-back" style={{ paddingTop: 100 }} onPointerDown={close}>
      <div role="dialog" aria-label="Place a file" data-testid="quick-open" onPointerDown={(e) => e.stopPropagation()} onKeyDown={onKey}
        className="qo" style={{ width: 600, maxWidth: 'calc(100% - 32px)', background: '#15171B', border: '1px solid #3A3E46', borderRadius: 12, boxShadow: '0 24px 60px rgba(0,0,0,.6)', display: 'flex', flexDirection: 'column', overflow: 'hidden', alignSelf: 'flex-start', maxHeight: 'calc(100% - 120px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 0', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, color: '#8A8F98' }}>Place file from</span>
          <select className="sel mono" data-testid="qo-source" aria-label="Source" value={src?.key || ''} onChange={(e) => setSrcKey(e.target.value)} style={{ maxWidth: 360, flex: '1 1 200px', minWidth: 0 }}>
            {opts.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
          {src?.head ? <span className="mono" style={{ fontSize: 11, color: '#8A8F98' }}>@ {shortSha(src.head)}</span> : null}
          <span style={{ flex: 1 }} />
          <span className="ell" style={{ fontSize: 11, color: '#6E727A', maxWidth: 200 }}>attaches to {attachName}</span>
        </div>
        <div style={{ padding: '8px 12px 10px', borderBottom: '1px solid #24272D' }}>
          <input ref={inputRef} data-testid="qo-input" aria-label="Search files" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search files…"
            style={{ width: '100%', boxSizing: 'border-box', height: 36, background: '#0B0C0E', border: '1px solid #2A2D33', borderRadius: 8, color: '#E7E8EA', padding: '0 12px', fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 13, outline: 'none' }} />
        </div>
        <div ref={listRef} className="scroll" style={{ maxHeight: 420, overflow: 'auto', padding: 6 }}>
          {files == null ? <div style={{ padding: 16, fontSize: 12.5, color: '#8A8F98', display: 'flex', gap: 8, alignItems: 'center' }}><span className="spin" />Listing files…</div> : null}
          {err ? <div style={{ padding: 16, fontSize: 12.5, color: '#FFB3B6' }}>{err}</div> : null}
          {list.map((f, i) => {
            const k = f.kind || kindOf(f.path);
            return (
              <button key={f.path} data-testid="qo-item" data-path={f.path} data-idx={i} onMouseEnter={() => setSel(i)} onClick={() => place(f.path)}
                style={{ width: '100%', background: i === sel ? '#22252B' : 'transparent', border: 0, borderRadius: 7, color: '#E7E8EA', display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', textAlign: 'left' }}>
                <span className="mono" style={{ width: 22, textAlign: 'center', fontSize: 11, color: '#8A8F98', flex: 'none' }}>{KIND_ICON[k]}</span>
                <span className="mono ell" style={{ fontSize: 12.5, flex: 1 }}>{f.path}</span>
                <span style={{ fontSize: 11, color: '#8A8F98', flex: 'none' }}>{KIND_LABEL[k]}</span>
              </button>
            );
          })}
          {files && !files.length && !err ? <div style={{ padding: 16, fontSize: 12.5, color: '#8A8F98' }}>No files match.</div> : null}
        </div>
        <div className="desk-only" style={{ padding: '8px 12px', borderTop: '1px solid #24272D', fontSize: 11, color: '#6E727A' }}>↑↓ move · Enter place · Esc close · the node is pinned to this commit; you’ll see when a newer version lands</div>
      </div>
    </div>
  );
}
