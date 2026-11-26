import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { hashPassword, newAuthToken, newEmailCode, now } from '../src/auth.js';
import { openDatabase } from '../src/db.js';
import { totpAt } from '../src/two-factor.js';
import { createWorkerRouter } from '../cloudflare/worker-router.js';

process.env.NODE_ENV = 'test';
const origin = 'https://seltivo.example';
const password = 'VeryStrongPass123!';
type App = ReturnType<typeof buildApp>;
type Db = ReturnType<typeof openDatabase>;

const call = async (app: App, method: string, url: string, payload?: unknown, cookie?: string) => {
  // The Worker test router expects a Buffer; Fastify accepts the same payload form.
  const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
  const response: any = await app.inject({ method, url, headers: { origin, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, payload: body } as any);
  return { status: response.statusCode as number, body: response.body ? JSON.parse(response.body) : null, cookie: response.headers['set-cookie'] as string | undefined };
};

async function addUser(db: Db, app: App, email: string, role: 'customer' | 'admin', verified = true) {
  const userId = randomUUID();
  const timestamp = now();
  db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(userId, email, await hashPassword(password), role, 'Test', verified ? timestamp : null, timestamp, timestamp);
  const login = await call(app, 'POST', '/api/v1/auth/login', { email, password });
  assert.equal(login.status, 200, 'login must succeed in the fixture');
  return { id: userId, email, cookie: String(login.cookie).split(';')[0] };
}

// --- P0-1: a URL/code/resend verification for account A must not take over a browser signed in as V ---

test('verification of another principal never replaces the current session', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false, requireEmailVerification: true });
  try {
    const victim = await addUser(db, app, 'victim@example.test', 'customer');
    const timestamp = now();
    // auth_tokens are replaced per (user, purpose), so use two accounts to keep a token and a code alive.
    const tokenAttackerId = randomUUID();
    db.prepare("INSERT INTO users(id,email,password_hash,role,name,created_at,updated_at) VALUES (?,?,?,'customer','Token attacker',?,?)")
      .run(tokenAttackerId, 'token-attacker@example.test', await hashPassword(password), timestamp, timestamp);
    const token = newAuthToken(db, tokenAttackerId, 'verify', 60_000);
    const codeAttackerId = randomUUID();
    db.prepare("INSERT INTO users(id,email,password_hash,role,name,created_at,updated_at) VALUES (?,?,?,'customer','Code attacker',?,?)")
      .run(codeAttackerId, 'code-attacker@example.test', await hashPassword(password), timestamp, timestamp);
    const code = newEmailCode(db, codeAttackerId);

    const byToken = await call(app, 'POST', '/api/v1/auth/verify-email', { token }, victim.cookie);
    assert.equal(byToken.status, 403);
    assert.equal(byToken.cookie, undefined);
    const byCode = await call(app, 'POST', '/api/v1/auth/verify-email', { email: 'code-attacker@example.test', code }, victim.cookie);
    assert.equal(byCode.status, 403);
    assert.equal(byCode.cookie, undefined);
    const resend = await call(app, 'POST', '/api/v1/auth/resend-verification', { email: 'code-attacker@example.test' }, victim.cookie);
    assert.equal(resend.status, 403);

    // The victim stays signed in as themselves and the attacker's account stays unverified.
    const me = await call(app, 'GET', '/api/v1/me', undefined, victim.cookie);
    assert.equal(me.status, 200);
    assert.equal(me.body.id, victim.id);
    const attacker = db.prepare('SELECT email_verified_at FROM users WHERE id=?').get(tokenAttackerId) as { email_verified_at: string | null };
    assert.equal(attacker.email_verified_at, null);

    // The legitimate, unauthenticated verification flow still issues a customer session.
    const anonymous = await call(app, 'POST', '/api/v1/auth/verify-email', { token });
    assert.equal(anonymous.status, 200);
    assert.match(anonymous.cookie ?? '', /^seltivo_session=/);
    const signedIn = await call(app, 'GET', '/api/v1/me', undefined, String(anonymous.cookie).split(';')[0]);
    assert.equal(signedIn.body.id, tokenAttackerId);

    // A signed-in user may still resend to their own address.
    assert.equal((await call(app, 'POST', '/api/v1/auth/resend-verification', { email: victim.email }, victim.cookie)).status, 202);
  } finally { await app.close(); db.close(); }
});

