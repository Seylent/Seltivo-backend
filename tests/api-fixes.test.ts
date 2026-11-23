import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { hashPassword, hashToken, now, newEmailCode, newAuthToken } from '../src/auth.js';
import { openDatabase } from '../src/db.js';

process.env.NODE_ENV = 'test';
const origin = 'http://localhost:3000';
const password = 'VeryStrongPass123!';

async function setup(options: Record<string, unknown> = {}) {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false, ...options });
  const call = async (method: string, url: string, payload?: unknown, opts: { cookie?: string; remoteAddress?: string; headers?: Record<string, string> } = {}) => {
    const response = await app.inject({
      method: method as 'GET', url, payload,
      headers: { origin, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
      ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}),
    } as never);
    return {
      status: response.statusCode,
      body: response.body ? JSON.parse(response.body) : null,
      headers: response.headers,
      cookie: response.headers['set-cookie'] as string | undefined,
    };
  };
  return { db, app, call };
}

async function customerCookie(call: Awaited<ReturnType<typeof setup>>['call'], email: string) {
  assert.equal((await call('POST', '/api/v1/auth/register', { email, password, name: 'Customer' })).status, 201);
  const login = await call('POST', '/api/v1/auth/login', { email, password });
  assert.equal(login.status, 200);
  return login.cookie!.split(';')[0];
}

const configurationData = { id: 'brand', name: 'Brand', colors: {}, hero: {}, home: {}, products: [] };

