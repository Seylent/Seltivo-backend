import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db.js';
import { openCloudflareDatabase } from '../src/cloudflare-db.js';
import { createLogicalBackup, restoreLogicalBackup } from '../src/logical-backup.js';
import { now, hashPassword } from '../src/auth.js';
import { MIGRATIONS } from '../src/schema.js';

function database() {
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

function seedUser(db: ReturnType<typeof database>, email: string) {
  const date = now();
  db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'customer','Customer',?,?,?)")
    .run(randomUUID(), email, 'hash', date, date, date);
}

function cloudflareDatabase() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
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
    source.prepare("INSERT INTO notifications(id,recipient_id,request_id,kind,status,created_at) VALUES (?,?,?,'status','reviewing',?)")
      .run(randomUUID(), userId, requestId, date);
    source.prepare('INSERT INTO messages(conversation_id,sender_id,client_message_id,body,created_at) VALUES (?,?,?,?,?)')
      .run(conversationId, userId, randomUUID(), 'Hello', date);
    const store = memoryStore();
    const backup = await createLogicalBackup(source, store);
    assert.equal(backup.manifest.rowCounts.users, 1);
    assert.equal(backup.manifest.rowCounts.requests, 1);
    assert.equal(backup.manifest.rowCounts.messages, 1);
    assert.equal(backup.manifest.rowCounts.notifications, 1);
    assert.ok(backup.bytes > 0);
    await restoreLogicalBackup(target, store, backup.key);
    assert.equal((target.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 1);
    assert.equal((target.prepare('SELECT body FROM messages').get() as { body: string }).body, 'Hello');
    assert.equal((target.prepare('SELECT COUNT(*) AS count FROM notifications').get() as { count: number }).count, 1);
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

function rewriteManifest(store: ReturnType<typeof memoryStore>, backupKey: string, mutate: (manifest: any) => void) {
  const manifest = JSON.parse(store.objects.get(backupKey)!) as any;
  mutate(manifest);
  store.objects.set(backupKey, JSON.stringify(manifest));
}

const backupEncryptionKey = randomBytes(32).toString('base64');

test('encrypted logical backup hides plaintext and restores with the key', async () => {
  const source = database();
  const target = database();
  try {
    const userId = randomUUID();
    const date = now();
    source.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'customer','Alice',?,?,?)")
      .run(userId, 'secret@example.test', await hashPassword('StrongPassword123!'), date, date, date);
    const store = memoryStore();
    const backup = await createLogicalBackup(source, store, new Date(), backupEncryptionKey);
    assert.equal(backup.manifest.encryption, 'aes-gcm-256');
    const userChunk = backup.manifest.chunks.find((chunk) => chunk.table === 'users');
    assert.ok(userChunk);
    assert.equal(Buffer.from(userChunk.iv ?? '', 'base64').byteLength, 12);
    const stored = store.objects.get(userChunk.key)!;
    assert.equal(stored.includes('secret@example.test'), false);
    assert.equal(Buffer.from(stored, 'utf8').byteLength, userChunk.bytes);
    const plaintext = JSON.stringify(source.prepare('SELECT * FROM users').all());
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plaintext)))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    assert.equal(userChunk.sha256, digest);
    await restoreLogicalBackup(target, store, backup.key, [], backupEncryptionKey);
    assert.equal((target.prepare('SELECT email FROM users').get() as { email: string }).email, 'secret@example.test');
    assert.equal((target.pragma('foreign_key_check') as unknown[]).length, 0);
  } finally { source.close(); target.close(); }
});

test('restoring an encrypted backup without the key is rejected', async () => {
  const source = database();
  const target = database();
  try {
    seedUser(source, 'no-key@example.test');
    const store = memoryStore();
    const backup = await createLogicalBackup(source, store, new Date(), backupEncryptionKey);
    await assert.rejects(restoreLogicalBackup(target, store, backup.key), /encryption key/i);
  } finally { source.close(); target.close(); }
});

