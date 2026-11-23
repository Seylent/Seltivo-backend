import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { hashPassword, now } from '../src/auth.js';
import { planDataRetention, applyDataRetention } from '../src/data-retention.js';

process.env.NODE_ENV = 'test';
const origin = 'https://seltivo.example';
const password = 'DataControlTest123!';

async function fixture(options: Record<string, unknown> = {}) {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false, ...options });
  const userId = randomUUID(), timestamp = now();
  db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'customer','Customer',?,?,?)")
    .run(userId, `${userId}@example.test`, await hashPassword(password), timestamp, timestamp, timestamp);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { email: `${userId}@example.test`, password } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const call = (method: string, url: string, payload?: unknown, extra = {}) => app.inject({ method, url, payload, headers: { origin, cookie, ...extra } } as never);
  return { db, app, userId, call };
}
const configuration = { templateId: 'fashion-01', name: 'Brand', data: { id: 'brand', name: 'Brand', colors: {}, hero: {}, home: {}, products: [] } };

test('account export is authenticated, owner-scoped and excludes all credentials', async () => {
  const { db, app, userId, call } = await fixture();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me/export' })).statusCode, 401);
    const created = await call('POST', '/api/v1/configurations', configuration);
    assert.equal(created.statusCode, 201);
    const otherId = randomUUID(), timestamp = now();
    db.prepare("INSERT INTO users(id,email,password_hash,role,name,created_at,updated_at) VALUES (?,?,?,'customer','Other',?,?)")
      .run(otherId, 'other@example.test', 'secret-other-hash', timestamp, timestamp);
    const response = await call('GET', '/api/v1/me/export');
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-disposition']), /attachment/);
    assert.match(String(response.headers['cache-control']), /no-store/);
    assert.equal(response.json().profile.id, userId);
    assert.equal(response.json().configurations[0].id, created.json().id);
    assert.doesNotMatch(response.body, /password_hash|token_hash|recovery_codes|secret-other-hash|other@example\.test/);
  } finally { await app.close(); db.close(); }
});

test('aggregate configuration quota accounts for replacement bytes and deletion frees the budget', async () => {
  const bytes = Buffer.byteLength(JSON.stringify(configuration.data));
  const { db, app, call } = await fixture({ dataLimits: { accountBytes: bytes + 5 } });
  try {
    const first = await call('POST', '/api/v1/configurations', configuration);
    assert.equal(first.statusCode, 201);
    assert.equal((await call('POST', '/api/v1/configurations', configuration)).statusCode, 422);
    assert.equal((await call('PATCH', `/api/v1/configurations/${first.json().id}`, { name: 'Rename', data: configuration.data }, { 'if-match': '1' })).statusCode, 200);
    assert.equal((await call('DELETE', `/api/v1/configurations/${first.json().id}`)).statusCode, 204);
    assert.equal((await call('POST', '/api/v1/configurations', configuration)).statusCode, 201);
  } finally { await app.close(); db.close(); }
});

test('guest total quota rejects new records but preserves accepted idempotent retries', async () => {
  const { db, app, call } = await fixture({ dataLimits: { guestRequests: 1 } });
  const brief = { id: randomUUID(), name: 'Guest', contact: '@test', features: ['Catalog'], budget: '', note: '', telegramStatus: 'failed' };
  try {
    assert.equal((await call('POST', '/api/v1/guest-requests', brief)).statusCode, 201);
    assert.equal((await call('POST', '/api/v1/guest-requests', { ...brief, id: randomUUID() })).statusCode, 503);
    assert.equal((await call('POST', '/api/v1/guest-requests', { ...brief, telegramStatus: 'sent' })).statusCode, 200);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM guest_requests').get() as { count: number }).count, 1);
  } finally { await app.close(); db.close(); }
});

test('retention defaults to preserving requests and guests; explicit policies remove only old terminal records', async () => {
  const { db, app, call } = await fixture();
  try {
    const config = await call('POST', '/api/v1/configurations', configuration);
    const body = { templateId: 'fashion-01', templateName: 'Fashion', configurationId: config.json().id, contact: { name: 'Customer' }, features: [], note: '', clientSubmissionId: randomUUID() };
    const terminal = await call('POST', '/api/v1/requests', body);
    const active = await call('POST', '/api/v1/requests', { ...body, clientSubmissionId: randomUUID() });
    assert.equal(terminal.statusCode, 201);
    assert.equal(active.statusCode, 201);
    const old = '2020-01-01T00:00:00.000Z';
    db.prepare("UPDATE requests SET status='completed',updated_at=? WHERE id=?").run(old, terminal.json().id);
    db.prepare('UPDATE requests SET updated_at=? WHERE id=?').run(old, active.json().id);
    await call('DELETE', `/api/v1/configurations/${config.json().id}`);
    db.prepare('UPDATE configurations SET deleted_at=?').run(old);
    assert.equal(planDataRetention(db, { deletedConfigurationDays: 30 }).configurations, 0, 'referenced configurations survive');
    assert.equal(planDataRetention(db, { deletedConfigurationDays: 30 }).requests, undefined, 'no implicit legal retention period');
    const policy = { deletedConfigurationDays: 30, terminalRequestDays: 365 };
    assert.equal(planDataRetention(db, policy).requests, 1);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM requests').get() as { count: number }).count, 2, 'planning does not delete');
    assert.equal(applyDataRetention(db, policy).requests, 1);
    assert.ok(db.prepare('SELECT id FROM requests WHERE id=?').get(active.json().id));
    assert.ok(db.prepare('SELECT id FROM configurations WHERE id=?').get(config.json().id));
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { await app.close(); db.close(); }
});
