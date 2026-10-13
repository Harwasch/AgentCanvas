// Actuate-tier enforcement. Pure: the bridge asks `decide` before any tool
// call reaches an app server, whoever the caller is (the human in the node,
// an agent session, or another app). Interlocks still live device-side.
import type { AppManifest, Tier } from './manifest.js';

export type CallerKind = 'user' | 'agent' | 'app';
export interface Caller {
  kind: CallerKind;
  id: string;
  label?: string;
}

export interface PolicyNode {
  state: 'preview' | 'promoted';
  version: number;
  /** version number the human granted actuate for (after reviewing the pinned code) */
  grantedVersion: number | null;
  manifest: AppManifest;
}

export type Decision =
  | { allowed: true; tier: Tier; reason: string }
  | { allowed: false; tier?: Tier; code: 'undeclared' | 'preview' | 'not_granted' | 'needs_confirm' | 'rate_limited' | 'locked'; reason: string };

/** Lock state of the devices an app declares: holder is a session id, "you", or null (free). */
export interface DeviceLockInfo {
  device: string;
  title?: string;
  holder: string | null;
  holderLabel?: string;
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  /** true if a call is allowed now; records the hit when `record` */
  check(key: string, maxPerMinute: number | undefined, now: number, record: boolean): boolean {
    if (!maxPerMinute) return true;
    const arr = (this.hits.get(key) || []).filter((t) => now - t < 60_000);
    const ok = arr.length < maxPerMinute;
    if (ok && record) arr.push(now);
    this.hits.set(key, arr);
    return ok;
  }
}

export function decide(
  node: PolicyNode,
  nodeId: string,
  tool: string,
  opts: { confirmed: boolean; now: number; caller?: Caller; locks?: DeviceLockInfo[] },
  limiter: RateLimiter,
): Decision {
  const p = node.manifest.tools[tool];
  if (!p) return { allowed: false, code: 'undeclared', reason: `tool "${tool}" is not declared in app.json; the hub refuses undeclared tools` };
  const key = `${nodeId}:${tool}`;
  if (p.tier === 'read') {
    if (!limiter.check(key, p.maxPerMinute, opts.now, true))
      return { allowed: false, tier: 'read', code: 'rate_limited', reason: `rate limit ${p.maxPerMinute}/min reached for ${tool}` };
    return { allowed: true, tier: 'read', reason: 'read tier' };
  }
  // actuate
  if (node.state !== 'promoted')
    return { allowed: false, tier: 'actuate', code: 'preview', reason: 'preview mode forces the read-only tier; promote the app and grant actuate first' };
  if (node.grantedVersion == null || node.grantedVersion !== node.version)
    return { allowed: false, tier: 'actuate', code: 'not_granted', reason: `actuate is not granted for version ${node.version}` };
  // device locks keep agents (and apps) from colliding on hardware: an agent must hold the lock of every
  // device the app declares. The human is never blocked by a lock (a STOP must always go through).
  let lockNote = '';
  for (const l of opts.locks || []) {
    if (opts.caller?.kind === 'user') {
      if (l.holder && l.holder !== 'you') lockNote = ` (overrides lock held by ${l.holderLabel || l.holder})`;
      continue;
    }
    if (!opts.caller) continue;
    if (l.holder && l.holder !== opts.caller.id)
      return { allowed: false, tier: 'actuate', code: 'locked', reason: `${l.title || l.device} is locked by ${l.holderLabel || l.holder}` };
    if (!l.holder) return { allowed: false, tier: 'actuate', code: 'locked', reason: `${l.title || l.device} must be locked by this session first (acquire_device)` };
  }
  if (p.confirm && !opts.confirmed)
    return { allowed: false, tier: 'actuate', code: 'needs_confirm', reason: `${tool} requires confirmation in the node` };
  if (!limiter.check(key, p.maxPerMinute, opts.now, true))
    return { allowed: false, tier: 'actuate', code: 'rate_limited', reason: `rate limit ${p.maxPerMinute}/min reached for ${tool}` };
  return { allowed: true, tier: 'actuate', reason: (p.confirm ? 'actuate, confirmed' : 'actuate (no confirm by design)') + lockNote };
}
