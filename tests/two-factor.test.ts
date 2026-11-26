import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { hashPassword, now } from '../src/auth.js';
import { openDatabase } from '../src/db.js';
import { generateRecoveryCodes, normalizeRecoveryCode, totpAt, verifyTotp } from '../src/two-factor.js';

process.env.NODE_ENV = 'test';
const origin = 'https://seltivo.example';
const password = 'VeryStrongPass123!';

const call = async (app: ReturnType<typeof buildApp>, method: string, url: string, payload?: unknown, cookie?: string) => {
  const response: any = await app.inject({ method, url, headers: { origin, ...(cookie ? { cookie } : {}) }, payload } as any);
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null, cookie: response.headers['set-cookie'] as string | undefined };
};

async function addAdmin(db: ReturnType<typeof openDatabase>, app: ReturnType<typeof buildApp>, email: string) {
  const timestamp = now();
  db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin',?,?,?)")
    .run(randomUUID(), email, await hashPassword(password), timestamp, timestamp, timestamp);
  const login = await call(app, 'POST', '/api/v1/auth/login', { email, password });
  assert.equal(login.status, 200);
  return { email, cookie: login.cookie!.split(';')[0] };
}

async function enroll(app: ReturnType<typeof buildApp>, cookie: string) {
  const setup = await call(app, 'POST', '/api/v1/auth/2fa/setup', { password }, cookie);
  assert.equal(setup.status, 200);
  const enable = await call(app, 'POST', '/api/v1/auth/2fa/enable', { code: totpAt(setup.body.secret) }, cookie);
  assert.equal(enable.status, 200);
  return setup.body as { secret: string; uri: string; recoveryCodes: string[] };
}

test('TOTP follows RFC 6238 vectors and tolerates one step of clock drift', () => {
  // RFC 6238 secret "12345678901234567890" (Base32), 8-digit vectors truncated to 6 digits.
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totpAt(secret, 59_000), '287082');
  assert.equal(totpAt(secret, 1_111_111_109_000), '081804');
  assert.equal(totpAt(secret, 1_234_567_890_000), '005924');
  assert.equal(verifyTotp('287082', secret, 59_000), true);
  assert.equal(verifyTotp('287082', secret, 89_000), true); // +30 с
  assert.equal(verifyTotp('287082', secret, 149_000), false); // +90 с
  assert.equal(verifyTotp('abcdef', secret, 59_000), false);
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 8);
  assert.match(codes[0], /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
  assert.equal(normalizeRecoveryCode(codes[0]).includes('-'), false);
});

test('admin enrolls in 2FA, login requires a code, and the session is capped at 12 hours', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, secureCookies: true, logger: false });
  try {
    const admin = await addAdmin(db, app, 'admin@example.test');
    const statusBefore = await call(app, 'GET', '/api/v1/auth/2fa/status', undefined, admin.cookie);
    assert.deepEqual(statusBefore.body, { enabled: false, pending: false, recoveryCodesRemaining: 0 });

    const setup = await call(app, 'POST', '/api/v1/auth/2fa/setup', { password: 'wrong' }, admin.cookie);
    assert.equal(setup.status, 401);
    assert.equal((await call(app, 'POST', '/api/v1/auth/2fa/enable', { code: '000000' }, admin.cookie)).status, 409);

    const enrolled = await enroll(app, admin.cookie);
    assert.match(enrolled.uri, /^otpauth:\/\/totp\/SELTIVO%3Aadmin%40example\.test/);
    // The pre-enrollment session is retired; the next one must carry a second factor.
    assert.equal((await call(app, 'GET', '/api/v1/auth/2fa/status', undefined, admin.cookie)).status, 401);
    const fresh = await call(app, 'POST', '/api/v1/auth/login', { email: admin.email, password, code: enrolled.recoveryCodes[0] });
    assert.equal(fresh.status, 200);
    const freshCookie = fresh.cookie!.split(';')[0];
    const statusAfter = await call(app, 'GET', '/api/v1/auth/2fa/status', undefined, freshCookie);
    assert.equal(statusAfter.body.enabled, true);
    assert.equal(statusAfter.body.recoveryCodesRemaining, 7);

    const missing = await call(app, 'POST', '/api/v1/auth/login', { email: admin.email, password });
    assert.equal(missing.status, 428);
    assert.equal(missing.body.twoFactorRequired, true);
    assert.equal(missing.cookie, undefined);

    const wrong = await call(app, 'POST', '/api/v1/auth/login', { email: admin.email, password, code: '000000' });
    assert.equal(wrong.status, 401);
    // Кожен TOTP-код приймається один раз (RFC 6238 §5.2): код увімкнення вже
    // використано, тому вхід бере код наступного 30-секундного кроку.
    const valid = await call(app, 'POST', '/api/v1/auth/login', { email: admin.email, password, code: totpAt(enrolled.secret, Date.now() + 30_000) });
    assert.equal(valid.status, 200);
    const session = db.prepare('SELECT expires_at FROM sessions WHERE user_id=(SELECT id FROM users WHERE email=?)').get(admin.email) as { expires_at: string };
    assert.ok(Date.parse(session.expires_at) - Date.now() <= 12 * 60 * 60 * 1000);

    const remembered = await call(app, 'POST', '/api/v1/auth/login', { email: admin.email, password, rememberMe: true, code: enrolled.recoveryCodes[1] });
    assert.equal(remembered.status, 200);
    assert.match(String(remembered.cookie), /Max-Age=43200/);
    assert.doesNotMatch(String(remembered.cookie), /Max-Age=2592000/);

    const disabled = await call(app, 'POST', '/api/v1/auth/2fa/disable', { password, code: enrolled.recoveryCodes[2] }, freshCookie);
    assert.equal(disabled.status, 200);
    // Disabling is a step-down: even the second-factor session is revoked.
    assert.equal((await call(app, 'GET', '/api/v1/auth/2fa/status', undefined, freshCookie)).status, 401);
    assert.equal((await call(app, 'POST', '/api/v1/auth/login', { email: admin.email, password })).status, 200);
  } finally {
    await app.close();
    db.close();
  }
});

