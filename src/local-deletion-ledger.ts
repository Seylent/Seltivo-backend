import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SeltivoDb } from './db.js';
import { purgeCustomer, purgeRequest } from './delete-account.js';

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

/** Повертає кількість унікальних записів у журналі (для логів/тестів). */
export function replayLocalDeletions(db: SeltivoDb): number {
  const path = ledgerPath();
  if (!existsSync(path)) return 0;
  const lines = [...new Set(readFileSync(path, 'utf8').split('\n').map((line) => line.trim()))];
  const customers = lines.filter((line) => /^[a-f0-9-]{36}$/i.test(line));
  const requests = lines.filter((line) => /^request:[a-f0-9-]{36}$/i.test(line)).map((line) => line.slice('request:'.length));
  for (const id of customers) purgeCustomer(db, id);
  for (const id of requests) purgeRequest(db, id);
  return customers.length + requests.length;
}

/** Заявка, видалена клієнтом: окремий префікс, старий код такі рядки ігнорує. */
export function recordLocalRequestDeletion(requestId: string): void {
  const path = ledgerPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `request:${requestId}\n`, 'utf8');
}
