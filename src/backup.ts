import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDatabase } from './db.js';

const destination = process.argv[2];
if (!destination) throw new Error('Usage: npm run backup -- <destination.db>');
const target = resolve(destination);
mkdirSync(dirname(target), { recursive: true });
const db = openDatabase();
try {
  await db.backup(target);
  const copy = openDatabase(target);
  try {
    if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Backup integrity check failed');
  } finally { copy.close(); }
  console.log(`Backup verified: ${target}`);
} finally { db.close(); }
