// Tiny HTTP(S) router + static file server + auth helpers. No framework.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { HubConfig } from './config.js';

export interface Req extends http.IncomingMessage {
  params: Record<string, string>;
  query: URLSearchParams;
  pathname: string;
  body?: any;
  rawBody?: Buffer;
  /** host whose token authenticated a 'hook' request */
  authHost?: string;
}
export type Res = http.ServerResponse;
export type Handler = (req: Req, res: Res) => Promise<any> | any;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  h: Handler;
  auth: Auth;
  /** also accept an application/x-www-form-urlencoded body (parsed into req.body) */
  form?: boolean;
}
export type Auth = 'hub' | 'hook' | 'cloudHook' | 'mcp' | 'none';

export class Router {
  routes: Route[] = [];
  add(method: string, pattern: string, auth: Auth, h: Handler, o: { form?: boolean } = {}) {
    const keys: string[] = [];
    const re = new RegExp(
      '^' + pattern.replace(/\/:([a-zA-Z_]+)(\*)?/g, (_m, k, star) => {
        keys.push(k);
        return star ? '/(.+)' : '/([^/]+)';
      }) + '/?$',
    );
    this.routes.push({ method, re, keys, h, auth, form: o.form });
  }
  get(p: string, auth: Auth, h: Handler) { this.add('GET', p, auth, h); }
  post(p: string, auth: Auth, h: Handler, o: { form?: boolean } = {}) { this.add('POST', p, auth, h, o); }
  del(p: string, auth: Auth, h: Handler) { this.add('DELETE', p, auth, h); }
}

export function json(res: Res, status: number, body: any, headers: Record<string, string> = {}) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(s);
}

function readBody(req: http.IncomingMessage, limit = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function cookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function bearer(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (h && /^Bearer /i.test(h)) return h.slice(7).trim();
  return undefined;
}

/** Media type without parameters, lower-cased ("application/json; charset=utf-8" → "application/json"). */
export function essence(ct: string | undefined): string {
  return String(ct || '').split(';')[0].trim().toLowerCase();
}

/** Origins that are this hub: publicUrl, plus the listen address itself (same port) for local access. */
export function hubOrigins(cfg: Pick<HubConfig, 'publicUrl' | 'listen' | 'tls'>): Set<string> {
  const out = new Set<string>([new URL(cfg.publicUrl).origin]);
  const proto = cfg.tls ? 'https' : new URL(cfg.publicUrl).protocol.replace(':', '');
  const h = cfg.listen.host;
  const names = ['0.0.0.0', '::', ''].includes(h) ? ['localhost', '127.0.0.1', '[::1]'] : [h.includes(':') ? `[${h}]` : h];
  for (const n of names) out.add(new URL(`${proto}://${n}:${cfg.listen.port}`).origin);
  return out;
}

/**
 * Cross-origin guard for cookie-authenticated requests and socket upgrades: SameSite=Strict
 * still lets same-site origins (other localhost ports, sibling hosts) send the cookie.
 * Returns why the request is refused, or null.
 */
export function crossOriginReason(headers: http.IncomingHttpHeaders, allowed: Set<string>): string | null {
  const origin = headers.origin;
  if (origin !== undefined && !allowed.has(String(origin))) return `origin ${origin} is not this hub`;
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return `cross-site request (${site})`;
  return null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

export function serveStatic(root: string, req: Req, res: Res): boolean {
  let p = decodeURIComponent(req.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(root)) return false;
  let file = f;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA fallback for navigations only
    if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) file = path.join(root, 'index.html');
    else return false;
  }
  if (!fs.existsSync(file)) return false;
  const ext = path.extname(file);
  const immutable = /\/assets\//.test(file);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...(file.endsWith('sw.js') ? { 'service-worker-allowed': '/' } : {}),
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

export interface ServerDeps {
  cfg: HubConfig;
  router: Router;
  authCheck: (auth: Auth, req: Req) => boolean;
  /** origins accepted on cookie-authenticated requests (default: hubOrigins(cfg)) */
  origins?: Set<string>;
  staticRoot?: string;
  onUnauthedPage?: (req: Req, res: Res) => boolean;
}

export function createServer(d: ServerDeps) {
  const origins = d.origins ?? hubOrigins(d.cfg);
  const handler = async (rq: http.IncomingMessage, res: Res) => {
    const req = rq as Req;
    const u = new URL(req.url || '/', 'http://x');
    req.pathname = u.pathname;
    req.query = u.searchParams;
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      for (const r of d.router.routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(req.pathname);
        if (!m) continue;
        req.params = {};
        r.keys.forEach((k, i) => (req.params[k] = decodeURIComponent(m[i + 1])));
        if (!d.authCheck(r.auth, req)) throw new HttpError(401, 'unauthorized');
        // the cookie is ambient: refuse it from anywhere but the hub's own pages (bearer callers are unaffected)
        if ((r.auth === 'hub' && !bearer(req)) || r.form) {
          const why = crossOriginReason(req.headers, origins);
          if (why) throw new HttpError(403, why);
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          req.rawBody = await readBody(req);
          const ct = essence(req.headers['content-type']);
          if (!req.rawBody.length) req.body = {};
          else if (ct === 'application/json') {
            try {
              req.body = JSON.parse(req.rawBody.toString('utf8'));
            } catch {
              throw new HttpError(400, 'invalid json');
            }
          } else if (r.form && ct === 'application/x-www-form-urlencoded') {
            req.body = Object.fromEntries(new URLSearchParams(req.rawBody.toString('utf8')));
          } else throw new HttpError(415, 'body must be application/json');
        }
        const out = await r.h(req, res);
        if (!res.headersSent && out !== undefined) json(res, 200, out);
        else if (!res.headersSent) json(res, 200, { ok: true });
        return;
      }
      if (d.staticRoot && req.method === 'GET') {
        if (d.onUnauthedPage && d.onUnauthedPage(req, res)) return;
        if (serveStatic(d.staticRoot, req, res)) return;
      }
      json(res, 404, { error: 'not found' });
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('[http]', req.method, req.pathname, e);
      if (!res.headersSent) json(res, status, { error: e?.message || String(e) });
      else res.end();
    }
  };
  if (d.cfg.tls) {
    return https.createServer({ cert: fs.readFileSync(d.cfg.tls.cert), key: fs.readFileSync(d.cfg.tls.key) }, handler);
  }
  return http.createServer(handler);
}
