// app.json manifest validation. Strict: unknown keys, undeclared tiers and
// undeclared UI origins are errors, because a silent pass here means an app
// gets more authority than its author declared.

export type Tier = 'read' | 'actuate';
export type Lifecycle = 'static' | 'on-demand' | 'always-on';

export interface ToolPolicy {
  tier: Tier;
  confirm?: boolean;
  maxPerMinute?: number;
}

export interface AppManifest {
  id: string;
  title: string;
  version: string;
  runsOn?: string;
  account?: string;
  server?: { command: string[]; transport: 'stdio' | 'http'; port?: number; env?: Record<string, string> };
  ui: string;
  /** static (server-less) apps only: HTML file relative to the app dir */
  uiFile?: string;
  lifecycle: Lifecycle;
  csp: { connect: string[]; img: string[] };
  tools: Record<string, ToolPolicy>;
  node: { width: number; height: number };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest?: AppManifest;
}

const TOP_KEYS = new Set(['$schema', 'id', 'title', 'version', 'runsOn', 'account', 'server', 'ui', 'uiFile', 'lifecycle', 'csp', 'tools', 'node', 'description']);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TOOL_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
// https origin, no path/query; optional leading *. subdomain wildcard; optional port
const ORIGIN_RE = /^(https|wss):\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i;

const isObj = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateManifest(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['manifest must be a JSON object'], warnings };
  const m = input as Record<string, any>;

  for (const k of Object.keys(m)) if (!TOP_KEYS.has(k)) errors.push(`unknown key "${k}"`);

  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) errors.push('id: required, lowercase letters/digits/dashes, ≤ 63 chars');
  if (typeof m.title !== 'string' || !m.title.trim() || m.title.length > 80) errors.push('title: required string ≤ 80 chars');
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) errors.push('version: required semver string like "0.3.0"');
  if (m.runsOn !== undefined && (typeof m.runsOn !== 'string' || !m.runsOn)) errors.push('runsOn: must be a host id or "hub"');
  if (m.account !== undefined && (typeof m.account !== 'string' || !m.account)) errors.push('account: must be an account id');

  const lifecycle = m.lifecycle ?? 'on-demand';
  if (!['static', 'on-demand', 'always-on'].includes(lifecycle)) errors.push('lifecycle: one of static | on-demand | always-on');

  // server
  let server: AppManifest['server'];
  if (m.server !== undefined) {
    if (!isObj(m.server)) errors.push('server: must be an object');
    else {
      const s = m.server;
      for (const k of Object.keys(s)) if (!['command', 'transport', 'port', 'env'].includes(k)) errors.push(`server: unknown key "${k}"`);
      if (!Array.isArray(s.command) || !s.command.length || !s.command.every((x: any) => typeof x === 'string' && x.length))
        errors.push('server.command: non-empty array of strings');
      const transport = s.transport ?? 'stdio';
      if (!['stdio', 'http'].includes(transport)) errors.push('server.transport: "stdio" or "http"');
      if (transport === 'http' && !(Number.isInteger(s.port) && s.port > 0 && s.port < 65536)) errors.push('server.port: required for http transport');
      if (s.env !== undefined && !(isObj(s.env) && Object.values(s.env).every((v) => typeof v === 'string'))) errors.push('server.env: object of strings');
      server = { command: s.command, transport, port: s.port, env: s.env };
    }
  }

  // ui
  if (typeof m.ui !== 'string' || !/^ui:\/\/[^\s]+$/.test(m.ui)) errors.push('ui: required ui:// resource URI');
  else if (typeof m.id === 'string' && !m.ui.startsWith(`ui://${m.id}/`)) errors.push(`ui: must live under ui://${m.id}/`);
  if (m.uiFile !== undefined) {
    if (typeof m.uiFile !== 'string' || m.uiFile.startsWith('/') || m.uiFile.split('/').includes('..')) errors.push('uiFile: relative path inside the app dir');
    if (server) errors.push('uiFile: only for static apps without a server (the server serves ui://)');
  }
  if (!server && m.uiFile === undefined) errors.push('server or uiFile: an app needs a server, or a uiFile when static');
  if (lifecycle === 'static' && server) errors.push('lifecycle "static" is for UI-only apps without a server');
  if (!server && lifecycle !== 'static') warnings.push('no server: lifecycle forced to "static"');

  // csp
  const csp = { connect: [] as string[], img: [] as string[] };
  if (m.csp !== undefined) {
    if (!isObj(m.csp)) errors.push('csp: must be an object');
    else {
      for (const k of Object.keys(m.csp)) if (!['connect', 'img'].includes(k)) errors.push(`csp: unknown key "${k}"`);
      for (const k of ['connect', 'img'] as const) {
        const v = m.csp[k] ?? [];
        if (!Array.isArray(v)) errors.push(`csp.${k}: array of origins`);
        else
          for (const o of v) {
            if (typeof o !== 'string' || !ORIGIN_RE.test(o)) errors.push(`csp.${k}: "${o}" is not an https/wss origin (no paths, no bare *)`);
            else csp[k].push(o.toLowerCase());
          }
      }
    }
  }

  // tools: every tool needs a tier
  const tools: Record<string, ToolPolicy> = {};
  if (m.tools !== undefined && !isObj(m.tools)) errors.push('tools: must be an object');
  else
    for (const [name, p] of Object.entries((m.tools as Record<string, any>) || {})) {
      if (!TOOL_RE.test(name)) errors.push(`tools: invalid tool name "${name}"`);
      if (!isObj(p)) {
        errors.push(`tools.${name}: must be an object with a tier`);
        continue;
      }
      for (const k of Object.keys(p)) if (!['tier', 'confirm', 'maxPerMinute', 'description'].includes(k)) errors.push(`tools.${name}: unknown key "${k}"`);
      if (p.tier !== 'read' && p.tier !== 'actuate') errors.push(`tools.${name}.tier: required, "read" or "actuate"`);
      if (p.confirm !== undefined && typeof p.confirm !== 'boolean') errors.push(`tools.${name}.confirm: boolean`);
      if (p.maxPerMinute !== undefined && !(Number.isInteger(p.maxPerMinute) && p.maxPerMinute > 0 && p.maxPerMinute <= 600))
        errors.push(`tools.${name}.maxPerMinute: integer 1..600`);
      if (p.tier === 'read' && p.confirm) warnings.push(`tools.${name}: confirm on a read tool is unusual`);
      if (p.tier === 'actuate' && p.confirm === undefined) warnings.push(`tools.${name}: actuate tool without explicit confirm (defaults to true)`);
      tools[name] = { tier: p.tier, confirm: p.tier === 'actuate' ? p.confirm ?? true : !!p.confirm, maxPerMinute: p.maxPerMinute };
    }
  if (!server && Object.keys(tools).length) errors.push('tools: declared but there is no server to provide them');

  // node size
  const node = { width: 640, height: 420 };
  if (m.node !== undefined) {
    if (!isObj(m.node)) errors.push('node: must be an object');
    else {
      const { width, height } = m.node;
      if (width !== undefined) {
        if (!(Number.isInteger(width) && width >= 200 && width <= 2400)) errors.push('node.width: integer 200..2400');
        else node.width = width;
      }
      if (height !== undefined) {
        if (!(Number.isInteger(height) && height >= 120 && height <= 2400)) errors.push('node.height: integer 120..2400');
        else node.height = height;
      }
    }
  }

  if (errors.length) return { ok: false, errors, warnings };
  return {
    ok: true,
    errors,
    warnings,
    manifest: {
      id: m.id, title: m.title, version: m.version, runsOn: m.runsOn, account: m.account, server, ui: m.ui, uiFile: m.uiFile,
      lifecycle: server ? lifecycle : 'static', csp, tools, node,
    },
  };
}

