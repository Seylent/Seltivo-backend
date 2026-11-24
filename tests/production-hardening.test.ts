import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { hashPassword, now } from '../src/auth.js';
import { openDatabase } from '../src/db.js';
import { purgeRequest } from '../src/delete-account.js';
import { createLogicalBackup, createLogicalBackupWithRetry, restoreLogicalBackup } from '../src/logical-backup.js';
import { recordLocalRequestDeletion, replayLocalDeletions } from '../src/local-deletion-ledger.js';
import { createNotificationDelivery } from '../src/notifications.js';
import { MIGRATIONS } from '../src/schema.js';
import { totpAt } from '../src/two-factor.js';

process.env.NODE_ENV = 'test';
const origin = 'http://localhost:3000';
const password = 'VeryStrongPass123!';
type Db = ReturnType<typeof openDatabase>;

const caller = (app: ReturnType<typeof buildApp>) => async (method: string, url: string, payload?: unknown, cookie?: string) => {
  const response: any = await app.inject({ method, url, headers: { origin, ...(cookie ? { cookie } : {}) }, payload } as any);
  return { status: response.statusCode as number, body: response.body ? JSON.parse(response.body) : null, cookie: (response.headers['set-cookie'] as string | undefined)?.split(';')[0] };
};

async function addUser(db: Db, role: 'customer' | 'admin', email: string) {
  const id = randomUUID(), timestamp = now();
  db.prepare('INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, email, await hashPassword(password), role, 'User', timestamp, timestamp, timestamp);
  return id;
}

function backupDatabase() {
  const db = openDatabase(':memory:');
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(MIGRATIONS.at(-1)!.version, now());
  return db;
}

function memoryStore(onPut?: (key: string) => void) {
  const objects = new Map<string, string>();
  return {
    objects,
    async put(key: string, value: string) { onPut?.(key); objects.set(key, value); },
    async get(key: string) { const value = objects.get(key); return value === undefined ? null : { async text() { return value; } }; },
  };
}

function seedRequest(db: Db, customerId: string) {
  const requestId = randomUUID(), timestamp = now();
  db.prepare("INSERT INTO requests(id,customer_id,template_id,template_name,contact_json,note,features_json,client_submission_id,status,created_at,updated_at) VALUES (?,?,'custom','Custom','{}','','[]',?,'submitted',?,?)")
    .run(requestId, customerId, randomUUID(), timestamp, timestamp);
  db.prepare('INSERT INTO conversations(id,request_id,created_at) VALUES (?,?,?)').run(randomUUID(), requestId, timestamp);
  return requestId;
}

test('a login lockout survives a restart of the app on the same database', async () => {
  const db = openDatabase(':memory:');
  try {
    await addUser(db, 'customer', 'locked@example.test');
    const before = buildApp({ db, origin, logger: false });
    const call = caller(before);
    for (let attempt = 0; attempt < 10; attempt++) assert.equal((await call('POST', '/api/v1/auth/login', { email: 'locked@example.test', password: 'wrong-password' })).status, 401);
    await before.close();
    const after = buildApp({ db, origin, logger: false });
    const login = await caller(after)('POST', '/api/v1/auth/login', { email: 'locked@example.test', password });
    assert.equal(login.status, 429, 'a Durable Object restart must not reset the lockout');
    await after.close();
    const stored = JSON.stringify(db.prepare('SELECT * FROM rate_limit_hits').all());
    assert.doesNotMatch(stored, /locked@example\.test/, 'raw email addresses are not stored in the rate-limit table');
  } finally { db.close(); }
});

test('a TOTP code cannot be replayed after a restart of the app', async () => {
  const db = openDatabase(':memory:');
  try {
    await addUser(db, 'admin', 'admin@example.test');
    const first = buildApp({ db, origin, logger: false });
    const call = caller(first);
    const session = (await call('POST', '/api/v1/auth/login', { email: 'admin@example.test', password })).cookie!;
    const setup = await call('POST', '/api/v1/auth/2fa/setup', { password }, session);
    const code = totpAt(setup.body.secret);
    assert.equal((await call('POST', '/api/v1/auth/2fa/enable', { code }, session)).status, 200);
    await first.close();
    const second = buildApp({ db, origin, logger: false });
    assert.equal((await caller(second)('POST', '/api/v1/auth/login', { email: 'admin@example.test', password, code })).status, 401);
    await second.close();
  } finally { db.close(); }
});

test('failed chat emails are retried later and stop after the attempt cap', async () => {
  const db = openDatabase(':memory:');
  const delivered: string[] = [];
  let providerUp = false;
  const sendMail = async (to: string) => { if (!providerUp) throw new Error('provider down'); delivered.push(to); };
  const app = buildApp({ db, origin, logger: false, sendMail, teamEmail: 'team@example.test' });
  try {
    await addUser(db, 'customer', 'client@example.test');
    const call = caller(app);
    const cookie = (await call('POST', '/api/v1/auth/login', { email: 'client@example.test', password })).cookie!;
    const created = await call('POST', '/api/v1/requests', { templateId: 'custom', templateName: 'Custom', contact: { name: 'Client' }, clientSubmissionId: randomUUID() }, cookie);
    assert.equal((await call('POST', `/api/v1/requests/${created.body.id}/messages`, { body: 'Hello', clientMessageId: randomUUID() }, cookie)).status, 201);
    assert.equal((db.prepare('SELECT status FROM email_notifications').get() as { status: string }).status, 'failed');

    const notifier = createNotificationDelivery({ db, origin, sendMail, log: () => {} });
    assert.deepEqual(await notifier.retryDue(), { attempted: 0, sent: 0, failed: 0 }, 'a fresh failure waits before the next attempt');
    db.prepare('UPDATE email_notifications SET last_attempt_at=?').run(new Date(Date.now() - 20 * 60_000).toISOString());
    providerUp = true;
    assert.deepEqual(await notifier.retryDue(), { attempted: 1, sent: 1, failed: 0 });
    assert.deepEqual(delivered, ['team@example.test']);
    assert.equal((db.prepare('SELECT status FROM email_notifications').get() as { status: string }).status, 'sent');

    db.prepare("UPDATE email_notifications SET status='failed',attempts=6,last_attempt_at=?").run(new Date(Date.now() - 20 * 60_000).toISOString());
    assert.deepEqual(await notifier.retryDue(), { attempted: 0, sent: 0, failed: 0 }, 'exhausted notifications stay for manual retry');
  } finally { await app.close(); db.close(); }
});

test('a backup interrupted by a concurrent write is retried and published', async () => {
  const db = backupDatabase();
  try {
    await addUser(db, 'customer', 'first@example.test');
    let wrote = false;
    const store = memoryStore((key) => {
      if (wrote || key.endsWith('manifest.json')) return;
      wrote = true;
      db.prepare("UPDATE users SET name='Changed'").run();
    });
    const backup = await createLogicalBackupWithRetry(db, store, new Date(), undefined, { attempts: 3, delayMs: 0 });
    assert.ok(store.objects.has(backup.key));
    assert.equal(backup.manifest.rowCounts.users, 1);
  } finally { db.close(); }
});

test('large tables are exported completely in rowid order', async () => {
  const source = backupDatabase();
  const target = backupDatabase();
  try {
    const customerId = await addUser(source, 'customer', 'many@example.test');
    const requestIds = Array.from({ length: 130 }, () => seedRequest(source, customerId));
    const store = memoryStore();
    const backup = await createLogicalBackup(source, store);
    assert.equal(backup.manifest.rowCounts.requests, 130);
    assert.equal(backup.manifest.rowCounts.conversations, 130);
    await restoreLogicalBackup(target, store, backup.key);
    const restored = (target.prepare('SELECT id FROM requests ORDER BY rowid').all() as { id: string }[]).map((row) => row.id);
    assert.deepEqual(restored, requestIds);
  } finally { source.close(); target.close(); }
});

test('a customer-deleted request is recorded before deletion and refused when the ledger fails', async () => {
  const db = openDatabase(':memory:');
  const recorded: string[] = [];
  let ledgerUp = true;
  const app = buildApp({ db, origin, logger: false, recordRequestDeletion: async (requestId) => {
    if (!ledgerUp) throw new Error('ledger unavailable');
    recorded.push(requestId);
  } });
  try {
    await addUser(db, 'customer', 'owner@example.test');
    const call = caller(app);
    const cookie = (await call('POST', '/api/v1/auth/login', { email: 'owner@example.test', password })).cookie!;
    const create = () => call('POST', '/api/v1/requests', { templateId: 'custom', templateName: 'Custom', contact: { name: 'Owner' }, clientSubmissionId: randomUUID() }, cookie);
    const kept = (await create()).body.id;
    ledgerUp = false;
    assert.equal((await call('DELETE', `/api/v1/requests/${kept}`, undefined, cookie)).status, 503);
    assert.equal((await call('GET', `/api/v1/requests/${kept}`, undefined, cookie)).status, 200, 'nothing is deleted without a ledger entry');
    ledgerUp = true;
    assert.equal((await call('DELETE', `/api/v1/requests/${kept}`, undefined, cookie)).status, 204);
    assert.deepEqual(recorded, [kept]);
  } finally { await app.close(); db.close(); }
});

test('deleted requests are purged again after a restore from backup', async () => {
  const source = backupDatabase();
  const target = backupDatabase();
  try {
    const customerId = await addUser(source, 'customer', 'restore@example.test');
    const deleted = seedRequest(source, customerId);
    const kept = seedRequest(source, customerId);
    const store = memoryStore();
    const backup = await createLogicalBackup(source, store);
    await restoreLogicalBackup(target, store, backup.key, [], undefined, [deleted]);
    const ids = (target.prepare('SELECT id FROM requests').all() as { id: string }[]).map((row) => row.id);
    assert.deepEqual(ids, [kept]);
    assert.equal((target.prepare('SELECT COUNT(*) count FROM conversations').get() as { count: number }).count, 1);
  } finally { source.close(); target.close(); }
});

test('purgeRequest is idempotent and the local ledger replays request deletions', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'seltivo-request-ledger-'));
  const previous = process.env.SELTIVO_DB_PATH;
  process.env.SELTIVO_DB_PATH = join(directory, 'seltivo.db');
  t.after(() => {
    if (previous === undefined) delete process.env.SELTIVO_DB_PATH;
    else process.env.SELTIVO_DB_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const db = openDatabase(':memory:');
  try {
    const customerId = await addUser(db, 'customer', 'ledger@example.test');
    const requestId = seedRequest(db, customerId);
    recordLocalRequestDeletion(requestId);
    assert.equal(replayLocalDeletions(db), 1);
    assert.equal(db.prepare('SELECT id FROM requests WHERE id=?').get(requestId), undefined);
    assert.doesNotThrow(() => purgeRequest(db, requestId));
    assert.ok(db.prepare('SELECT id FROM users WHERE id=?').get(customerId), 'the customer account stays');
  } finally { db.close(); }
});
