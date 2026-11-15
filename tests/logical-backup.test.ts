import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db.js';
import { openCloudflareDatabase } from '../src/cloudflare-db.js';
import { createLogicalBackup, restoreLogicalBackup } from '../src/logical-backup.js';
import { now, hashPassword } from '../src/auth.js';

function database() {
  const db = openDatabase(':memory:');
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(2, now());
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

function seedUser(db: ReturnType<typeof database>, email: string) {
  const date = now();
  db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'customer','Customer',?,?,?)")
    .run(randomUUID(), email, 'hash', date, date, date);
}

function cloudflareDatabase() {
  const sqlite = new Database(':memory:');
  const storage = {
    sql: { exec(query: string, ...values: (string | number | null)[]) {
      if (!values.length && query.includes('CREATE TABLE')) { sqlite.exec(query); return { toArray: () => [] }; }
      const statement = sqlite.prepare(query);
      const rows = statement.reader ? statement.all(...values) : (statement.run(...values), []);
      return { toArray: () => rows as Record<string, unknown>[] };
    } },
    transactionSync<T>(callback: () => T) { return sqlite.transaction(callback)(); },
  };
  return { db: openCloudflareDatabase(storage), close: () => sqlite.close() };
}

test('logical backup restores data and replays confirmed deletion', async () => {
  const source = database();
  const target = database();
  const deletedTarget = database();
  try {
    const userId = randomUUID();
    const date = now();
    source.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'customer','Alice',?,?,?)")
      .run(userId, 'alice@example.test', await hashPassword('StrongPassword123!'), date, date, date);
    const configId = randomUUID();
    source.prepare('INSERT INTO configurations(id,owner_id,template_id,name,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(configId, userId, 'fashion-01', 'Saved', '{"brand":"Alice"}', date, date);
    const requestId = randomUUID();
    source.prepare("INSERT INTO requests(id,customer_id,template_id,template_name,configuration_id,config_snapshot_json,contact_json,note,features_json,client_submission_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'submitted',?,?)")
      .run(requestId, userId, 'fashion-01', 'Fashion', configId, '{"brand":"Alice"}', '{"name":"Alice"}', '', '[]', randomUUID(), date, date);
    const conversationId = randomUUID();
    source.prepare('INSERT INTO conversations(id,request_id,created_at) VALUES (?,?,?)').run(conversationId, requestId, date);
    source.prepare('INSERT INTO messages(conversation_id,sender_id,client_message_id,body,created_at) VALUES (?,?,?,?,?)')
      .run(conversationId, userId, randomUUID(), 'Hello', date);
    const store = memoryStore();
    const backup = await createLogicalBackup(source, store);
    assert.equal(backup.manifest.rowCounts.users, 1);
    assert.equal(backup.manifest.rowCounts.requests, 1);
    assert.equal(backup.manifest.rowCounts.messages, 1);
    assert.ok(backup.bytes > 0);
    await restoreLogicalBackup(target, store, backup.key);
    assert.equal((target.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 1);
    assert.equal((target.prepare('SELECT body FROM messages').get() as { body: string }).body, 'Hello');
    assert.equal((target.pragma('foreign_key_check') as unknown[]).length, 0);
    await restoreLogicalBackup(deletedTarget, store, backup.key, [userId]);
    assert.equal((deletedTarget.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 0);
    assert.equal((deletedTarget.prepare('SELECT COUNT(*) AS count FROM requests').get() as { count: number }).count, 0);
    assert.equal((deletedTarget.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count, 0);
    assert.equal((deletedTarget.pragma('foreign_key_check') as unknown[]).length, 0);
  } finally { source.close(); target.close(); deletedTarget.close(); }
});

test('concurrent write prevents publication of a completed backup', async () => {
  const db = database();
  try {
    seedUser(db, 'initial@example.test');
    let wrote = false;
    const store = memoryStore((key) => {
      if (wrote || key.endsWith('manifest.json')) return;
      wrote = true;
      seedUser(db, 'new@example.test');
    });
    await assert.rejects(createLogicalBackup(db, store), /Database changed during backup/);
    assert.equal([...store.objects.keys()].some((key) => key.endsWith('manifest.json')), false);
  } finally { db.close(); }
});

test('restore rejects damaged backup chunks', async () => {
  const source = database();
  const target = database();
  try {
    seedUser(source, 'initial@example.test');
    const store = memoryStore();
    const backup = await createLogicalBackup(source, store);
    const first = backup.manifest.chunks[0];
    assert.ok(first);
    store.objects.set(first.key, '[]');
    await assert.rejects(restoreLogicalBackup(target, store, backup.key), /checksum mismatch/);
  } finally { source.close(); target.close(); }
});

test('unknown table prevents an incomplete logical backup', async () => {
  const db = database();
  try {
    db.exec('CREATE TABLE unexpected_data (id TEXT PRIMARY KEY)');
    const store = memoryStore();
    await assert.rejects(createLogicalBackup(db, store), /table inventory/);
    assert.equal(store.objects.size, 0);
  } finally { db.close(); }
});

test('Cloudflare internal KV table is excluded from the application backup', async () => {
  const db = database();
  try {
    db.exec('CREATE TABLE __cf_kv (key TEXT PRIMARY KEY, value TEXT)');
    db.exec('CREATE TABLE _cf_METADATA (key TEXT PRIMARY KEY, value TEXT)');
    const backup = await createLogicalBackup(db, memoryStore());
    assert.equal(backup.manifest.rowCounts.users, 0);
  } finally { db.close(); }
});

test('logical backup restores through the Cloudflare SQL adapter', async () => {
  const source = cloudflareDatabase();
  const target = cloudflareDatabase();
  try {
    const date = now();
    source.db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,'worker@example.test','hash','customer','Worker',?,?,?)")
      .run(randomUUID(), date, date, date);
    const store = memoryStore();
    const backup = await createLogicalBackup(source.db, store);
    await restoreLogicalBackup(target.db, store, backup.key);
    assert.equal((target.db.prepare('SELECT email FROM users').get() as { email: string }).email, 'worker@example.test');
    assert.equal((target.db.pragma('foreign_key_check') as unknown[]).length, 0);
  } finally { source.close(); target.close(); }
});
