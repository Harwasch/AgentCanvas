// Shared helpers for the stub vendor CLIs. Stubs speak the real protocols so
// the hub code that drives them is the code that will drive the real CLIs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';

export const home = os.homedir();
export const expand = (p) => (p && p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const b62 = (n) => Array.from(crypto.randomBytes(n), (b) => B62[b % 62]).join('');
export const uuid = () => crypto.randomUUID();

export function readJson(f, dflt) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return dflt;
  }
}
export function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2));
}

/** Interpolate $VAR / ${VAR} in header values, only for allowlisted vars (Claude Code semantics). */
function interp(v, allowed) {
  return String(v).replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_m, k) => (allowed.includes(k) ? process.env[k] ?? '' : ''));
}

/** Collect hook handlers for an event from a list of settings objects (hooks merge across levels). */
export function hooksFor(settingsList, event, toolName) {
  const out = [];
  for (const s of settingsList) {
    for (const group of s?.hooks?.[event] || []) {
      const m = group.matcher;
      if (toolName && m && m !== '*' && !new RegExp(`^(?:${m})$`).test(toolName)) continue;
      for (const h of group.hooks || []) out.push(h);
    }
  }
  return out;
}

export function postJson(url, body, headers = {}, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const req = lib.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length, ...headers }, timeout: timeoutMs }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', error: 'timeout' });
    });
    req.on('error', (e) => resolve({ status: 0, body: '', error: String(e) }));
    req.end(data);
  });
}

/** Fire all matching HTTP hooks; returns parsed JSON outputs from 2xx JSON bodies (others are non-blocking errors). */
export async function fireHooks(settingsList, event, payload, toolName) {
  const hs = hooksFor(settingsList, event, toolName).filter((h) => h.type === 'http');
  const results = await Promise.all(
    hs.map(async (h) => {
      const allowed = h.allowedEnvVars || [];
      const headers = Object.fromEntries(Object.entries(h.headers || {}).map(([k, v]) => [k, interp(v, allowed)]));
      const r = await postJson(h.url, { ...payload, hook_event_name: event }, headers, (h.timeout ?? (event === 'UserPromptSubmit' ? 30 : 600)) * 1000);
      if (r.status >= 200 && r.status < 300 && r.body.trim()) {
        try {
          return JSON.parse(r.body);
        } catch {
          return null;
        }
      }
      return null;
    }),
  );
  return results.filter(Boolean);
}

export function slug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-').slice(0, 200);
}

export const STUB_LIB = path.dirname(new URL(import.meta.url).pathname);
