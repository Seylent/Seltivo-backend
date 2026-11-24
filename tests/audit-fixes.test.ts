import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { openDatabase } from '../src/db.js';
import { requireMailForVerification } from '../src/server-config.js';
import { totpAt } from '../src/two-factor.js';

process.env.NODE_ENV = 'test';
const origin = 'http://localhost:3000';
const password = 'VeryStrongPass123!';
type App = ReturnType<typeof buildApp>;

const call = async (app: App, method: string, url: string, payload?: unknown, cookie?: string, extra: Record<string, unknown> = {}) => {
  const response: any = await app.inject({ method, url, headers: { origin, ...(cookie ? { cookie } : {}) }, payload, ...extra } as any);
  return { status: response.statusCode as number, body: response.body ? JSON.parse(response.body) : null, cookie: (response.headers['set-cookie'] as string | undefined)?.split(';')[0] };
};

async function addAdmin(db: ReturnType<typeof openDatabase>, email: string, createdAt: string) {
  db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin',?,?,?)")
    .run(randomUUID(), email, await hashPassword(password), createdAt, createdAt, createdAt);
}

const guest = () => ({ id: randomUUID(), name: 'Guest', contact: '@guest', features: ['shop'], budget: '', note: '', telegramStatus: 'sent' });

test('a percent-encoded path shares the rate-limit bucket of its route', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false });
  try {
    const remoteAddress = '203.0.113.9';
    for (let i = 0; i < 20; i++) assert.equal((await call(app, 'POST', '/api/v1/guest-requests', guest(), undefined, { remoteAddress })).status, 201);
    const encoded = await call(app, 'POST', '/api/v1/guest-request%73', guest(), undefined, { remoteAddress });
    assert.equal(encoded.status, 429, 'encoding a character of the path must not open a fresh bucket');
    assert.equal((db.prepare('SELECT COUNT(*) count FROM guest_requests').get() as { count: number }).count, 20);
  } finally { await app.close(); db.close(); }
});

test('a TOTP code accepted once cannot be replayed for another login', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false });
  try {
    await addAdmin(db, 'admin@example.test', new Date().toISOString());
    const session = (await call(app, 'POST', '/api/v1/auth/login', { email: 'admin@example.test', password })).cookie!;
    const setup = await call(app, 'POST', '/api/v1/auth/2fa/setup', { password }, session);
    const code = totpAt(setup.body.secret);
    assert.equal((await call(app, 'POST', '/api/v1/auth/2fa/enable', { code }, session)).status, 200);
    const replay = await call(app, 'POST', '/api/v1/auth/login', { email: 'admin@example.test', password, code });
    assert.equal(replay.status, 401, 'the code used to enable 2FA must not log in again');
    const next = await call(app, 'POST', '/api/v1/auth/login', { email: 'admin@example.test', password, code: totpAt(setup.body.secret, Date.now() + 30_000) });
    assert.equal(next.status, 200, 'a code from a later step is still accepted');
    const replayNext = await call(app, 'POST', '/api/v1/auth/login', { email: 'admin@example.test', password, code: totpAt(setup.body.secret, Date.now() + 30_000) });
    assert.equal(replayNext.status, 401, 'a login code cannot be replayed either');
  } finally { await app.close(); db.close(); }
});

