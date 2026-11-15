import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';

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
