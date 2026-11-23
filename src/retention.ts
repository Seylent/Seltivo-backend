import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { applyDataRetention, planDataRetention, type RetentionPolicy } from './data-retention.js';

const args = process.argv.slice(2);
const allowed = new Set(['--db', '--backup', '--apply', '--request-days', '--guest-days', '--deleted-config-days']);
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error('Unknown retention option');
  if (args[i] !== '--apply' && (!args[i + 1] || args[i + 1].startsWith('--'))) throw new Error('Missing retention option value');
  if (args[i] !== '--apply') i++;
}
const value = (flag: string) => args[args.indexOf(flag) + 1];
if (!args.includes('--db')) throw new Error('Usage: npm run retention -- --db <database.db> [--request-days 365] [--guest-days 180] [--apply --backup <new-backup.db>]');
const filename = resolve(value('--db'));
const apply = args.includes('--apply');
const backup = args.includes('--backup') ? resolve(value('--backup')) : undefined;
if (apply && (!backup || backup === filename || existsSync(backup))) throw new Error('--apply requires a new, separate --backup path');
const policy: RetentionPolicy = {
  deletedConfigurationDays: args.includes('--deleted-config-days') ? Number(value('--deleted-config-days')) : 30,
  ...(args.includes('--request-days') ? { terminalRequestDays: Number(value('--request-days')) } : {}),
  ...(args.includes('--guest-days') ? { completedGuestDays: Number(value('--guest-days')) } : {}),
};
const db = new Database(filename, { readonly: !apply, fileMustExist: true });
try {
  db.pragma('foreign_keys = ON');
  const at = new Date();
  const planned = planDataRetention(db, policy, at);
  if (apply && backup) {
    mkdirSync(dirname(backup), { recursive: true });
    await db.backup(backup);
    const check = new Database(backup, { readonly: true, fileMustExist: true });
    try {
      if (check.pragma('integrity_check', { simple: true }) !== 'ok' || (check.pragma('foreign_key_check') as unknown[]).length) throw new Error('Retention backup verification failed');
    } finally { check.close(); }
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', policy, at: at.toISOString(), rows: apply ? applyDataRetention(db, policy, at) : planned }));
} finally { db.close(); }
