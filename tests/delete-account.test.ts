import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { hashPassword, now } from '../src/auth.js';
import { openDatabase } from '../src/db.js';
import { purgeCustomer } from '../src/delete-account.js';

const origin = 'http://localhost:3000';

test('customer deletion removes related data and the external ledger prevents backup resurrection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'seltivo-deletion-'));
  const backupPath = join(directory, 'before-deletion.db');
  const db = openDatabase(':memory:');
  const deleted = new Set<string>();
  const app = buildApp({ db, origin, logger: false, teamEmail: 'team@example.test',
    sendMail: async () => { throw new Error('smtp failed'); },
    deleteCustomer: async (userId) => { deleted.add(userId); purgeCustomer(db, userId); } });
  const call = async (method: string, url: string, payload?: unknown, cookie?: string, headers?: Record<string, string>) => {
    const response = await app.inject({ method: method as 'GET', url, headers: { origin, ...(cookie ? { cookie } : {}), ...headers }, payload } as any);
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null, cookie: response.headers['set-cookie'] as string | undefined };
  };
  try {
    const register = async (email: string) => {
      const result = await call('POST', '/api/v1/auth/register', { email, password: 'VeryStrongPass123!', name: 'Customer' });
      const login = await call('POST', '/api/v1/auth/login', { email, password: 'VeryStrongPass123!' });
      return { id: result.body.id as string, cookie: login.cookie!.split(';')[0] };
    };
    const alice = await register('alice@example.test');
    const bob = await register('bob@example.test');
    const timestamp = now();
    db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin',?,?,?)")
      .run(randomUUID(), 'admin@example.test', await hashPassword('VeryStrongPass123!'), timestamp, timestamp, timestamp);
    const admin = (await call('POST', '/api/v1/auth/login', { email: 'admin@example.test', password: 'VeryStrongPass123!' })).cookie!.split(';')[0];
    const config = await call('POST', '/api/v1/configurations', { templateId: 'fashion-01', name: 'Saved', data: { id: 'brand', name: 'Brand', colors: {}, hero: {}, home: {}, products: [] } }, alice.cookie);
    const request = await call('POST', '/api/v1/requests', { templateId: 'fashion-01', templateName: 'Fashion 01', configurationId: config.body.id, contact: { name: 'Alice' }, clientSubmissionId: randomUUID() }, alice.cookie);
    assert.equal(request.status, 201);
    assert.equal((await call('POST', `/api/v1/requests/${request.body.id}/messages`, { body: 'Customer message', clientMessageId: randomUUID() }, alice.cookie)).status, 201);
    assert.equal((await call('POST', `/api/v1/requests/${request.body.id}/messages`, { body: 'Admin reply', clientMessageId: randomUUID() }, admin)).status, 201);
    assert.equal((await call('PATCH', `/api/v1/admin/requests/${request.body.id}/status`, { status: 'reviewing' }, admin, { 'if-match': '1' })).status, 200);
    await db.backup(backupPath);

    assert.equal((await call('DELETE', '/api/v1/me', { password: 'wrong-password' }, alice.cookie)).status, 401);
    assert.equal((await call('DELETE', '/api/v1/me', { password: 'VeryStrongPass123!' }, admin)).status, 403);
    assert.equal(deleted.size, 0);
    assert.equal((await call('DELETE', '/api/v1/me', { password: 'VeryStrongPass123!' }, alice.cookie)).status, 204);
    assert.equal((await call('GET', '/api/v1/me', undefined, alice.cookie)).status, 401);
    assert.equal((await call('GET', '/api/v1/me', undefined, bob.cookie)).status, 200);
    assert.equal((await call('GET', `/api/v1/requests/${request.body.id}`, undefined, admin)).status, 404);
    for (const table of ['users', 'configurations', 'requests', 'conversations', 'messages', 'email_notifications', 'notifications', 'request_events']) {
      const rows = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      if (table === 'users') assert.equal(rows.count, 2); else assert.equal(rows.count, 0);
    }
    assert.equal((db.pragma('foreign_key_check') as unknown[]).length, 0);
    purgeCustomer(db, alice.id);

    const restored = openDatabase(backupPath);
    try {
      assert.equal((restored.prepare('SELECT COUNT(*) AS count FROM requests').get() as { count: number }).count, 1);
      for (const id of deleted) purgeCustomer(restored, id);
      assert.equal((restored.prepare('SELECT COUNT(*) AS count FROM requests').get() as { count: number }).count, 0);
      assert.equal((restored.prepare('SELECT COUNT(*) AS count FROM users WHERE id=?').get(alice.id) as { count: number }).count, 0);
      assert.equal((restored.pragma('foreign_key_check') as unknown[]).length, 0);
    } finally { restored.close(); }
  } finally {
    await app.close(); db.close();
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('seltivo-deletion-')) throw new Error('Unsafe test cleanup path');
    rmSync(target, { recursive: true, force: true });
  }
});

