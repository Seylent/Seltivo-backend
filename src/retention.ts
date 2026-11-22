import type { SeltivoDb } from './db.js';

/** Explicit operator cutoff; no automatic deletion of enquiries or customer work. */
export function retention(db: SeltivoDb, before: string, apply = false, at = new Date()) {
  const cutoff = Date.parse(before);
  if (!Number.isFinite(cutoff) || cutoff > at.getTime() - 30 * 86400000) throw new Error('Retention cutoff must be at least 30 days old');
  const rules = {
    guestRequests: { table: 'guest_requests', where: "status='done' AND processed_at IS NOT NULL AND processed_at<?", date: before },
    sessions: { table: 'sessions', where: 'expires_at<=?', date: at.toISOString() },
    authTokens: { table: 'auth_tokens', where: 'expires_at<=?', date: at.toISOString() },
    readNotifications: { table: 'notifications', where: 'read_at IS NOT NULL AND read_at<?', date: before },
    deliveredEmails: { table: 'email_notifications', where: "status='sent' AND sent_at<?", date: before },
  };
  const eligible: Record<string, number> = {}, deleted: Record<string, number> = {};
  db.transaction(() => {
    for (const [key, { table, where, date }] of Object.entries(rules)) {
      eligible[key] = (db.prepare(`SELECT COUNT(*) count FROM ${table} WHERE ${where}`).get(date) as { count: number }).count;
      deleted[key] = apply ? db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} ORDER BY rowid LIMIT 1000)`).run(date).changes : 0;
    }
  })();
  return { applied: apply, before, batchLimit: 1000, eligible, deleted };
}
