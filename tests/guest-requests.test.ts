import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { hashPassword, now } from '../src/auth.js';
import { openDatabase } from '../src/db.js';

process.env.NODE_ENV = 'test';
const origin = 'https://seltivo.example';
const password = 'VeryStrongPass123!';

const call = async (app: ReturnType<typeof buildApp>, method: string, url: string, payload?: unknown, cookie?: string) => {
  const response: any = await app.inject({ method, url, headers: { origin, ...(cookie ? { cookie } : {}) }, payload } as any);
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
};

test('guest requests are stored, idempotent, visible to admins and can be processed', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false });
  try {
    const id = randomUUID();
    const brief = { id, name: 'Гість', contact: '@guest_user', features: ['Новий дизайн'], budget: '5000', note: 'Опис задачі', templateName: 'Fashion 01', telegramStatus: 'sent' };
    assert.equal((await call(app, 'POST', '/api/v1/guest-requests', brief)).status, 201);
    // Повтор з тим самим ID (наприклад, retry після таймауту) не створює копію.
    assert.equal((await call(app, 'POST', '/api/v1/guest-requests', brief)).status, 200);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM guest_requests').get() as { count: number }).count, 1);
    assert.equal((await call(app, 'POST', '/api/v1/guest-requests', { ...brief, id: randomUUID(), name: 'Х' })).status, 422);

    assert.equal((await call(app, 'GET', '/api/v1/admin/guest-requests')).status, 401);
    assert.equal((await call(app, 'PATCH', `/api/v1/admin/guest-requests/${id}/status`, { status: 'done' })).status, 401);

    const timestamp = now();
    db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin',?,?,?)")
      .run(randomUUID(), 'admin@example.test', await hashPassword(password), timestamp, timestamp, timestamp);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { email: 'admin@example.test', password } });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];

    const list = await call(app, 'GET', '/api/v1/admin/guest-requests', undefined, cookie);
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].name, 'Гість');
    assert.deepEqual(list.body.items[0].features, ['Новий дизайн']);
    assert.equal(list.body.items[0].templateName, 'Fashion 01');
    assert.equal(list.body.items[0].telegramStatus, 'sent');
    assert.equal(list.body.items[0].status, 'new');

    assert.equal((await call(app, 'PATCH', `/api/v1/admin/guest-requests/${id}/status`, { status: 'in_progress' }, cookie)).body.status, 'in_progress');
    const updated = await call(app, 'GET', '/api/v1/admin/guest-requests', undefined, cookie);
    assert.equal(updated.body.items[0].status, 'in_progress');
    assert.ok(updated.body.items[0].processedAt);
    assert.equal((await call(app, 'PATCH', `/api/v1/admin/guest-requests/${randomUUID()}/status`, { status: 'done' }, cookie)).status, 404);

    assert.equal((await call(app, 'POST', '/api/v1/auth/register', { email: 'customer@example.test', password, name: 'Customer' })).status, 201);
    const customer = String((await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { email: 'customer@example.test', password } })).headers['set-cookie']).split(';')[0];
    assert.equal((await call(app, 'GET', '/api/v1/admin/guest-requests', undefined, customer)).status, 403);
  } finally {
    await app.close();
    db.close();
  }
});
