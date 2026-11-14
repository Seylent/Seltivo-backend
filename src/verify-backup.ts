import { resolve } from 'node:path';
import Database from 'better-sqlite3';

const filename = process.argv[2];
if (!filename) throw new Error('Usage: npm run backup:verify -- <database.db>');
const db = new Database(resolve(filename), { readonly: true, fileMustExist: true });
try {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Database integrity check failed');
  if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Database foreign key check failed');
  console.log(`Database verified (schema v${db.pragma('user_version', { simple: true })}): ${resolve(filename)}`);
} finally { db.close(); }
