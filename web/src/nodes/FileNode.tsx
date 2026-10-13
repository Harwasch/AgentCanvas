// "View any file as a node": pinned to a commit, rendered by kind, with a "Newer version" bar.
import { memo, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { baseName } from '../files';
import { mergeLocal, toast, useHub } from '../store';
import type { CNode, FileData } from '../types';
import { Icon, shortSha, timeAgo } from '../ui';
import { Chevron, FolderChip, RemoveBtn, SheetBack, stop, useLive, type NodeMode } from './common';
import { FileBody, useFileText } from './FileBody';
import { mdHeadings } from './Markdown';

export function sourceLabel(d: FileData, h: { checkouts: Record<string, { repoName: string; branch: string; host_id: string }>; projects: Record<string, { name: string }> }) {
  const s = d.source;
  if (!s) return '';
  if (s.kind === 'checkout') { const c = h.checkouts[s.checkoutId]; return c ? `${c.host_id}:${c.branch}` : 'checkout'; }
  return s.ref;
}

export function PinChip({ node }: { node: CNode<FileData> }) {
  const d = node.data;
  const ref = useHub((h) => sourceLabel(d, h));
  const [busy, setBusy] = useState(false);
  const latest = async () => {
    setBusy(true);
    try { mergeLocal('cnodes', await api.latest(node.id)); } catch (e) { toast(`Get latest failed: ${(e as Error).message}`, 'error'); }
    setBusy(false);
  };
  return (
    <div style={{ position: 'absolute', left: 8, bottom: '100%', marginBottom: 7, display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap', zIndex: 6 }} onPointerDown={stop}>
      <span className="mono" data-testid="file-pin" style={{ fontSize: 11, color: '#A3A7AF', background: '#111215', border: '1px solid #2A2D33', borderRadius: 999, padding: '2px 9px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <Icon name="pin" size={10} sw={2.4} />{ref ? `${ref} · ` : ''}{d.path.split('/').slice(-2).join('/')} @ {shortSha(d.sha)}
      </span>
      {d.newer ? (
        <>
          <span data-testid="file-newer" style={{ fontSize: 11.5, fontWeight: 500, color: '#0B0C0E', background: '#E7E8EA', borderRadius: 999, padding: '2px 10px' }}>Newer version · {shortSha(d.newer.sha)}</span>
          <span className="ell" style={{ fontSize: 11, color: '#A3A7AF', maxWidth: 240 }}>{d.newer.subject}{d.newer.at ? ` · ${timeAgo(d.newer.at)}` : ''}</span>
          <button className="b bp" data-testid="file-latest" style={{ height: 24, padding: '0 9px', fontSize: 11.5 }} disabled={busy} onClick={latest}>{busy ? 'Updating…' : 'Get latest'}</button>
        </>
      ) : null}
    </div>
  );
}

const KIND_ICON_PATH: Record<string, JSX.Element> = {
  doc: <><path d="M6 3h9l4 4v14H6z" /><path d="M9 11h7M9 15h7M9 7h3" /></>,
  model3d: <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 16l5-5 4 4 3-3 6 6" /></>,
  code: <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />,
  pdf: <><path d="M6 3h9l4 4v14H6z" /><path d="M9 14h6" /></>,
};
function KindIcon({ kind }: { kind: string }) {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C9CCD2" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>{KIND_ICON_PATH[kind] || KIND_ICON_PATH.doc}</svg>;
}

function FileNodeImpl({ id, mode }: { id: string; mode: NodeMode }) {
  const node = useHub((h) => h.cnodes[id]) as CNode<FileData> | undefined;
  const bodyRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const live = useLive(outerRef, id, mode);
  const [wire, setWire] = useState(false);
  const [resetN, setResetN] = useState(0);
  const [info, setInfo] = useState('');
  const [sec, setSec] = useState(0);
  const d = node?.data;
  const isDoc = d?.kind === 'doc';
  const { text } = useFileText(d?.source, d?.path, d?.sha, !!d && isDoc);
  const toc = useMemo(() => (text ? mdHeadings(text) : []), [text]);
  if (!node || !d) return null;
  const big = mode !== 'collapsed';
  const title = (isDoc && toc.find((t) => t.level === 1)?.text) || baseName(d.path);
  const sheet = mode === 'sheet';

  const pathRow = (
    <div className="mono" style={{ fontSize: 10.5, color: '#8A8F98', display: 'flex', gap: 6, alignItems: 'center', minWidth: 0, flex: 'none' }}>
      <FolderChip path={d.path} /><span className="ell" title={d.path}>{d.path}</span>
    </div>
  );
  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 'none' }}>
      <SheetBack id={id} mode={mode} />
      <KindIcon kind={d.kind} />
      <span className="ell" style={{ fontWeight: 600, fontSize: 13.5, flex: 1 }} title={title}>{title}</span>
      {d.kind === 'model3d' && info ? <span className="mono" style={{ fontSize: 10.5, color: '#8A8F98' }}>{info}</span> : null}
      <RemoveBtn id={id} />
      <Chevron id={id} mode={mode} />
    </div>
  );

  let body: JSX.Element;
  if (d.kind === 'doc') {
    body = !big ? (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minHeight: 0, overflow: 'hidden' }}>
        {(toc.length ? toc.filter((t) => t.level <= 2).slice(0, 5) : [{ level: 1, text: text ? text.split('\n').find((l) => l.trim()) || '' : 'Loading…' }]).map((t, i) => (
          <span key={i} className="ell" style={{ fontSize: 12, color: '#A3A7AF', paddingLeft: t.level > 1 ? 10 : 0 }}>{t.text}</span>
        ))}
      </div>
    ) : (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 12, borderTop: '1px solid #24272D', paddingTop: 10 }} onPointerDown={stop}>
        {!sheet && toc.length > 1 ? (
          <div className="scroll" data-wheel="inner" style={{ width: 170, flex: 'none', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {toc.map((t, i) => (
              <button key={i} onClick={() => {
                setSec(i);
                const hs = bodyRef.current?.querySelectorAll('h1,h2,h3');
                (hs?.[i] as HTMLElement | undefined)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
              }} style={{ textAlign: 'left', border: 0, borderRadius: 7, padding: `6px 8px 6px ${8 + (t.level - 1) * 8}px`, fontSize: 12, background: sec === i ? '#22252B' : 'transparent', color: sec === i ? '#FFFFFF' : '#A3A7AF' }}>{t.text}</button>
            ))}
          </div>
        ) : null}
        <div ref={bodyRef} className="scroll" data-wheel="inner" style={{ flex: 1, minWidth: 0, overflow: 'auto', paddingRight: 4, userSelect: 'text' }}>
          <FileBody source={d.source} path={d.path} sha={d.sha} kind="doc" />
        </div>
      </div>
    );
  } else if (d.kind === 'model3d') {
    body = (
      <>
        <div style={{ flex: 1, minHeight: 0, position: 'relative', borderRadius: 10, overflow: 'hidden', background: '#0B0C0E', border: '1px solid #24272D' }}>
          <FileBody source={d.source} path={d.path} sha={d.sha} kind="model3d" live={live} nodeKey={id} wire={wire} resetN={resetN} onInfo={setInfo} />
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 'none' }} onPointerDown={stop}>
          <button className="b" style={{ height: 26 }} disabled={!live} onClick={() => setWire(!wire)}>{wire ? 'Solid' : 'Wireframe'}</button>
          <button className="b" style={{ height: 26 }} disabled={!live} onClick={() => setResetN((n) => n + 1)}>Reset view</button>
          <span style={{ flex: 1 }} />
          <span className="ell desk-only" style={{ fontSize: 11, color: '#8A8F98' }}>{live ? 'Drag to orbit · right-drag pan · scroll zoom' : 'Static preview'}</span>
        </div>
      </>
    );
  } else if (d.kind === 'image') {
    body = (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0E0F12', border: '1px solid #24272D', borderRadius: 8, overflow: 'hidden', padding: 6 }}>
        <FileBody source={d.source} path={d.path} sha={d.sha} kind="image" />
      </div>
    );
  } else if (d.kind === 'code' || d.kind === 'text') {
    body = (
      <div className="scroll" data-wheel="inner" onPointerDown={stop} style={{ flex: 1, minHeight: 0, overflow: 'auto', margin: '0 -14px -12px', padding: '4px 0 10px', background: '#0E0F12', borderTop: '1px solid #1E2025' }}>
        <FileBody source={d.source} path={d.path} sha={d.sha} kind={d.kind} maxCodeLines={big ? 4000 : 120} />
      </div>
    );
  } else {
    body = (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }} onPointerDown={stop}>
        <FileBody source={d.source} path={d.path} sha={d.sha} kind={d.kind} live={live && big} />
      </div>
    );
  }

  return (
    <div ref={outerRef} style={{ position: 'relative', height: '100%' }}>
      {!sheet ? <PinChip node={node} /> : null}
      <div data-testid="file-node" data-node-id={id} data-kind={d.kind} data-live={live ? '1' : '0'}
        style={{
          height: '100%', boxSizing: 'border-box', overflow: 'hidden', background: d.kind === 'code' ? '#0E0F12' : d.kind === 'model3d' ? '#121418' : '#15171B',
          border: sheet ? 0 : '1px solid #2A2D33', borderRadius: sheet ? 0 : 14, padding: sheet ? '12px 14px calc(12px + env(safe-area-inset-bottom))' : '10px 14px 12px',
          display: 'flex', flexDirection: 'column', gap: 8, boxShadow: sheet ? 'none' : '0 8px 24px rgba(0,0,0,.3)',
        }}>
        {header}
        {pathRow}
        {sheet && d.newer ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}><span style={{ color: '#8A8F98' }}>Newer version · {shortSha(d.newer.sha)}</span>
            <button className="b bp" style={{ height: 26 }} onClick={() => api.latest(id).then((c) => mergeLocal('cnodes', c)).catch((e) => toast(String(e.message), 'error'))}>Get latest</button></div>
        ) : null}
        {body}
      </div>
    </div>
  );
}

export const FileNode = memo(FileNodeImpl);