// --- P0-2: enabling 2FA must retire sessions minted before the second factor existed ---

test('enabling and disabling 2FA revokes sessions created without the second factor', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false });
  try {
    const admin = await addUser(db, app, 'admin@example.test', 'admin');
    assert.equal((await call(app, 'GET', '/api/v1/auth/2fa/status', undefined, admin.cookie)).body.enabled, false);

    const setup = await call(app, 'POST', '/api/v1/auth/2fa/setup', { password }, admin.cookie);
    assert.equal(setup.status, 200);
    const secret = setup.body.secret as string;
    const recoveryCodes = setup.body.recoveryCodes as string[];
    const enabled = await call(app, 'POST', '/api/v1/auth/2fa/enable', { code: totpAt(secret) }, admin.cookie);
    assert.equal(enabled.status, 200);

    // The pre-enrollment session must no longer be an admin session.
    assert.equal((await call(app, 'GET', '/api/v1/admin/overview', undefined, admin.cookie)).status, 401);
    assert.equal((await call(app, 'GET', '/api/v1/me', undefined, admin.cookie)).status, 401);

    assert.equal((await call(app, 'POST', '/api/v1/auth/login', { email: admin.email, password })).status, 428);
    const secondFactorLogin = await call(app, 'POST', '/api/v1/auth/login', { email: admin.email, password, code: totpAt(secret, Date.now() + 30_000) });
    assert.equal(secondFactorLogin.status, 200);
    const assuredCookie = String(secondFactorLogin.cookie).split(';')[0];
    const me = await call(app, 'GET', '/api/v1/me', undefined, assuredCookie);
    assert.equal(me.body.twoFactorVerified, true);
    assert.equal(me.body.assurance, 'mfa');
    assert.equal((await call(app, 'GET', '/api/v1/admin/overview', undefined, assuredCookie)).status, 200);

    // Step-down also revokes sessions: after disabling 2FA the old second-factor session is gone.
    assert.equal((await call(app, 'POST', '/api/v1/auth/2fa/disable', { password, code: recoveryCodes[0] }, assuredCookie)).status, 200);
    assert.equal((await call(app, 'GET', '/api/v1/admin/overview', undefined, assuredCookie)).status, 401);
  } finally { await app.close(); db.close(); }
});

test('customers never get admin assurance and non-admins cannot manage 2FA', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false });
  try {
    const customer = await addUser(db, app, 'customer@example.test', 'customer');
    const me = await call(app, 'GET', '/api/v1/me', undefined, customer.cookie);
    assert.equal(me.body.twoFactorVerified, undefined);
    assert.equal(me.body.assurance, undefined);
    for (const path of ['/api/v1/auth/2fa/setup', '/api/v1/auth/2fa/enable', '/api/v1/auth/2fa/disable']) {
      assert.equal((await call(app, 'POST', path, { password }, customer.cookie)).status, 403);
      assert.equal((await call(app, 'POST', path, { password })).status, 401);
    }
    assert.equal((await call(app, 'GET', '/api/v1/auth/2fa/status', undefined, customer.cookie)).status, 403);
  } finally { await app.close(); db.close(); }
});

// --- P1-3: idempotency keys are scoped to the authenticated buyer ---

