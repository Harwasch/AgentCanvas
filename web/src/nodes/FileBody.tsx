// Renderers for "any file as a node": markdown docs, images, code, STL models, PDFs, text, binary.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { fetchRawBytes, fetchRawText, rawUrl } from '../api';
import { extOf, sourceKey } from '../files';
import type { FileKind, FileSource } from '../types';
import { Markdown } from './Markdown';
import type { StlView } from './stlViewer';
import { stop } from './common';

// ---------------------------------------------------------------- fetch cache
const textCache = new Map<string, Promise<string>>();
const keyOf = (s: FileSource, p: string, sha?: string | null) => `${sourceKey(s)}|${p}|${sha || ''}`;

export function useFileText(source: FileSource | null | undefined, path: string | null | undefined, sha?: string | null, enabled = true) {
  const [state, setState] = useState<{ text: string | null; error: string | null }>({ text: null, error: null });
  const key = source && path ? keyOf(source, path, sha) : '';
  useEffect(() => {
    if (!source || !path || !enabled) return;
    let alive = true;
    let p = textCache.get(key);
    if (!p) {
      p = fetchRawText(source, path, sha);
      textCache.set(key, p);
      p.catch(() => textCache.delete(key));
    }
    setState({ text: null, error: null });
    p.then((t) => { if (alive) setState({ text: t, error: null }); }).catch((e) => { if (alive) setState({ text: null, error: (e as Error).message || 'failed' }); });
    return () => { alive = false; };
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

// ---------------------------------------------------------------- code
const KW = /\b(if|else|for|while|do|return|break|continue|switch|case|default|function|const|let|var|class|def|import|from|export|as|struct|typedef|enum|static|void|float|int|double|char|bool|true|false|null|None|True|False|self|this|new|async|await|try|except|catch|finally|raise|throw|lambda|pass|in|is|not|and|or|interface|type|public|private|fn|pub|use|mod|impl|match|unsigned|uint8_t|uint16_t|uint32_t|int32_t)\b/;
interface Tok { t: string; c: string }
function highlightLine(line: string, lang: string, state: { block: boolean }): Tok[] {
  const out: Tok[] = [];
  const hashComment = ['py', 'sh', 'bash', 'zsh', 'yaml', 'yml', 'toml', 'rb', 'mk', 'cmake', 'ini'].includes(lang);
  let i = 0;
  const push = (t: string, c: string) => { if (t) out.push({ t, c }); };
  while (i < line.length) {
    if (state.block) {
      const end = line.indexOf('*/', i);
      if (end < 0) { push(line.slice(i), '#6E727A'); return out; }
      push(line.slice(i, end + 2), '#6E727A'); i = end + 2; state.block = false; continue;
    }
    const rest = line.slice(i);
    if (!hashComment && rest.startsWith('/*')) { state.block = true; continue; }
    if ((!hashComment && rest.startsWith('//')) || (hashComment && rest.startsWith('#')) || (lang === 'sql' && rest.startsWith('--'))) { push(rest, '#6E727A'); return out; }
    if (/^#\s*(include|define|ifdef|ifndef|endif|pragma|if|else)\b/.test(rest) && !hashComment) { push(rest, '#8FE3CF'); return out; }
    const q = rest[0];
    if (q === '"' || q === "'" || q === '`') {
      let j = 1;
      while (j < rest.length && rest[j] !== q) j += rest[j] === '\\' ? 2 : 1;
      push(rest.slice(0, j + 1), '#8FE3CF'); i += j + 1; continue;
    }
    const num = rest.match(/^\d[\d._xXa-fA-F]*[fFuUlL]*/);
    if (num && !/\w/.test(line[i - 1] || '')) { push(num[0], '#E8B04B'); i += num[0].length; continue; }
    const word = rest.match(/^[A-Za-z_]\w*/);
    if (word) { push(word[0], KW.test(word[0]) ? '#C9A7FF' : '#C9CCD2'); i += word[0].length; continue; }
    push(rest[0], '#A3A7AF'); i += 1;
  }
  return out;
}

export function CodeView({ text, path, fontSize = 11.5, maxLines = 4000, style }: { text: string; path: string; fontSize?: number; maxLines?: number; style?: CSSProperties }) {
  const lines = useMemo(() => {
    const lang = extOf(path);
    const st = { block: false };
    return text.split('\n').slice(0, maxLines).map((ln) => highlightLine(ln.replace(/\t/g, '  '), lang, st));
  }, [text, path, maxLines]);
  const w = String(lines.length).length * 8 + 16;
  return (
    <div className="mono" style={{ fontSize, lineHeight: 1.65, display: 'flex', flexDirection: 'column', userSelect: 'text', ...style }}>
      {lines.map((toks, i) => (
        <span key={i} style={{ display: 'flex', whiteSpace: 'pre' }}>
          <span style={{ width: w, textAlign: 'right', color: '#5A5E67', paddingRight: 12, flex: 'none', userSelect: 'none' }}>{i + 1}</span>
          <span style={{ paddingRight: 12 }}>{toks.length ? toks.map((t, j) => <span key={j} style={{ color: t.c }}>{t.t}</span>) : ' '}</span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- 3D model
const snapshots = new Map<string, string>();
export function ModelView({ source, path, sha, live, nodeKey, wire, resetN, onInfo }: {
  source: FileSource; path: string; sha?: string | null; live: boolean; nodeKey: string; wire: boolean; resetN: number; onInfo?: (s: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<StlView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [snap, setSnap] = useState<string | null>(() => snapshots.get(nodeKey) || null);
  const infoRef = useRef(onInfo);
  infoRef.current = onInfo;
  useEffect(() => {
    if (!live || !ref.current) return;
    let alive = true;
    const canvas = ref.current;
    if (extOf(path) !== 'stl') { setErr('Only STL is rendered in the browser'); return; }
    Promise.all([import('./stlViewer'), fetchRawBytes(source, path, sha)]).then(([m, buf]) => {
      if (!alive) return;
      try {
        viewRef.current = m.mountStl(canvas, buf);
        infoRef.current?.(`STL · ${viewRef.current.info.tris.toLocaleString()} tris`);
      } catch (e) { setErr((e as Error).message); }
    }).catch((e) => { if (alive) setErr((e as Error).message); });
    return () => {
      alive = false;
      const v = viewRef.current;
      viewRef.current = null;
      if (v) {
        const s = v.snapshot();
        if (s) { snapshots.set(nodeKey, s); setSnap(s); }
        v.dispose();
      }
    };
  }, [live, source && sourceKey(source), path, sha]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { viewRef.current?.setWire(wire); }, [wire]);
  useEffect(() => { if (resetN) viewRef.current?.reset(); }, [resetN]);
  return (
    <div style={{ position: 'absolute', inset: 0 }} onPointerDown={live ? stop : undefined} data-wheel={live ? 'inner' : undefined}>
      {live ? <canvas ref={ref} aria-label={`Interactive 3D view of ${path}`} style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab' }} /> : null}
      {!live ? (snap ? <img src={snap} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }} />
        : <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: '#6E727A', fontSize: 12 }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#3A3E46" strokeWidth="1.2" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></svg>
          Zoom in to load the 3D view
        </div>) : null}
      {err ? <div style={{ position: 'absolute', left: 10, bottom: 8, fontSize: 11.5, color: '#FFB3B6' }}>{err}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- generic body
export function FileBody({ source, path, sha, kind, live = true, size = 'sm', nodeKey, wire = false, resetN = 0, onInfo, maxCodeLines }: {
  source: FileSource; path: string; sha?: string | null; kind: FileKind; live?: boolean; size?: 'sm' | 'lg'; nodeKey?: string;
  wire?: boolean; resetN?: number; onInfo?: (s: string) => void; maxCodeLines?: number;
}) {
  const textual = kind === 'doc' || kind === 'code' || kind === 'text';
  const { text, error } = useFileText(source, path, sha, textual);
  const [bytes, setBytes] = useState<number | null>(null);
  useEffect(() => {
    if (kind !== 'binary') return;
    let alive = true;
    fetchRawBytes(source, path, sha).then((b) => { if (alive) setBytes(b.byteLength); }).catch(() => { /* */ });
    return () => { alive = false; };
  }, [kind, source && sourceKey(source), path, sha]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div style={{ fontSize: 12, color: '#FFB3B6' }}>Could not load {path}: {error}</div>;
  if (kind === 'image') {
    return <img src={rawUrl(source, path, sha)} alt={path} draggable={false} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block', margin: '0 auto', borderRadius: 8, pointerEvents: 'none' }} />;
  }
  if (kind === 'model3d') return <ModelView source={source} path={path} sha={sha} live={live} nodeKey={nodeKey || path} wire={wire} resetN={resetN} onInfo={onInfo} />;
  if (kind === 'pdf') {
    const url = rawUrl(source, path, sha);
    return live
      ? <iframe title={path} src={url} referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', border: 0, borderRadius: 8, background: '#fff' }} />
      : <a className="b lnk" href={url} target="_blank" rel="noopener noreferrer" onPointerDown={stop} style={{ alignSelf: 'flex-start' }}>Open PDF ↗</a>;
  }
  if (kind === 'binary') return <div style={{ fontSize: 12, color: '#8A8F98' }}>binary{bytes != null ? `, ${bytes.toLocaleString()} bytes` : ''} · <a href={rawUrl(source, path, sha)} target="_blank" rel="noopener noreferrer" onPointerDown={stop}>download</a></div>;
  if (text == null) return <div style={{ fontSize: 12, color: '#8A8F98', display: 'flex', gap: 8, alignItems: 'center' }}><span className="spin" />Loading {path}…</div>;
  if (kind === 'doc') return <Markdown md={text} ctx={{ source, path, sha }} size={size} />;
  if (kind === 'code') return <CodeView text={text} path={path} fontSize={size === 'lg' ? 12.5 : 11.5} maxLines={maxCodeLines} />;
  return <pre className="mono" style={{ margin: 0, fontSize: 11.5, lineHeight: 1.6, color: '#C9CCD2', whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text' }}>{text.slice(0, 200000)}</pre>;
}