test('concurrent logins cannot mint two sessions from one recovery code', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false });
  try {
    const admin = await addAdmin(db, app, 'admin@example.test');
    const enrolled = await enroll(app, admin.cookie);
    const reauthenticated = await call(app, 'POST', '/api/v1/auth/login', { email: admin.email, password, code: totpAt(enrolled.secret, Date.now() + 30_000) });
    assert.equal(reauthenticated.status, 200);
    const assuredCookie = reauthenticated.cookie!.split(';')[0];
    const recovery = enrolled.recoveryCodes[0];
    const results = await Promise.all([
      call(app, 'POST', '/api/v1/auth/login', { email: admin.email, password, code: recovery }),
      call(app, 'POST', '/api/v1/auth/login', { email: admin.email, password, code: recovery }),
    ]);
    assert.equal(results.filter((result) => result.status === 200).length, 1,
      'a single-use recovery code may create at most one new session');
    assert.equal((await call(app, 'GET', '/api/v1/auth/2fa/status', undefined, assuredCookie)).body.recoveryCodesRemaining, 7);
  } finally {
    await app.close();
    db.close();
  }
});

test('a recovery code works once and 2FA endpoints are admin-only', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false });
  try {
    const admin = await addAdmin(db, app, 'admin@example.test');
    const enrolled = await enroll(app, admin.cookie);
    const recovery = enrolled.recoveryCodes[0];
    const first = await call(app, 'POST', '/api/v1/auth/login', { email: admin.email, password, code: recovery });
    assert.equal(first.status, 200);
    const assuredCookie = first.cookie!.split(';')[0];
    const status = await call(app, 'GET', '/api/v1/auth/2fa/status', undefined, assuredCookie);
    assert.equal(status.body.recoveryCodesRemaining, 7);
    const replay = await call(app, 'POST', '/api/v1/auth/login', { email: admin.email, password, code: recovery });
    assert.equal(replay.status, 401);

    assert.equal((await call(app, 'POST', '/api/v1/auth/register', { email: 'customer@example.test', password, name: 'Customer' })).status, 201);
    const customer = (await call(app, 'POST', '/api/v1/auth/login', { email: 'customer@example.test', password })).cookie!.split(';')[0];
    assert.equal((await call(app, 'GET', '/api/v1/auth/2fa/status', undefined, customer)).status, 403);
    assert.equal((await call(app, 'POST', '/api/v1/auth/2fa/setup', { password }, customer)).status, 403);
    assert.equal((await call(app, 'POST', '/api/v1/auth/2fa/enable', { code: '000000' }, customer)).status, 403);
    assert.equal((await call(app, 'POST', '/api/v1/auth/2fa/disable', { password, code: '000000' }, customer)).status, 403);
  } finally {
    await app.close();
    db.close();
  }
});

test('requireAdmin2FA blocks unenrolled admins without affecting customers', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false, requireAdmin2FA: true });
  try {
    const timestamp = now();
    db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin',?,?,?)")
      .run(randomUUID(), 'admin@example.test', await hashPassword(password), timestamp, timestamp, timestamp);
    const blocked = await call(app, 'POST', '/api/v1/auth/login', { email: 'admin@example.test', password });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.twoFactorEnrollmentRequired, true);
    assert.equal(blocked.cookie, undefined);

    assert.equal((await call(app, 'POST', '/api/v1/auth/register', { email: 'customer@example.test', password, name: 'Customer' })).status, 201);
    const remembered = await call(app, 'POST', '/api/v1/auth/login', { email: 'customer@example.test', password, rememberMe: true });
    assert.equal(remembered.status, 200);
    assert.match(String(remembered.cookie), /Max-Age=2592000/);
  } finally {
    await app.close();
    db.close();
  }
});
