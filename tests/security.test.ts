import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createWorkerRouter } from '../cloudflare/worker-router.js';

process.env.NODE_ENV = 'test';
const origin = 'http://localhost:3000';

const post = (app: ReturnType<typeof buildApp>, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { origin, ...headers }, payload } as never);

test('health is cheap and reports database integrity', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin });
  try {
    const first = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { origin } });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['x-content-type-options'], 'nosniff');
    assert.equal(first.headers['x-frame-options'], 'DENY');
    assert.deepEqual(first.json(), { ok: true });
    const second = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { origin } });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json(), { ok: true });
  } finally { db.close(); }
});

test('state-changing requests require the configured origin', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin });
  try {
    const rejected = await post(app, '/api/v1/auth/login', { email: 'nobody@example.test', password: 'wrong-password' }, { origin: 'https://evil.example' });
    assert.equal(rejected.statusCode, 403);
  } finally { db.close(); }
});

test('login attempts are throttled with Retry-After', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin });
  try {
    let response = await post(app, '/api/v1/auth/login', { email: 'nobody@example.test', password: 'wrong-password' });
    for (let attempt = 1; attempt < 10; attempt += 1) {
      response = await post(app, '/api/v1/auth/login', { email: 'nobody@example.test', password: 'wrong-password' });
      assert.equal(response.statusCode, 401);
    }
    const limited = await post(app, '/api/v1/auth/login', { email: 'nobody@example.test', password: 'wrong-password' });
    assert.equal(limited.statusCode, 429);
    const retryAfter = Number(limited.headers['retry-after']);
    assert.ok(Number.isInteger(retryAfter) && retryAfter > 0);
  } finally { db.close(); }
});

test('login attempts targeting one email across rotating IPs are throttled', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, router: createWorkerRouter() });
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin, 'cf-connecting-ip': `198.51.100.${attempt + 1}` },
        payload: Buffer.from(JSON.stringify({ email: 'target@example.test', password: 'wrong-password' })),
      });
      assert.equal(response.statusCode, 401);
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin, 'cf-connecting-ip': '198.51.100.250' },
      payload: Buffer.from(JSON.stringify({ email: 'target@example.test', password: 'wrong-password' })),
    });
    assert.equal(blocked.statusCode, 429);
  } finally { db.close(); }
});

test('trailing slashes and dynamic message URLs cannot bypass or evict rate limits', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, router: createWorkerRouter() });
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register/',
        headers: { origin },
        payload: Buffer.from(JSON.stringify({ email: `slash-${attempt}@example.test`, password: 'VeryStrongPass123!', name: 'Customer' })),
      });
      assert.equal(created.statusCode, 201);
    }
    const blockedTrailingSlash = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register/',
      headers: { origin },
      payload: Buffer.from(JSON.stringify({ email: 'slash-6@example.test', password: 'VeryStrongPass123!', name: 'Customer' })),
    });
    assert.equal(blockedTrailingSlash.statusCode, 429);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const msg = await app.inject({
        method: 'POST',
        url: `/api/v1/requests/${randomUUID()}/messages`,
        headers: { origin },
        payload: Buffer.from(JSON.stringify({ body: 'hi', clientMessageId: randomUUID() })),
      });
      assert.equal(msg.statusCode, 401);
    }
    const blockedMessages = await app.inject({
      method: 'POST',
      url: `/api/v1/requests/${randomUUID()}/messages`,
      headers: { origin },
      payload: Buffer.from(JSON.stringify({ body: 'hi', clientMessageId: randomUUID() })),
    });
    assert.equal(blockedMessages.statusCode, 429);
  } finally { db.close(); }
});

test('registration has a stricter limit than other auth endpoints', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin });
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const created = await post(app, '/api/v1/auth/register', { email: `new-${attempt}@example.test`, password: 'VeryStrongPass123!', name: 'New Customer' });
      assert.equal(created.statusCode, 201);
    }
    const limited = await post(app, '/api/v1/auth/register', { email: 'new-6@example.test', password: 'VeryStrongPass123!', name: 'New Customer' });
    assert.equal(limited.statusCode, 429);
  } finally { db.close(); }
});

test('account deletion password confirmation is rate-limited and rejects short wrong passwords with 401', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, deleteCustomer: async () => {} });
  try {
    const registered = await post(app, '/api/v1/auth/register', { email: 'delete-limit@example.test', password: 'VeryStrongPass123!', name: 'Customer' });
    assert.equal(registered.statusCode, 201);
    const login = await post(app, '/api/v1/auth/login', { email: 'delete-limit@example.test', password: 'VeryStrongPass123!' });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const rejected = await app.inject({ method: 'DELETE', url: '/api/v1/me', headers: { origin, cookie }, payload: { password: 'short' } });
      assert.equal(rejected.statusCode, 401);
    }
    const limited = await app.inject({ method: 'DELETE', url: '/api/v1/me', headers: { origin, cookie }, payload: { password: 'short' } });
    assert.equal(limited.statusCode, 429);
  } finally { db.close(); }
});

test('sessions per user are capped and soft-deleted configurations free their payload', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, router: createWorkerRouter() });
  try {
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin },
      payload: Buffer.from(JSON.stringify({ email: 'cap@example.test', password: 'VeryStrongPass123!', name: 'Cap User' })),
    });
    let latestCookie = '';
    for (let i = 0; i < 15; i += 1) {
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin, 'cf-connecting-ip': `192.0.2.${i + 1}` },
        payload: Buffer.from(JSON.stringify({ email: 'cap@example.test', password: 'VeryStrongPass123!' })),
      });
      assert.equal(login.statusCode, 200);
      latestCookie = String(login.headers['set-cookie']).split(';')[0];
    }
    const sessionCount = (db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
    assert.equal(sessionCount, 10);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/configurations',
      headers: { origin, cookie: latestCookie },
      payload: Buffer.from(JSON.stringify({
        templateId: 'fashion-01',
        name: 'Draft',
        data: { id: 'brand', name: 'Large Brand', colors: {}, hero: {}, home: {}, products: ['a', 'b', 'c'] },
      })),
    });
    assert.equal(created.statusCode, 201);
    const configId = JSON.parse(created.rawPayload.toString()).id as string;
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/configurations/${configId}`,
      headers: { origin, cookie: latestCookie },
    });
    assert.equal(deleted.statusCode, 204);
    const stored = db.prepare('SELECT data_json, deleted_at FROM configurations WHERE id=?').get(configId) as { data_json: string; deleted_at: string | null };
    assert.equal(stored.data_json, '{}');
    assert.ok(stored.deleted_at);
  } finally { db.close(); }
});

test('read requests have a bounded global rate limit', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, router: createWorkerRouter() });
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { origin } });
      assert.equal(response.statusCode, 200);
    }
    const limited = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { origin } });
    assert.equal(limited.statusCode, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
  } finally { db.close(); }
});

test('admin write endpoints are throttled before authentication', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, router: createWorkerRouter() });
  try {
    const url = `/api/v1/admin/requests/${randomUUID()}/reopen`;
    const payload = Buffer.from(JSON.stringify({ reason: 'rate limit check' }));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await app.inject({ method: 'POST', url, headers: { origin }, payload });
      assert.equal(response.statusCode, 401);
    }
    const limited = await app.inject({ method: 'POST', url, headers: { origin }, payload });
    assert.equal(limited.statusCode, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
  } finally { db.close(); }
});
