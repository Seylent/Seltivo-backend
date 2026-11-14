import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { hashPassword, now } from '../src/auth.js';
import { openDatabase } from '../src/db.js';

process.env.NODE_ENV = 'test';
const origin = 'http://localhost:3000';

test('registration, ownership, idempotent requests, chat and admin status', async () => {
  const db = openDatabase(':memory:');
  const sent: { to: string; text: string }[] = [];
  const app = buildApp({ db, origin, sendMail: async (to, _subject, text) => { sent.push({ to, text }); } });
  const call = async (method: string, url: string, payload?: unknown, cookie?: string, headers?: Record<string, string>) => {
    const response: any = await app.inject({ method, url, headers: { origin, ...(cookie ? { cookie } : {}), ...headers }, payload } as any);
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null, cookie: response.headers['set-cookie'] as string | undefined };
  };
  const user = async (name: string) => {
    const email = `${name}@example.test`;
    const registration = await call('POST', '/api/v1/auth/register', { email, password: 'VeryStrongPass123!', name });
    assert.equal(registration.status, 201);
    assert.equal(registration.body.verificationRequired, false);
    const login = await call('POST', '/api/v1/auth/login', { email, password: 'VeryStrongPass123!' });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.emailVerified, true);
    return login.cookie!.split(';')[0];
  };
  try {
    const alice = await user('alice');
    const bob = await user('bob');
    const config = await call('POST', '/api/v1/configurations', { templateId: 'fashion-01', name: 'Мій сайт', data: { id: 'brand', name: 'Brand', colors: {}, hero: {}, home: {}, products: [] } }, alice);
    assert.equal(config.status, 201);
    assert.equal((await call('GET', `/api/v1/configurations/${config.body.id}`, undefined, bob)).status, 404);
    const submissionKey = randomUUID();
    const submission = { templateId: 'fashion-01', templateName: 'Fashion 01', configurationId: config.body.id, contact: { name: 'Alice', email: 'alice@example.test' }, note: '', features: [], clientSubmissionId: submissionKey };
    const first = await call('POST', '/api/v1/requests', submission, alice);
    assert.equal(first.status, 201);
    const saved = await call('GET', `/api/v1/requests/${first.body.id}`, undefined, alice);
    assert.equal(saved.body.configuration.name, 'Brand');
    const updated = await call('PATCH', `/api/v1/configurations/${config.body.id}`, { name: 'Оновлений сайт', data: { id: 'brand', name: 'Updated', colors: {}, hero: {}, home: {}, products: [] } }, alice, { 'if-match': '1' });
    assert.equal(updated.body.revision, 2);
    assert.equal((await call('GET', `/api/v1/requests/${first.body.id}`, undefined, alice)).body.configuration.name, 'Brand');
    assert.equal((await call('GET', `/api/v1/requests/${first.body.id}`, undefined, bob)).status, 404);
    assert.equal((await call('POST', `/api/v1/requests/${first.body.id}/messages`, { body: 'Hi', clientMessageId: randomUUID() }, bob)).status, 404);
    const messageKey = randomUUID();
    const message = await call('POST', `/api/v1/requests/${first.body.id}/messages`, { body: 'Hi', clientMessageId: messageKey }, alice);
    assert.equal(message.status, 201);
    assert.equal((await call('POST', `/api/v1/requests/${first.body.id}/messages`, { body: 'Hi', clientMessageId: messageKey }, alice)).status, 200);
    const messages = await call('GET', `/api/v1/requests/${first.body.id}/messages`, undefined, alice);
    assert.equal(messages.body.items.length, 1);
    assert.equal(messages.body.items[0].readByRecipient, false);
    const adminId = randomUUID(), timestamp = now();
    db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin',?,?,?)")
      .run(adminId, 'admin@example.test', await hashPassword('VeryStrongPass123!'), timestamp, timestamp, timestamp);
    const admin = (await call('POST', '/api/v1/auth/login', { email: 'admin@example.test', password: 'VeryStrongPass123!' })).cookie!.split(';')[0];
    const customersPage = await call('GET', '/api/v1/admin/customers?limit=1', undefined, admin);
    assert.equal(customersPage.body.items.length, 1);
    assert.equal(customersPage.body.nextOffset, 1);
    assert.equal((await call('GET', '/api/v1/admin/customers?limit=1&offset=1', undefined, admin)).body.items.length, 1);
    assert.equal((await call('GET', '/api/v1/requests?limit=1', undefined, alice)).body.items[0].id, first.body.id);
    assert.equal((await call('GET', '/api/v1/notifications/unread-count', undefined, admin)).body.total, 1);
    assert.equal((await call('PATCH', `/api/v1/requests/${first.body.id}/read`, { lastSeenMessageId: message.body.id }, admin)).status, 204);
    assert.equal((await call('GET', '/api/v1/notifications/unread-count', undefined, admin)).body.total, 0);
    assert.equal((await call('GET', `/api/v1/requests/${first.body.id}/messages`, undefined, alice)).body.items[0].readByRecipient, true);
    const status = await call('PATCH', `/api/v1/admin/requests/${first.body.id}/status`, { status: 'reviewing', reason: 'Розпочали' }, admin, { 'if-match': '1' });
    assert.equal(status.status, 200);
    assert.equal((await call('PATCH', `/api/v1/admin/requests/${first.body.id}/status`, { status: 'completed' }, admin, { 'if-match': '1' })).status, 409);
    assert.equal((await call('GET', `/api/v1/requests/${first.body.id}`, undefined, alice)).body.events.length, 2);
    assert.equal((await call('GET', '/api/v1/admin/customers', undefined, alice)).status, 403);
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin, 'content-type': 'application/json' }, payload: '{' });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.headers['cache-control'], 'private, no-store');
    const repeated = await call('POST', '/api/v1/requests', submission, alice);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.id, first.body.id);
    assert.equal((await call('POST', '/api/v1/requests', { ...submission, note: 'Інший вміст' }, alice)).status, 409);
    assert.equal((await call('POST', '/api/v1/auth/logout', {}, alice)).status, 204);
    assert.equal((await call('GET', '/api/v1/me', undefined, alice)).status, 401);
  } finally {
    await app.close(); db.close();
  }
});
