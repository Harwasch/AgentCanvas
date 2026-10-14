// Sanitized markdown rendering (marked + DOMPurify, loaded on demand). Relative image embeds are
// resolved through /api/files/raw with the document's source and pinned commit.
import { useEffect, useRef, useState } from 'react';
import { rawUrl } from '../api';
import { resolveRel } from '../files';
import type { FileSource } from '../types';

type Libs = { marked: typeof import('marked').marked; purify: typeof import('dompurify').default };
let libs: Promise<Libs> | null = null;
function loadLibs() {
  libs ||= Promise.all([import('marked'), import('dompurify')]).then(([m, d]) => ({ marked: m.marked, purify: d.default }));
  return libs;
}

// ```mermaid blocks render as diagrams, like on GitHub (mermaid is loaded only when a document has one)
let mermaidLib: Promise<typeof import('mermaid').default> | null = null;
let mermaidN = 0;
function loadMermaid() {
  mermaidLib ||= import('mermaid').then((m) => {
    m.default.initialize({
      startOnLoad: false, securityLevel: 'strict', theme: 'dark',
      themeVariables: { background: '#15171B', primaryColor: '#24272D', primaryTextColor: '#E7E8EA', lineColor: '#8A8F98', fontSize: '13px' },
      fontFamily: 'Inter, system-ui, sans-serif',
    });
    return m.default;
  });
  return mermaidLib;
}
async function renderMermaid(root: HTMLElement) {
  const blocks = Array.from(root.querySelectorAll('pre > code.language-mermaid')) as HTMLElement[];
  if (!blocks.length) return;
  const mermaid = await loadMermaid();
  for (const code of blocks) {
    const pre = code.parentElement!;
    if (!pre.isConnected) continue;
    try {
      const { svg } = await mermaid.render(`mmd-${++mermaidN}`, code.textContent || '');
      const div = document.createElement('div');
      div.className = 'mermaid-diagram';
      div.innerHTML = svg; // strict mode: labels are escaped and scripts / click handlers are dropped by mermaid
      pre.replaceWith(div);
    } catch (e) {
      pre.setAttribute('title', `Mermaid: ${(e as Error).message}`); // leave the source visible
      document.getElementById(`dmmd-${mermaidN}`)?.remove(); // mermaid's leftover error element
    }
  }
}

export interface MdCtx { source: FileSource; path: string; sha?: string | null }

export async function renderMarkdown(md: string, ctx?: MdCtx): Promise<string> {
  const { marked, purify } = await loadLibs();
  const html = await marked.parse(md, { gfm: true, breaks: false, async: true });
  const clean = purify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style'] });
  const tpl = document.createElement('template');
  tpl.innerHTML = clean;
  tpl.content.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    const rel = ctx ? resolveRel(ctx.path, src) : null;
    if (rel != null && ctx) img.setAttribute('src', rawUrl(ctx.source, rel, ctx.sha));
    else if (!/^(https?:|data:image\/)/i.test(src)) img.removeAttribute('src');
    img.setAttribute('loading', 'lazy');
    img.setAttribute('referrerpolicy', 'no-referrer');
  });
  tpl.content.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const rel = ctx ? resolveRel(ctx.path, href) : null;
    if (rel != null && ctx) a.setAttribute('href', rawUrl(ctx.source, rel, ctx.sha));
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return tpl.innerHTML;
}

/** Headings for a table of contents (cheap regex pass; ignores fenced code). */
export function mdHeadings(md: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  let fence = false;
  md.split('\n').forEach((ln) => {
    if (/^\s*(```|~~~)/.test(ln)) fence = !fence;
    if (fence) return;
    const m = ln.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ level: m[1].length, text: m[2].replace(/[`*_]/g, '') });
  });
  return out;
}

export function Markdown({ md, ctx, size = 'sm', style }: { md: string; ctx?: MdCtx; size?: 'sm' | 'lg'; style?: React.CSSProperties }) {
  const [html, setHtml] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const key = ctx ? `${ctx.path}@${ctx.sha || ''}` : '';
  useEffect(() => {
    let alive = true;
    renderMarkdown(md, ctx).then((h) => { if (alive) setHtml(h); }).catch(() => { if (alive) setHtml(null); });
    return () => { alive = false; };
  }, [md, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (html && ref.current) void renderMermaid(ref.current);
  }, [html]);
  if (html == null) return <div className="prose" style={{ fontSize: 12.5, color: '#C9CCD2', lineHeight: 1.6, ...style }}>{md.slice(0, 2000)}</div>;
  return <div ref={ref} className={`mdv${size === 'lg' ? ' lg' : ''}`} style={style} dangerouslySetInnerHTML={{ __html: html }} />;
}