test('a key supplied for a plaintext backup is tolerated', async () => {
  const source = database();
  const target = database();
  try {
    seedUser(source, 'plaintext@example.test');
    const store = memoryStore();
    const backup = await createLogicalBackup(source, store);
    assert.equal(backup.manifest.encryption, undefined);
    await restoreLogicalBackup(target, store, backup.key, [], backupEncryptionKey);
    assert.equal((target.prepare('SELECT email FROM users').get() as { email: string }).email, 'plaintext@example.test');
  } finally { source.close(); target.close(); }
});

test('a malformed encryption key is rejected on backup and restore', async () => {
  const source = database();
  const target = database();
  try {
    seedUser(source, 'bad-key@example.test');
    const store = memoryStore();
    await assert.rejects(createLogicalBackup(source, store, new Date(), 'not-a-key'), /32-byte key|encryption key/i);
    const backup = await createLogicalBackup(source, store, new Date(), backupEncryptionKey);
    await assert.rejects(restoreLogicalBackup(target, store, backup.key, [], 'short'), /32-byte key|encryption key/i);
  } finally { source.close(); target.close(); }
});

test('tampered encrypted ciphertext fails with a clear error', async () => {
  const source = database();
  const target = database();
  try {
    seedUser(source, 'tampered@example.test');
    const store = memoryStore();
    const backup = await createLogicalBackup(source, store, new Date(), backupEncryptionKey);
    const chunk = backup.manifest.chunks.find((item) => item.table === 'users')!;
    const stored = store.objects.get(chunk.key)!;
    store.objects.set(chunk.key, (stored[0] === 'A' ? 'B' : 'A') + stored.slice(1));
    await assert.rejects(restoreLogicalBackup(target, store, backup.key, [], backupEncryptionKey), /decrypt/i);
  } finally { source.close(); target.close(); }
});

test('tampered encrypted IV fails with a clear error', async () => {
  const source = database();
  const target = database();
  try {
    seedUser(source, 'tampered-iv@example.test');
    const store = memoryStore();
    const backup = await createLogicalBackup(source, store, new Date(), backupEncryptionKey);
    rewriteManifest(store, backup.key, (manifest) => {
      const chunk = manifest.chunks.find((item: any) => item.table === 'users');
      const iv = Buffer.from(chunk.iv, 'base64');
      iv[0] ^= 1;
      chunk.iv = iv.toString('base64');
    });
    await assert.rejects(restoreLogicalBackup(target, store, backup.key, [], backupEncryptionKey), /decrypt/i);
  } finally { source.close(); target.close(); }
});

test('an unknown encryption marker is rejected', async () => {
  const source = database();
  const target = database();
  try {
    seedUser(source, 'unknown-marker@example.test');
    const store = memoryStore();
    const backup = await createLogicalBackup(source, store);
    rewriteManifest(store, backup.key, (manifest) => { manifest.encryption = 'rot13'; });
    await assert.rejects(restoreLogicalBackup(target, store, backup.key, [], backupEncryptionKey), /encryption/i);
  } finally { source.close(); target.close(); }
});

test('a backup from an older schema version is restored', async () => {
  const source = database();
  const target = database();
  try {
    seedUser(source, 'old-schema@example.test');
    const store = memoryStore();
    const backup = await createLogicalBackup(source, store);
    rewriteManifest(store, backup.key, (manifest) => { manifest.schemaVersion = MIGRATIONS.at(-1)!.version - 1; });
    await restoreLogicalBackup(target, store, backup.key);
    assert.equal((target.prepare('SELECT email FROM users').get() as { email: string }).email, 'old-schema@example.test');
  } finally { source.close(); target.close(); }
});

