// Retention: history the hub would otherwise keep forever (and send in every /api/state). Runs every
// retention.intervalMin; every bound is in days (config.retention).
import type { Db } from './db.js';
import type { HubConfig } from './config.js';
import { log } from './events.js';

const L = log('retention');
const DAY = 86_400_000;
/** statuses after which a session never runs again */
export const ENDED = ['ended', 'error', 'applied'];
const ENDED_SQL = ENDED.map((s) => `'${s}'`).join(',');

/** Delete what is past its retention. Returns the rows removed per table. */
export function prune(db: Db, r: HubConfig['retention'], now = Date.now()) {
  const messages = db.run(
    `DELETE FROM message WHERE session_id IN (SELECT id FROM session WHERE status IN (${ENDED_SQL}) AND updated_at < ?)`, now - r.messagesDays * DAY,
  ).changes;
  const audit = db.run('DELETE FROM audit WHERE ts < ?', now - r.auditDays * DAY).changes;
  const approvals = db.run("DELETE FROM approval WHERE status != 'pending' AND COALESCE(resolved_at, created_at) < ?", now - r.approvalsDays * DAY).changes;
  return { messages: Number(messages), audit: Number(audit), approvals: Number(approvals) };
}

/** SQL condition: the session belongs in /api/state (not an ended one older than stateEndedDays) */
export function inStateWhere(r: HubConfig['retention'], now = Date.now()): [string, number] {
  return [`NOT (status IN (${ENDED_SQL}) AND updated_at < ?)`, now - r.stateEndedDays * DAY];
}

export function startRetention(db: Db, cfg: HubConfig): () => void {
  const run = () => {
    try {
      const n = prune(db, cfg.retention);
      if (n.messages || n.audit || n.approvals) L(`pruned ${n.messages} message(s), ${n.audit} audit row(s), ${n.approvals} approval(s)`);
    } catch (e: any) {
      L(`prune failed: ${e.message}`);
    }
  };
  const first = setTimeout(run, 60_000);
  const every = setInterval(run, Math.max(1, cfg.retention.intervalMin) * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
