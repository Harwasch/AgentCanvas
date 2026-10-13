// File helpers shared by file nodes, quick open, the repo browser and the mock.
import type { FileKind, FileSource } from './types';

const EXT_KIND: Record<string, FileKind> = {
  md: 'doc', markdown: 'doc', mdx: 'doc',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image', avif: 'image', bmp: 'image',
  stl: 'model3d',
  pdf: 'pdf',
  c: 'code', h: 'code', cc: 'code', cpp: 'code', hpp: 'code', py: 'code', js: 'code', mjs: 'code', cjs: 'code', ts: 'code', tsx: 'code', jsx: 'code',
  rs: 'code', go: 'code', java: 'code', kt: 'code', swift: 'code', rb: 'code', sh: 'code', bash: 'code', zsh: 'code', html: 'code', css: 'code',
  json: 'code', yaml: 'code', yml: 'code', toml: 'code', ini: 'code', xml: 'code', sql: 'code', lua: 'code', m: 'code', cmake: 'code', mk: 'code',
  txt: 'text', csv: 'text', log: 'text', kicad_sch: 'text', kicad_pcb: 'text', step: 'text', stp: 'text',
};

export const extOf = (p: string) => {
  const name = p.split('/').pop() || '';
  if (/^(makefile|dockerfile)$/i.test(name)) return 'mk';
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};
export const kindOf = (p: string): FileKind => EXT_KIND[extOf(p)] || (extOf(p) ? 'binary' : 'text');

export const KIND_ICON: Record<FileKind, string> = { doc: 'M', image: '▦', code: '{}', model3d: '◇', pdf: 'P', text: '≡', binary: '·' };
export const KIND_LABEL: Record<FileKind, string> = { doc: 'Markdown', image: 'Image', code: 'Code', model3d: '3D model', pdf: 'PDF', text: 'Text', binary: 'Binary' };

export const baseName = (p: string) => p.split('/').pop() || p;
export const topFolder = (p: string) => (p.includes('/') ? p.split('/')[0] : '');
export const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Resolve a relative link inside a document at `docPath` (no scheme, no leading slash → relative). */
export function resolveRel(docPath: string, href: string): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return null;
  const clean = href.split('#')[0].split('?')[0];
  const parts = (clean.startsWith('/') ? clean.slice(1) : (dirName(docPath) ? dirName(docPath) + '/' : '') + clean).split('/');
  const out: string[] = [];
  for (const s of parts) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop(); else out.push(s);
  }
  return out.join('/');
}

export const sourceKey = (s: FileSource) => (s.kind === 'checkout' ? `co:${s.checkoutId}` : `gh:${s.projectId}@${s.ref}`);
export const sameSource = (a: FileSource | null | undefined, b: FileSource | null | undefined) => !!a && !!b && sourceKey(a) === sourceKey(b);