test('a password reset token is single-use even under concurrent requests', async () => {
  const db = openDatabase(':memory:');
  const sent: string[] = [];
  const app = buildApp({ db, origin, logger: false, sendMail: async (_to, _subject, text) => { sent.push(text); } });
  try {
    assert.equal((await call(app, 'POST', '/api/v1/auth/register', { email: 'reset@example.test', password, name: 'Reset' })).status, 201);
    assert.equal((await call(app, 'POST', '/api/v1/auth/forgot-password', { email: 'reset@example.test' })).status, 202);
    const token = /token=([A-Za-z0-9_-]+)/.exec(sent.join('\n'))?.[1];
    assert.ok(token);
    const results = await Promise.all([
      call(app, 'POST', '/api/v1/auth/reset-password', { token, password: 'FirstNewPass123!' }),
      call(app, 'POST', '/api/v1/auth/reset-password', { token, password: 'SecondNewPass123!' }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 422]);
  } finally { await app.close(); db.close(); }
});

test('the admin overview does not run a full quick_check on every call', async () => {
  const db = openDatabase(':memory:');
  let checks = 0;
  const pragma = db.pragma.bind(db);
  (db as any).pragma = (source: string, options?: unknown) => {
    if (source === 'quick_check') checks++;
    return pragma(source, options as never);
  };
  const app = buildApp({ db, origin, logger: false });
  try {
    await addAdmin(db, 'admin@example.test', new Date().toISOString());
    const admin = (await call(app, 'POST', '/api/v1/auth/login', { email: 'admin@example.test', password })).cookie!;
    for (let i = 0; i < 3; i++) {
      const overview = await call(app, 'GET', '/api/v1/admin/overview', undefined, admin);
      assert.equal(overview.status, 200);
      assert.equal(overview.body.system.ok, true);
    }
    assert.equal(checks, 1);
  } finally { await app.close(); db.close(); }
});

test('the automatic chat greeting is not counted as unread for other admins', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false });
  try {
    await addAdmin(db, 'first-admin@example.test', '2026-01-01T00:00:00.000Z');
    await addAdmin(db, 'second-admin@example.test', '2026-01-02T00:00:00.000Z');
    assert.equal((await call(app, 'POST', '/api/v1/auth/register', { email: 'client@example.test', password, name: 'Client' })).status, 201);
    const customer = (await call(app, 'POST', '/api/v1/auth/login', { email: 'client@example.test', password })).cookie!;
    const created = await call(app, 'POST', '/api/v1/requests', { templateId: 'fashion-01', templateName: 'Fashion 01', contact: { name: 'Client' }, clientSubmissionId: randomUUID() }, customer);
    assert.equal(created.status, 201);
    const secondAdmin = (await call(app, 'POST', '/api/v1/auth/login', { email: 'second-admin@example.test', password })).cookie!;
    assert.equal((await call(app, 'GET', '/api/v1/notifications/unread-count', undefined, secondAdmin)).body.total, 0);
    assert.equal((await call(app, 'GET', '/api/v1/admin/overview', undefined, secondAdmin)).body.messages.unread, 0);
    assert.equal((await call(app, 'POST', `/api/v1/requests/${created.body.id}/messages`, { body: 'Hello', clientMessageId: randomUUID() }, customer)).status, 201);
    assert.equal((await call(app, 'GET', '/api/v1/notifications/unread-count', undefined, secondAdmin)).body.total, 1, 'customer messages are still unread');
    assert.equal((await call(app, 'GET', '/api/v1/admin/overview', undefined, secondAdmin)).body.messages.unread, 1);
  } finally { await app.close(); db.close(); }
});

test('with SELTIVO_TRUST_PROXY=1 a client-supplied X-Forwarded-For prefix cannot rotate rate-limit buckets', async () => {
  const db = openDatabase(':memory:');
  process.env.SELTIVO_TRUST_PROXY = '1';
  let app: App;
  try { app = buildApp({ db, origin, logger: false }); } finally { delete process.env.SELTIVO_TRUST_PROXY; }
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { origin, 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` }, payload: { email: `proxy-${i}@example.test`, password, name: 'Proxy' } });
      statuses.push(response.statusCode);
    }
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
  } finally { await app.close(); db.close(); }
});

test('the Node server refuses mandatory email verification without a mail transport', () => {
  assert.throws(() => requireMailForVerification({ SELTIVO_REQUIRE_EMAIL_VERIFICATION: '1' }, false), /SMTP/);
  assert.doesNotThrow(() => requireMailForVerification({ SELTIVO_REQUIRE_EMAIL_VERIFICATION: '1' }, true));
  assert.doesNotThrow(() => requireMailForVerification({}, false));
});
