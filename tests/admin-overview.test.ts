import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { hashPassword, now } from '../src/auth.js';
import { openDatabase } from '../src/db.js';

process.env.NODE_ENV = 'test';
const origin = 'http://localhost:3000';

test('admin overview and customer details aggregate real data and stay admin-only', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false });
  const call = async (method: string, url: string, payload?: unknown, cookie?: string) => {
    const response: any = await app.inject({ method, url, headers: { origin, ...(cookie ? { cookie } : {}) }, payload } as any);
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null, cookie: response.headers['set-cookie'] as string | undefined };
  };
  try {
    assert.equal((await call('POST', '/api/v1/auth/register', { email: 'customer@example.test', password: 'VeryStrongPass123!', name: 'Customer' })).status, 201);
    const customer = (await call('POST', '/api/v1/auth/login', { email: 'customer@example.test', password: 'VeryStrongPass123!' })).cookie!.split(';')[0];
    const customerId = (await call('GET', '/api/v1/me', undefined, customer)).body.id as string;
    const timestamp = now();
    db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin',?,?,?)")
      .run(randomUUID(), 'admin@example.test', await hashPassword('VeryStrongPass123!'), timestamp, timestamp, timestamp);
    const admin = (await call('POST', '/api/v1/auth/login', { email: 'admin@example.test', password: 'VeryStrongPass123!' })).cookie!.split(';')[0];

    // Порожній огляд: клієнти вже є, заявок і повідомлень ще немає.
    const empty = await call('GET', '/api/v1/admin/overview', undefined, admin);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.customers.total, 1);
    assert.equal(empty.body.customers.last7Days, 1);
    assert.equal(empty.body.requests.total, 0);
    assert.equal(empty.body.messages.unread, 0);
    assert.equal(empty.body.email.problems, 0);
    assert.equal(empty.body.system.ok, true);
    assert.equal(empty.body.system.emailConfigured, false);

    const config = await call('POST', '/api/v1/configurations', { templateId: 'fashion-01', name: 'Мій сайт', data: { id: 'brand', name: 'Brand', colors: {}, hero: {}, home: {}, products: [] } }, customer);
    assert.equal(config.status, 201);
    const submission = { templateId: 'fashion-01', templateName: 'Fashion 01', configurationId: config.body.id, contact: { name: 'Customer' }, note: '', features: [], clientSubmissionId: randomUUID() };
    const request = await call('POST', '/api/v1/requests', submission, customer);
    assert.equal(request.status, 201);
    assert.equal((await call('POST', `/api/v1/requests/${request.body.id}/messages`, { body: 'Питання', clientMessageId: randomUUID() }, customer)).status, 201);

    const overview = await call('GET', '/api/v1/admin/overview', undefined, admin);
    assert.equal(overview.body.requests.total, 1);
    assert.equal(overview.body.requests.last7Days, 1);
    assert.equal(overview.body.requests.byStatus.submitted, 1);
    assert.equal(overview.body.messages.unread, 1);
    assert.ok(Array.isArray(overview.body.recentAudit));

    const detail = await call('GET', `/api/v1/admin/customers/${customerId}`, undefined, admin);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.name, 'Customer');
    assert.equal(detail.body.stats.requestsCount, 1);
    assert.equal(detail.body.stats.configurationsCount, 1);
    assert.equal(detail.body.stats.messagesCount, 1);
    assert.equal(detail.body.requests.length, 1);
    assert.equal(detail.body.configurations.length, 1);

    // Звичайний клієнт не бачить ані огляду, ані чужих карток.
    assert.equal((await call('GET', '/api/v1/admin/overview', undefined, customer)).status, 403);
    assert.equal((await call('GET', `/api/v1/admin/customers/${customerId}`, undefined, customer)).status, 403);
    assert.equal((await call('GET', `/api/v1/admin/customers/${randomUUID()}`, undefined, admin)).status, 404);
  } finally {
    await app.close();
    db.close();
  }
});
