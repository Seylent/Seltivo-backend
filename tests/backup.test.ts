import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { randomUUID } from 'node:crypto';
import { copyFileSync } from 'node:fs';

function removeTestDirectory(directory: string) {
  const target = resolve(directory);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('seltivo-')) throw new Error(`Unsafe test cleanup path: ${target}`);
  rmSync(target, { recursive: true, force: true });
}

test('SQLite online backup restores committed data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'seltivo-backup-'));
  const source = openDatabase(join(directory, 'source.db'));
  try {
    source.prepare("INSERT INTO users(id,email,password_hash,role,name,created_at,updated_at) VALUES ('u1','user@example.test','hash','customer','User','2026-01-01','2026-01-01')").run();
    await source.backup(join(directory, 'copy.db'));
    const restored = openDatabase(join(directory, 'copy.db'));
    try {
      assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
      assert.deepEqual(restored.prepare('SELECT id,email FROM users').get(), { id: 'u1', email: 'user@example.test' });
    } finally { restored.close(); }
  } finally {
    source.close();
    removeTestDirectory(directory);
  }
});

test('a restored backup supports login, requests and chat in an isolated staging database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'seltivo-restore-'));
  const source = openDatabase(join(directory, 'source.db'));
  const origin = 'http://localhost:3000';
  const password = 'VeryStrongPass123!';
  const userId = randomUUID();
  const adminId = randomUUID();
  const timestamp = new Date().toISOString();
  const app = buildApp({ db: source, origin, logger: false });
  const call = async (method: string, url: string, payload?: unknown, cookie?: string) => {
    const response: any = await app.inject({ method, url, headers: { origin, ...(cookie ? { cookie } : {}) }, payload } as any);
    return response;
  };
  try {
    const passwordHash = await hashPassword(password);
    source.prepare('INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(userId, 'customer@example.test', passwordHash, 'customer', 'Customer', timestamp, timestamp, timestamp);
    source.prepare('INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(adminId, 'admin@example.test', passwordHash, 'admin', 'Admin', timestamp, timestamp, timestamp);
    const login = await call('POST', '/api/v1/auth/login', { email: 'customer@example.test', password });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const created = await call('POST', '/api/v1/requests', {
      templateId: 'fashion-01', templateName: 'Fashion 01', contact: { name: 'Customer', email: 'customer@example.test' },
      note: 'Restore drill', features: [], clientSubmissionId: randomUUID(),
    }, cookie);
    assert.equal(created.statusCode, 201);
    const requestId = created.json().id as string;
    const sent = await call('POST', `/api/v1/requests/${requestId}/messages`, { body: 'Before backup', clientMessageId: randomUUID() }, cookie);
    assert.equal(sent.statusCode, 201);
    await source.backup(join(directory, 'backup.db'));
    await app.close();
    source.close();

    copyFileSync(join(directory, 'backup.db'), join(directory, 'staging.db'));
    const staging = openDatabase(join(directory, 'staging.db'));
    const stagingApp = buildApp({ db: staging, origin, logger: false });
    try {
      assert.equal(staging.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal((staging.pragma('foreign_key_check') as unknown[]).length, 0);
      const restoredLogin = await stagingApp.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { email: 'customer@example.test', password } });
      assert.equal(restoredLogin.statusCode, 200);
      const restoredCookie = String(restoredLogin.headers['set-cookie']).split(';')[0];
      const restoredRequest = await stagingApp.inject({ method: 'GET', url: `/api/v1/requests/${requestId}`, headers: { cookie: restoredCookie } });
      assert.equal(restoredRequest.statusCode, 200);
      assert.equal(restoredRequest.json().note, 'Restore drill');
      const messages = await stagingApp.inject({ method: 'GET', url: `/api/v1/requests/${requestId}/messages`, headers: { cookie: restoredCookie } });
      assert.equal(messages.statusCode, 200);
      assert.equal(messages.json().items[0].body, 'Before backup');
      const adminLogin = await stagingApp.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { email: 'admin@example.test', password } });
      assert.equal(adminLogin.statusCode, 200);
      const adminCookie = String(adminLogin.headers['set-cookie']).split(';')[0];
      const reply = await stagingApp.inject({ method: 'POST', url: `/api/v1/requests/${requestId}/messages`, headers: { origin, cookie: adminCookie }, payload: { body: 'After restore', clientMessageId: randomUUID() } });
      assert.equal(reply.statusCode, 201);
      const conversation = await stagingApp.inject({ method: 'GET', url: `/api/v1/requests/${requestId}/messages`, headers: { cookie: restoredCookie } });
      assert.deepEqual(conversation.json().items.map((message: { body: string }) => message.body), ['Before backup', 'After restore']);
    } finally { await stagingApp.close(); staging.close(); }
  } finally {
    if (source.open) { await app.close(); source.close(); }
    removeTestDirectory(directory);
  }
});
