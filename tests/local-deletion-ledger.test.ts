import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db.js';
import { purgeCustomer } from '../src/delete-account.js';
import { recordLocalDeletion, replayLocalDeletions } from '../src/local-deletion-ledger.js';

test('local deletion ledger is outside SQLite and survives a DB restore', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'seltivo-local-ledger-'));
  const previous = process.env.SELTIVO_DB_PATH;
  process.env.SELTIVO_DB_PATH = join(directory, 'seltivo.db');
  t.after(() => {
    if (previous === undefined) delete process.env.SELTIVO_DB_PATH;
    else process.env.SELTIVO_DB_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  });

  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const insertUser = (db: ReturnType<typeof openDatabase>) => db.prepare(
    'INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, `${id}@example.test`, 'scrypt:stub', 'customer', 'Customer', timestamp, timestamp, timestamp);

  const beforeRestore = openDatabase(':memory:');
  insertUser(beforeRestore);
  recordLocalDeletion(id);
  purgeCustomer(beforeRestore, id);
  assert.equal(beforeRestore.prepare('SELECT id FROM users WHERE id=?').get(id), undefined);
  beforeRestore.close();

  // Імітація restore: свіжа БД знову містить видаленого користувача.
  const afterRestore = openDatabase(':memory:');
  insertUser(afterRestore);
  assert.equal(replayLocalDeletions(afterRestore), 1);
  assert.equal(afterRestore.prepare('SELECT id FROM users WHERE id=?').get(id), undefined);
  // Повторний replay ідемпотентний.
  assert.equal(replayLocalDeletions(afterRestore), 1);
  afterRestore.close();
});
