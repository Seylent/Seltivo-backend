import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SeltivoDb } from './db.js';
import { purgeCustomer } from './delete-account.js';

/**
 * Локальний (Node) журнал видалень. Лежить ОКРЕМО від SQLite-файлу, тож
 * логичний бекап/відновлення БД не стирає підтвердження видалення.
 * Повторюваний purgeCustomer безпечний, тому journal можна replay-ити щоразу.
 */
const dbPath = () => process.env.SELTIVO_DB_PATH ?? resolve('data/seltivo.db');
const ledgerPath = () => `${dbPath()}.deletions`;

export function recordLocalDeletion(userId: string): void {
  const path = ledgerPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${userId}\n`, 'utf8');
}

/** Повертає кількість унікальних ID у журналі (для логів/тестів). */
export function replayLocalDeletions(db: SeltivoDb): number {
  const path = ledgerPath();
  if (!existsSync(path)) return 0;
  const ids = [...new Set(readFileSync(path, 'utf8').split('\n').map((line) => line.trim()).filter((line) => /^[a-f0-9-]{36}$/i.test(line)))];
  for (const id of ids) purgeCustomer(db, id);
  return ids.length;
}
