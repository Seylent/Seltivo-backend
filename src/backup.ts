import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

const destination = process.argv[2];
if (!destination) throw new Error('Usage: npm run backup -- <destination.db>');
const target = resolve(destination);
const source = resolve(process.env.SELTIVO_DB_PATH ?? 'data/seltivo.db');
if (target === source) throw new Error('Backup destination must differ from the live database');
if (existsSync(target)) throw new Error(`Backup destination already exists: ${target}`);
mkdirSync(dirname(target), { recursive: true });
const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  await db.backup(target);
  const copy = new Database(target, { readonly: true, fileMustExist: true });
  try {
    if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Backup integrity check failed');
    if ((copy.pragma('foreign_key_check') as unknown[]).length) throw new Error('Backup foreign key check failed');
  } finally { copy.close(); }
  console.log(`Backup verified: ${target}`);
} catch (error) {
  rmSync(target, { force: true });
  throw error;
} finally { db.close(); }