test('a clientSubmissionId from another buyer cannot reuse or block a request', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false });
  try {
    const alice = await addUser(db, app, 'alice@example.test', 'customer');
    const bob = await addUser(db, app, 'bob@example.test', 'customer');
    const submissionId = randomUUID();
    const body = { templateId: 'fashion-01', templateName: 'Fashion 01', contact: { name: 'Shared' }, note: '', features: [], clientSubmissionId: submissionId };
    const first = await call(app, 'POST', '/api/v1/requests', body, alice.cookie);
    const second = await call(app, 'POST', '/api/v1/requests', body, bob.cookie);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.body.id, second.body.id, 'each buyer owns their own record even with the same key');
    assert.equal((await call(app, 'POST', '/api/v1/requests', body, alice.cookie)).body.id, first.body.id);
    assert.equal((await call(app, 'POST', '/api/v1/requests', body, bob.cookie)).body.id, second.body.id);
    const rows = db.prepare('SELECT customer_id owner,COUNT(*) count FROM requests GROUP BY customer_id').all() as Array<{ owner: string; count: number }>;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.count).sort(), [1, 1]);
    assert.ok(rows.some((row) => row.owner === alice.id) && rows.some((row) => row.owner === bob.id));

    const messageId = randomUUID();
    const firstMessage = await call(app, 'POST', `/api/v1/requests/${first.body.id}/messages`, { body: 'Alice', clientMessageId: messageId }, alice.cookie);
    const secondMessage = await call(app, 'POST', `/api/v1/requests/${second.body.id}/messages`, { body: 'Bob', clientMessageId: messageId }, bob.cookie);
    assert.equal(firstMessage.status, 201);
    assert.equal(secondMessage.status, 201);
    assert.notEqual(firstMessage.body.id, secondMessage.body.id, 'message keys are scoped per sender');
  } finally { await app.close(); db.close(); }
});

// --- P1-4: obfuscated paths must not bypass the backend's own admin authorization ---

test('obfuscated admin paths are rejected by the backend router even behind the Next proxy', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false, router: createWorkerRouter() });
  try {
    const admin = await addUser(db, app, 'admin@example.test', 'admin');
    const customer = await addUser(db, app, 'customer@example.test', 'customer');
    assert.equal((await call(app, 'GET', '/api/v1/admin/requests', undefined, admin.cookie)).status, 200);
    for (const path of [
      '/api/v1/x/../admin/requests',
      '/api/v1/admin;x/requests',
      '/api/v1/admin%00/requests',
      '//api/v1/admin/requests',
    ]) {
      const response = await call(app, 'GET', path, undefined, customer.cookie);
      assert.ok([401, 403, 404].includes(response.status), `${path} must not return admin data (got ${response.status})`);
      assert.ok(!response.body?.items, `${path} must not leak admin items`);
    }
  } finally { db.close(); }
});

test('a saved configuration cannot be read by another customer', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false });
  try {
    const owner = await addUser(db, app, 'owner@example.test', 'customer');
    const other = await addUser(db, app, 'other@example.test', 'customer');
    const created = await call(app, 'POST', '/api/v1/configurations', { templateId: 'fashion-01', name: 'Private', data: { id: 'brand', name: 'Brand', colors: {}, hero: {}, home: {}, products: [] } }, owner.cookie);
    assert.equal(created.status, 201);
    assert.equal((await call(app, 'GET', `/api/v1/configurations/${created.body.id}`, undefined, other.cookie)).status, 404);
    assert.equal((await call(app, 'GET', `/api/v1/configurations/${created.body.id}`, undefined, owner.cookie)).status, 200);
  } finally { await app.close(); db.close(); }
});

// The backend runs in one Durable Object, so its limits are authoritative even when
// the Next front-end silently falls back to per-isolate buckets.
test('guest requests are limited by the backend independently of any front-end bucket', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false });
  try {
    const brief = () => ({ id: randomUUID(), name: 'Guest', contact: '@guest', features: ['shop'], budget: '', note: '', telegramStatus: 'sent' as const });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      statuses.push((await call(app, 'POST', '/api/v1/guest-requests', brief())).status);
    }
    assert.deepEqual(statuses, [...Array(20).fill(201), 429]);
  } finally { await app.close(); db.close(); }
});

// --- P1-5: change-password needs per-account throttling in addition to the shared per-IP limit ---

test('change-password is throttled per account after repeated wrong passwords', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false });
  try {
    const customer = await addUser(db, app, 'change@example.test', 'customer');
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await call(app, 'POST', '/api/v1/auth/change-password', { currentPassword: 'wrong', newPassword: 'AnotherPass123!' }, customer.cookie)).status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
    assert.equal((await call(app, 'GET', '/api/v1/me', undefined, customer.cookie)).status, 200, 'failed attempts must not revoke the session');
  } finally { await app.close(); db.close(); }
});
