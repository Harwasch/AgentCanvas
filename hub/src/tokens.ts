// Caller identity for hosts: every host gets its own token and every hub-started
// Claude session its own secret, both derived from the hub's hook secret (HMAC),
// so nothing new is stored and a token from one host cannot speak for another.
import crypto from 'node:crypto';
import { safeEqual } from './http.js';

const mac = (secret: string, what: string) => crypto.createHmac('sha256', secret).update(what).digest('base64url');

export const hostToken = (secret: string, hostId: string) => mac(secret, `host:${hostId}`);
export const sessionToken = (secret: string, sessionId: string) => mac(secret, `session:${sessionId}`);

/** The host a bearer token belongs to, or null. */
export function hostForToken(secret: string, hostIds: string[], tok: string | undefined): string | null {
  if (!tok) return null;
  for (const id of hostIds) if (safeEqual(tok, hostToken(secret, id))) return id;
  return null;
}

export function sessionTokenOk(secret: string, sessionId: string, tok: unknown): boolean {
  return typeof tok === 'string' && tok.length > 0 && safeEqual(tok, sessionToken(secret, sessionId));
}

/**
 * May a caller holding `authHost`'s token (and optionally a session secret) act as session `s`?
 * The session must live on that host; sessions launched with a secret (meta.stok) must present it.
 * Returns why not, or null.
 */
export function sessionCallerReason(secret: string, authHost: string | undefined, s: { id: string; host_id: string | null; meta?: any }, tok: unknown): string | null {
  if (!authHost || s.host_id !== authHost) return `session ${s.id} is not on the calling host`;
  if (s.meta?.stok && !sessionTokenOk(secret, s.id, tok)) return `bad session token for ${s.id}`;
  return null;
}
