import type { SeltivoDb } from './db.js';

export type RetentionPolicy = { deletedConfigurationDays: number; terminalRequestDays?: number; completedGuestDays?: number };
const day = 24 * 60 * 60 * 1000;

function filters(policy: RetentionPolicy, at: Date) {
  for (const value of Object.values(policy)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Retention days must be positive integers');
  if (!Number.isFinite(at.getTime())) throw new Error('Invalid retention time');
  const cutoff = (days: number) => new Date(at.getTime() - days * day).toISOString();
  return [
    { table: 'sessions', where: 'expires_at<?', cutoff: at.toISOString() },
    { table: 'auth_tokens', where: 'expires_at<?', cutoff: at.toISOString() },
    { table: 'configurations', where: 'deleted_at<? AND NOT EXISTS(SELECT 1 FROM requests WHERE requests.configuration_id=configurations.id)', cutoff: cutoff(policy.deletedConfigurationDays) },
    ...(policy.terminalRequestDays ? [{ table: 'requests', where: "status IN ('completed','cancelled') AND updated_at<?", cutoff: cutoff(policy.terminalRequestDays) }] : []),
    ...(policy.completedGuestDays ? [{ table: 'guest_requests', where: "status='done' AND processed_at<?", cutoff: cutoff(policy.completedGuestDays) }] : []),
  ];
}

export function planDataRetention(db: SeltivoDb, policy: RetentionPolicy, at = new Date()) {
  return Object.fromEntries(filters(policy, at).map(({ table, where, cutoff }) => [table,
    (db.prepare(`SELECT COUNT(*) count FROM ${table} WHERE ${where}`).get(cutoff) as { count: number }).count]));
}

export function applyDataRetention(db: SeltivoDb, policy: RetentionPolicy, at = new Date()) {
  return db.transaction(() => Object.fromEntries(filters(policy, at).map(({ table, where, cutoff }) => [table,
    db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(cutoff).changes])))();
}