/**
 * Check that the UI loads resources only from declared origins. Scans src/href/
 * action/srcset attributes, CSS url()/@import, and literal fetch/WebSocket/EventSource
 * URLs. Anchor hrefs are navigation and are ignored (the sandbox blocks top navigation).
 */
export function checkUiOrigins(html: string, csp: { connect: string[]; img: string[] }): string[] {
  const errors: string[] = [];
  const allowed = [...csp.connect, ...csp.img];
  const matches = (url: string, list: string[]) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    const origin = `${u.protocol}//${u.host}`.toLowerCase();
    return list.some((o) => {
      if (o.includes('://*.')) {
        const [proto, rest] = o.split('://*.');
        return u.protocol === proto + ':' && (u.host.toLowerCase() === rest || u.host.toLowerCase().endsWith('.' + rest));
      }
      return o === origin;
    });
  };
  const seen = new Set<string>();
  const check = (url: string, list: string[], what: string) => {
    if (!/^(https?|wss?):\/\//i.test(url) && !url.startsWith('//')) return;
    const full = url.startsWith('//') ? 'https:' + url : url;
    const key = what + full;
    if (seen.has(key)) return;
    seen.add(key);
    if (!matches(full, list)) errors.push(`UI ${what} ${full} is not from a declared csp origin`);
  };
  const tagRe = /<\s*([a-zA-Z][\w-]*)([^>]*)>/g;
  let t: RegExpExecArray | null;
  while ((t = tagRe.exec(html))) {
    const tag = t[1].toLowerCase();
    const attrs = t[2];
    const attrRe = /\b(src|href|action|srcset|poster|data)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(attrs))) {
      const name = a[1].toLowerCase();
      const val = (a[3] ?? a[4] ?? a[5] ?? '').trim();
      if (tag === 'a' && name === 'href') continue;
      const list = tag === 'img' || name === 'poster' ? [...csp.img, ...csp.connect] : allowed;
      if (name === 'srcset') for (const part of val.split(',')) check(part.trim().split(/\s+/)[0], list, `${tag}[srcset]`);
      else check(val, list, `${tag}[${name}]`);
    }
  }
  const cssRe = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]/gi;
  let c: RegExpExecArray | null;
  while ((c = cssRe.exec(html))) check(c[1] || c[2], allowed, 'css');
  const jsRe = /\b(fetch|WebSocket|EventSource)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let s: RegExpExecArray | null;
  while ((s = jsRe.exec(html))) check(s[2], csp.connect, s[1]);
  return errors;
}

/** Content-Security-Policy for the served UI: deny by default, declared origins only. */
export function cspHeader(csp: { connect: string[]; img: string[] }): string {
  const c = csp.connect.join(' ');
  const i = csp.img.join(' ');
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data: blob:${i ? ' ' + i : ''}`,
    `connect-src ${c || "'none'"}`,
    "font-src data:",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}