async function insertUser(db: ReturnType<typeof openDatabase>, role: 'customer' | 'admin', email: string, options: { createdAt?: string; verified?: boolean; disabled?: boolean } = {}) {
  const userId = randomUUID();
  const timestamp = options.createdAt ?? now();
  db.prepare(`INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at,disabled_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(userId, email, await hashPassword(password), role, 'Test User', options.verified === false ? null : timestamp,
      timestamp, timestamp, options.disabled ? timestamp : null);
  return userId;
}

// 1. Rate-limit eviction must not reset an active lockout.
test('rate-limit map pressure evicts IP keys but preserves an active login lockout and serves new users', async () => {
  const { db, app, call } = await setup();
  const email = 'victim@example.test';
  const victimIp = '198.51.100.1';
  try {
    assert.equal((await call('POST', '/api/v1/auth/register', { email, password, name: 'Victim' })).status, 201);
    for (let attempt = 0; attempt < 10; attempt++) {
      assert.equal((await call('POST', '/api/v1/auth/login', { email, password: 'wrong-password' }, { remoteAddress: victimIp })).status, 401);
    }
    assert.equal((await call('POST', '/api/v1/auth/login', { email, password: 'wrong-password' }, { remoteAddress: victimIp })).status, 429);

    let capacityRejections = 0;
    for (let request = 0; request < 10005; request++) {
      const response = await call('GET', '/api/v1/health', undefined, { remoteAddress: `198.51.${Math.floor(request / 250)}.${request % 251}` });
      if (response.status === 429) capacityRejections++;
    }
    assert.equal(capacityRejections, 0, 'new IP keys are accepted by evicting old IP keys — no global DoS');
    const afterPressure = await call('POST', '/api/v1/auth/login', { email, password: 'wrong-password' }, { remoteAddress: victimIp });
    assert.equal(afterPressure.status, 429, 'the victim lockout survives map pressure');
    assert.ok(Number(afterPressure.headers['retry-after']) > 0);
  } finally { await app.close(); db.close(); }
});

// 2. Verification-code comparison uses a length-guarded constant-time primitive.
test('verification token hashes are compared with a length-guarded constant-time primitive', async () => {
  const { tokenHashesEqual } = await import('../src/app.js');
  const expected = hashToken('user-id:123456');
  assert.equal(tokenHashesEqual(expected, expected), true);
  assert.equal(tokenHashesEqual(expected, hashToken('user-id:000000')), false);
  assert.equal(tokenHashesEqual(expected, 'short'), false, 'short stored hashes are rejected, not thrown');
  assert.equal(tokenHashesEqual(expected, 'z'.repeat(64)), false, 'non-hex stored hashes are rejected, not thrown');
});

test('a valid email code still verifies the account', async () => {
  const { db, app, call } = await setup();
  const email = 'verify-valid@example.test';
  try {
    const userId = await insertUser(db, 'customer', email, { verified: false });
    const code = newEmailCode(db, userId);
    assert.equal((await call('POST', '/api/v1/auth/verify-email', { email, code })).status, 200);
    const row = db.prepare('SELECT email_verified_at FROM users WHERE id=?').get(userId) as { email_verified_at: string | null };
    assert.ok(row.email_verified_at);
  } finally { await app.close(); db.close(); }
});

test('a wrong email code returns 422, increments attempts and eventually locks verification', async () => {
  const { db, app, call } = await setup();
  const email = 'verify-attempts@example.test';
  try {
    const userId = await insertUser(db, 'customer', email, { verified: false });
    const code = newEmailCode(db, userId);
    const wrong = code === '000000' ? '000001' : '000000';
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await call('POST', '/api/v1/auth/verify-email', { email, code: wrong })).status, 422);
    }
    const token = db.prepare("SELECT attempts FROM auth_tokens WHERE user_id=? AND purpose='verify'").get(userId) as { attempts: number };
    assert.equal(token.attempts, 5);
    assert.equal((await call('POST', '/api/v1/auth/verify-email', { email, code })).status, 429);
  } finally { await app.close(); db.close(); }
});

// 3. The token variant of verify-email is customer-only and rejects disabled users.
test('a verification token belonging to an admin cannot verify an email', async () => {
  const { db, app, call } = await setup();
  try {
    const adminId = await insertUser(db, 'admin', 'admin-token@example.test', { verified: false });
    const token = newAuthToken(db, adminId, 'verify', 60_000);
    assert.equal((await call('POST', '/api/v1/auth/verify-email', { token })).status, 422);
    const row = db.prepare('SELECT email_verified_at FROM users WHERE id=?').get(adminId) as { email_verified_at: string | null };
    assert.equal(row.email_verified_at, null);
  } finally { await app.close(); db.close(); }
});

test('a verification token belonging to a disabled customer cannot verify an email', async () => {
  const { db, app, call } = await setup();
  try {
    const userId = await insertUser(db, 'customer', 'disabled-token@example.test', { verified: false, disabled: true });
    const token = newAuthToken(db, userId, 'verify', 60_000);
    assert.equal((await call('POST', '/api/v1/auth/verify-email', { token })).status, 422);
    const row = db.prepare('SELECT email_verified_at FROM users WHERE id=?').get(userId) as { email_verified_at: string | null };
    assert.equal(row.email_verified_at, null);
  } finally { await app.close(); db.close(); }
});

test('a verification token for an active customer still verifies the email', async () => {
  const { db, app, call } = await setup();
  try {
    const userId = await insertUser(db, 'customer', 'active-token@example.test', { verified: false });
    const token = newAuthToken(db, userId, 'verify', 60_000);
    assert.equal((await call('POST', '/api/v1/auth/verify-email', { token })).status, 200);
    const row = db.prepare('SELECT email_verified_at FROM users WHERE id=?').get(userId) as { email_verified_at: string | null };
    assert.ok(row.email_verified_at);
  } finally { await app.close(); db.close(); }
});

// 4. A missing/foreign configuration is 404; only revision conflicts stay 409.
test('patching a configuration owned by another customer returns 404', async () => {
  const { db, app, call } = await setup();
  try {
    const owner = await customerCookie(call, 'owner-config@example.test');
    const other = await customerCookie(call, 'other-config@example.test');
    const created = await call('POST', '/api/v1/configurations', { templateId: 'fashion-01', name: 'Brand', data: configurationData }, { cookie: owner });
    assert.equal(created.status, 201);
    const body = { name: 'Renamed', data: configurationData };
    assert.equal((await call('PATCH', `/api/v1/configurations/${created.body.id}`, body, { cookie: other, headers: { 'if-match': '1' } })).status, 404);
    assert.equal((await call('PATCH', `/api/v1/configurations/${randomUUID()}`, body, { cookie: owner, headers: { 'if-match': '1' } })).status, 404);
  } finally { await app.close(); db.close(); }
});

test('patching a configuration with a stale If-Match revision returns 409', async () => {
  const { db, app, call } = await setup();
  try {
    const owner = await customerCookie(call, 'revision-config@example.test');
    const created = await call('POST', '/api/v1/configurations', { templateId: 'fashion-01', name: 'Brand', data: configurationData }, { cookie: owner });
    assert.equal(created.status, 201);
    const body = { name: 'Renamed', data: configurationData };
    assert.equal((await call('PATCH', `/api/v1/configurations/${created.body.id}`, body, { cookie: owner, headers: { 'if-match': '7' } })).status, 409);
    assert.equal((await call('PATCH', `/api/v1/configurations/${created.body.id}`, body, { cookie: owner, headers: { 'if-match': '1' } })).status, 200);
    assert.equal((await call('PATCH', `/api/v1/configurations/${created.body.id}`, body, { cookie: owner, headers: { 'if-match': '1' } })).status, 409);
  } finally { await app.close(); db.close(); }
});

// 5. The auto-reply idempotency key must be scoped to the conversation, not the sender.
test('disabling the first admin does not insert a second chat auto-reply', async () => {
  const { db, app, call } = await setup();
  const greeting = 'Привіт, менеджер скоро відповість вам';
  try {
    const firstAdmin = await insertUser(db, 'admin', 'autoreply-first@example.test', { createdAt: '2020-01-01T00:00:00.000Z' });
    await insertUser(db, 'admin', 'autoreply-second@example.test', { createdAt: '2020-01-02T00:00:00.000Z' });
    const customer = await customerCookie(call, 'autoreply-customer@example.test');
    const config = await call('POST', '/api/v1/configurations', { templateId: 'fashion-01', name: 'Brand', data: configurationData }, { cookie: customer });
    assert.equal(config.status, 201);
    const submitted = await call('POST', '/api/v1/requests', {
      templateId: 'fashion-01', templateName: 'Fashion 01', configurationId: config.body.id,
      contact: { name: 'Customer' }, note: '', features: [], clientSubmissionId: randomUUID(),
    }, { cookie: customer });
    assert.equal(submitted.status, 201);
    const url = `/api/v1/requests/${submitted.body.id}/messages`;
    const initial = (await call('GET', url, undefined, { cookie: customer })).body.items as Array<{ body: string; senderId: string }>;
    assert.deepEqual(initial.map((message) => message.body), [greeting]);
    assert.equal(initial[0].senderId, firstAdmin);

    db.prepare('UPDATE users SET disabled_at=? WHERE id=?').run(now(), firstAdmin);
    assert.equal((await call('POST', url, { body: 'First question', clientMessageId: randomUUID() }, { cookie: customer })).status, 201);
    assert.equal((await call('POST', url, { body: 'Second question', clientMessageId: randomUUID() }, { cookie: customer })).status, 201);
    const items = (await call('GET', url, undefined, { cookie: customer })).body.items as Array<{ body: string; senderId: string }>;
    const greetings = items.filter((message) => message.body === greeting);
    assert.equal(greetings.length, 1, 'exactly one auto-reply survives an admin change');
    assert.equal(greetings[0].senderId, firstAdmin);
  } finally { await app.close(); db.close(); }
});

// 6. An id replay may only move telegram_status from failed to sent.
/** Deterministic unique IP per index, so per-IP rate buckets never interfere with a flood. */
function floodIp(index: number): string {
  return `10.${Math.floor(index / 65536) % 256}.${Math.floor(index / 256) % 256}.${index % 256}`;
}

function guestBrief(telegramStatus: 'sent' | 'failed') {
  return { id: randomUUID(), name: 'Guest', contact: '@guest', features: ['Catalog'], budget: '', note: 'Need a site', telegramStatus };
}

test('a replay never rewrites telegram_status after it is already sent', async () => {
  const { db, app, call } = await setup();
  db.exec('CREATE TABLE telegram_updates(old_status TEXT,new_status TEXT)');
  db.exec(`CREATE TRIGGER telegram_changed AFTER UPDATE OF telegram_status ON guest_requests
    BEGIN INSERT INTO telegram_updates(old_status,new_status) VALUES(OLD.telegram_status,NEW.telegram_status); END`);
  try {
    const brief = guestBrief('sent');
    assert.equal((await call('POST', '/api/v1/guest-requests', brief)).status, 201);
    assert.equal((await call('POST', '/api/v1/guest-requests', brief)).status, 200);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM telegram_updates').get() as { count: number }).count, 0);
  } finally { await app.close(); db.close(); }
});

test('a replay with failed does not downgrade a sent guest request', async () => {
  const { db, app, call } = await setup();
  try {
    const brief = guestBrief('sent');
    assert.equal((await call('POST', '/api/v1/guest-requests', brief)).status, 201);
    assert.equal((await call('POST', '/api/v1/guest-requests', { ...brief, telegramStatus: 'failed' })).status, 200);
    const row = db.prepare('SELECT telegram_status FROM guest_requests WHERE id=?').get(brief.id) as { telegram_status: string };
    assert.equal(row.telegram_status, 'sent');
  } finally { await app.close(); db.close(); }
});

test('a replay with sent moves a failed guest request to sent without changing other fields', async () => {
  const { db, app, call } = await setup();
  try {
    const brief = guestBrief('failed');
    const created = await call('POST', '/api/v1/guest-requests', brief);
    assert.equal(created.status, 201);
    assert.equal((await call('POST', '/api/v1/guest-requests', { ...brief, telegramStatus: 'sent' })).status, 200);
    const row = db.prepare('SELECT name,contact,note,features_json,status,telegram_status FROM guest_requests WHERE id=?')
      .get(brief.id) as { name: string; contact: string; note: string; features_json: string; status: string; telegram_status: string };
    assert.equal(row.telegram_status, 'sent');
    assert.equal(row.name, brief.name);
    assert.equal(row.contact, brief.contact);
    assert.equal(row.note, brief.note);
    assert.equal(row.features_json, JSON.stringify(brief.features));
    assert.equal(row.status, 'new');
  } finally { await app.close(); db.close(); }
});

// Regression 1: email-key flood must not turn the shared key space into a global 429.
test('an email-key flood cannot cause capacity-based 429 for health, new users or other lockouts', async () => {
  const { db, app, call } = await setup();
  const victimIp = '192.0.2.10';
  try {
    // Establish a victim lockout before the flood — it must survive map pressure.
    assert.equal((await call('POST', '/api/v1/auth/register', { email: 'flood-victim@example.test', password, name: 'Victim' })).status, 201);
    for (let attempt = 0; attempt < 10; attempt++) {
      assert.equal((await call('POST', '/api/v1/auth/login', { email: 'flood-victim@example.test', password: 'wrong-password' }, { remoteAddress: victimIp })).status, 401);
    }
    assert.equal((await call('POST', '/api/v1/auth/login', { email: 'flood-victim@example.test', password: 'wrong-password' }, { remoteAddress: victimIp })).status, 429);

    // Fill the sensitive key space beyond its 10k cap with unique email keys.
    // Unique IPs bypass the per-IP bucket; sendMail is undefined so no mail is sent.
    for (let i = 0; i < 10_050; i++) {
      const response = await call('POST', '/api/v1/auth/forgot-password', { email: `flood-${i}@example.test` }, { remoteAddress: floodIp(i) });
      assert.equal(response.status, 202, `forgot-password ${i} must still be allowed`);
    }

    // A brand-new IP health request is served — no global capacity 429.
    assert.equal((await call('GET', '/api/v1/health', undefined, { remoteAddress: '203.0.113.99' })).status, 200);

    // A genuinely new user can still register and log in after the flood.
    assert.equal((await call('POST', '/api/v1/auth/register', { email: 'flood-new@example.test', password, name: 'New' }, { remoteAddress: '203.0.113.97' })).status, 201);
    assert.equal((await call('POST', '/api/v1/auth/login', { email: 'flood-new@example.test', password }, { remoteAddress: '203.0.113.98' })).status, 200);

    // The pre-existing victim lockout is preserved, not evicted by the flood.
    const locked = await call('POST', '/api/v1/auth/login', { email: 'flood-victim@example.test', password: 'wrong-password' }, { remoteAddress: victimIp });
    assert.equal(locked.status, 429, 'existing victim lockout survives an email-key flood');
    assert.ok(Number(locked.headers['retry-after']) > 0);
  } finally { await app.close(); db.close(); }
});

// Regression 2: a 1-hour export quota must not be reset by 15-minute staleness pruning.
test('a 1-hour export quota survives 20 minutes plus map-pressure staleness pruning', async () => {
  const { db, app, call } = await setup();
  const realNow = Date.now;
  try {
    const cookie = await customerCookie(call, 'export-quota@example.test');
    for (let request = 0; request < 3; request++) {
      assert.equal((await call('GET', '/api/v1/me/export', undefined, { cookie })).status, 200);
    }
    assert.equal((await call('GET', '/api/v1/me/export', undefined, { cookie })).status, 429, '4th export within the hour is blocked');

    // Jump 20 minutes into the future: still well inside the 1-hour export window.
    Date.now = () => realNow() + 20 * 60_000;
    try {
      // Pressure the sensitive key space with 15-minute email keys. A hardcoded
      // 15-minute staleness rule would drop the still-live export key here.
      for (let i = 0; i < 10_050; i++) {
        assert.equal((await call('POST', '/api/v1/auth/forgot-password', { email: `export-flood-${i}@example.test` }, { remoteAddress: floodIp(i) })).status, 202);
      }
      assert.equal((await call('GET', '/api/v1/me/export', undefined, { cookie })).status, 429, 'export quota is still exhausted after 20 minutes');
    } finally {
      Date.now = realNow;
    }
  } finally { await app.close(); db.close(); }
});