test('restoring a pre-v9 backup replays v9 de-verification for customers only', async () => {
  const source = database();
  const target = database();
  try {
    const customerId = randomUUID();
    const adminId = randomUUID();
    const date = now();
    source.prepare('INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(customerId, 'v8-customer@example.test', 'hash', 'customer', 'Customer', date, date, date);
    source.prepare('INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(adminId, 'v8-admin@example.test', 'hash', 'admin', 'Admin', date, date, date);
    source.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
      .run('customer-session', customerId, '2027-01-01', date);
    source.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
      .run('admin-session', adminId, '2027-01-01', date);
    const store = memoryStore();
    const backup = await createLogicalBackup(source, store);
    // Simulate a backup taken at v8, before the semantic de-verification migration.
    rewriteManifest(store, backup.key, (manifest) => { manifest.schemaVersion = 8; });
    await restoreLogicalBackup(target, store, backup.key);
    assert.equal((target.prepare('SELECT email_verified_at FROM users WHERE id=?').get(customerId) as { email_verified_at: string | null }).email_verified_at, null);
    assert.equal((target.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get(customerId) as { count: number }).count, 0);
    assert.equal((target.prepare('SELECT email_verified_at FROM users WHERE id=?').get(adminId) as { email_verified_at: string | null }).email_verified_at, date);
    assert.equal((target.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get(adminId) as { count: number }).count, 1);
  } finally { source.close(); target.close(); }
});

test('restoring a v10 backup keeps customer verification and sessions', async () => {
  const source = database();
  const target = database();
  try {
    const customerId = randomUUID();
    const date = now();
    source.prepare('INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(customerId, 'v10-customer@example.test', 'hash', 'customer', 'Customer', date, date, date);
    source.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
      .run('customer-session', customerId, '2027-01-01', date);
    const store = memoryStore();
    const backup = await createLogicalBackup(source, store);
    rewriteManifest(store, backup.key, (manifest) => { manifest.schemaVersion = MIGRATIONS.at(-1)!.version; });
    await restoreLogicalBackup(target, store, backup.key);
    assert.equal((target.prepare('SELECT email_verified_at FROM users WHERE id=?').get(customerId) as { email_verified_at: string | null }).email_verified_at, date);
    assert.equal((target.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get(customerId) as { count: number }).count, 1);
  } finally { source.close(); target.close(); }
});

test('base64url-encoded encryption keys are accepted', async () => {
  const source = database();
  const target = database();
  try {
    seedUser(source, 'base64url@example.test');
    const store = memoryStore();
    // Fixed 32-byte base64url key containing both '-' and '_' so the
    // normalization branch is exercised on every run (a random key is not).
    const key = 'AxQlNkdYaXqLnK2-z-DxAhMkNUZXaHmKm6y9zt_wARI';
    assert.match(key, /-/);
    assert.match(key, /_/);
    const backup = await createLogicalBackup(source, store, new Date(), key);
    await restoreLogicalBackup(target, store, backup.key, [], key);
    assert.equal((target.prepare('SELECT email FROM users').get() as { email: string }).email, 'base64url@example.test');
  } finally { source.close(); target.close(); }
});

test('older-schema rows without later columns restore with column defaults', async () => {
  const source = database();
  const target = database();
  try {
    seedUser(source, 'legacy-columns@example.test');
    const store = memoryStore();
    const backup = await createLogicalBackup(source, store);
    const chunk = backup.manifest.chunks.find((item) => item.table === 'users')!;
    const rows = JSON.parse(store.objects.get(chunk.key)!) as any[];
    for (const row of rows) delete row.locale;
    const plaintext = JSON.stringify(rows);
    store.objects.set(chunk.key, plaintext);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plaintext)))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    rewriteManifest(store, backup.key, (manifest) => {
      manifest.schemaVersion = MIGRATIONS.at(-1)!.version - 1;
      const userChunk = manifest.chunks.find((item: any) => item.table === 'users');
      userChunk.bytes = Buffer.byteLength(plaintext);
      userChunk.sha256 = digest;
    });
    await restoreLogicalBackup(target, store, backup.key);
    assert.equal((target.prepare('SELECT email FROM users').get() as { email: string }).email, 'legacy-columns@example.test');
    assert.equal((target.prepare('SELECT locale FROM users').get() as { locale: string | null }).locale, null);
  } finally { source.close(); target.close(); }
});

test('a backup from a newer schema version is rejected', async () => {
  const source = database();
  const target = database();
  try {
    seedUser(source, 'future-schema@example.test');
    const store = memoryStore();
    const backup = await createLogicalBackup(source, store);
    rewriteManifest(store, backup.key, (manifest) => { manifest.schemaVersion = MIGRATIONS.at(-1)!.version + 1; });
    await assert.rejects(restoreLogicalBackup(target, store, backup.key), /newer than this application/);
  } finally { source.close(); target.close(); }
});