test('admin can delete a customer even when self-service deletion is disabled', async () => {
  const db = openDatabase(':memory:');
  const deleted: string[] = [];
  const app = buildApp({ db, origin, logger: false,
    deleteCustomer: async (userId) => { deleted.push(userId); purgeCustomer(db, userId); },
    selfServiceDeletionEnabled: false });
  const call = async (method: string, url: string, payload?: unknown, cookie?: string) => {
    const response = await app.inject({ method: method as 'GET', url, headers: { origin, ...(cookie ? { cookie } : {}) }, payload } as any);
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null, cookie: response.headers['set-cookie'] as string | undefined };
  };
  try {
    const email = 'admin-delete@example.test';
    const password = 'VeryStrongPass123!';
    const registered = await call('POST', '/api/v1/auth/register', { email, password, name: 'Customer' });
    assert.equal(registered.status, 201);
    const customerId = (db.prepare('SELECT id FROM users WHERE email=?').get(email) as { id: string }).id;
    const customer = (await call('POST', '/api/v1/auth/login', { email, password })).cookie!.split(';')[0];
    const timestamp = now();
    db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin',?,?,?)")
      .run(randomUUID(), 'admin@example.test', await hashPassword(password), timestamp, timestamp, timestamp);
    const admin = (await call('POST', '/api/v1/auth/login', { email: 'admin@example.test', password })).cookie!.split(';')[0];

    assert.equal((await call('GET', '/api/v1/me', undefined, customer)).body.accountDeletionAvailable, false);
    assert.equal((await call('DELETE', '/api/v1/me', { password }, customer)).status, 503);
    assert.equal((await call('DELETE', `/api/v1/admin/customers/${customerId}`, undefined, customer)).status, 403);
    assert.equal((await call('DELETE', '/api/v1/admin/customers/not-a-uuid', undefined, admin)).status, 422);
    assert.equal((await call('DELETE', `/api/v1/admin/customers/${randomUUID()}`, undefined, admin)).status, 404);

    assert.equal((await call('DELETE', `/api/v1/admin/customers/${customerId}`, undefined, admin)).status, 204);
    assert.deepEqual(deleted, [customerId]);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM users WHERE id=?').get(customerId) as { count: number }).count, 0);
    assert.equal((await call('GET', `/api/v1/admin/customers/${customerId}`, undefined, admin)).status, 404);
    const audit = db.prepare("SELECT actor_id actorId,action,entity_id entityId FROM audit_log WHERE action='customer.delete'").get() as { actorId: string; action: string; entityId: string } | undefined;
    assert.equal(audit?.entityId, customerId);
    assert.notEqual(audit?.actorId, customerId);
  } finally { await app.close(); db.close(); }
});

test('account deletion stays unavailable without the external ledger', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false });
  try {
    const email = 'feature-gate@example.test';
    const password = 'VeryStrongPass123!';
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { origin }, payload: { email, password, name: 'Customer' } })).statusCode, 201);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { email, password } });
    const cookie = (login.headers['set-cookie'] as string).split(';')[0];
    const headers = { origin, cookie };
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers });
    assert.equal(me.json().accountDeletionAvailable, false);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/me', headers, payload: { password } })).statusCode, 503);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me', headers })).statusCode, 200);
  } finally { await app.close(); db.close(); }
});
