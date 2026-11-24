import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.SELTIVO_SMOKE_URL ?? 'http://127.0.0.1:8787';
const origin = process.env.SELTIVO_SMOKE_ORIGIN ?? 'https://seltivostudio.com';
const password = `Smoke-${randomUUID()}!`;

function isLocalTarget(url) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return false; }
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}
if (!isLocalTarget(base) && !process.env.SELTIVO_SMOKE_ORIGIN) {
  throw new Error('SELTIVO_SMOKE_ORIGIN must be set explicitly when SELTIVO_SMOKE_URL points to a non-local Worker; the default Origin would be rejected with 403.');
}

async function call(method, path, body, cookie, extraHeaders = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: {
    Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders,
  }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: response.status === 204 ? null : await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function customer(label) {
  const email = `smoke-${label}-${randomUUID()}@example.test`;
  assert.equal((await call('POST', '/api/v1/auth/register', { email, password, name: label })).status, 201);
  const login = await call('POST', '/api/v1/auth/login', { email, password });
  assert.equal(login.status, 200);
  return login.cookie;
}

// Залежно від наявності активного адміна, при створенні заявки може з'явитися
// автовітальне повідомлення. Перевіряємо ідемпотентність за текстом самого
// повідомлення, а не за загальною кількістю рядків у діалозі.
async function countMessages(cookie, requestId, body) {
  const list = await call('GET', `/api/v1/requests/${requestId}/messages`, undefined, cookie);
  assert.equal(list.status, 200);
  return list.body.items.filter((item) => item.body === body).length;
}

const alice = await customer('Alice');
const bob = await customer('Bob');
const requestBody = { templateId: 'fashion-01', templateName: 'Fashion 01', contact: { name: 'Alice' }, clientSubmissionId: randomUUID() };
const first = await call('POST', '/api/v1/requests', requestBody, alice);
assert.equal(first.status, 201);
assert.equal((await call('POST', '/api/v1/requests', requestBody, alice)).body.id, first.body.id);
assert.equal((await call('GET', `/api/v1/requests/${first.body.id}`, undefined, bob)).status, 404);
const message = { body: 'Cloudflare runtime check', clientMessageId: randomUUID() };
assert.equal((await call('POST', `/api/v1/requests/${first.body.id}/messages`, message, alice)).status, 201);
assert.equal((await call('POST', `/api/v1/requests/${first.body.id}/messages`, message, alice)).status, 200);
assert.equal(await countMessages(alice, first.body.id, message.body), 1);
// Admin checks mutate state (email retry, status patch) and need an explicit opt-in,
// not just credentials supplied "by the way".
const adminAllowed = process.env.SELTIVO_SMOKE_ALLOW_ADMIN === '1';
if (!adminAllowed && (process.env.SELTIVO_SMOKE_ADMIN_EMAIL || process.env.SELTIVO_SMOKE_ADMIN_PASSWORD)) {
  throw new Error('Admin credentials supplied without SELTIVO_SMOKE_ALLOW_ADMIN=1. Set SELTIVO_SMOKE_ALLOW_ADMIN=1 explicitly to run the mutating admin checks (email retry / status patch), or unset the credentials.');
}
if (adminAllowed && process.env.SELTIVO_SMOKE_ADMIN_EMAIL && process.env.SELTIVO_SMOKE_ADMIN_PASSWORD) {
  const login = await call('POST', '/api/v1/auth/login', { email: process.env.SELTIVO_SMOKE_ADMIN_EMAIL, password: process.env.SELTIVO_SMOKE_ADMIN_PASSWORD });
  assert.equal(login.status, 200);
  const admin = login.cookie;
  assert.equal((await call('GET', '/api/v1/admin/diagnostics', undefined, admin)).body.ok, true);
  const outstanding = await call('GET', '/api/v1/admin/email-notifications', undefined, admin);
  assert.equal(outstanding.status, 200);
  const notification = outstanding.body.items.find((item) => item.requestId === first.body.id);
  assert.ok(notification);
  assert.equal((await call('POST', `/api/v1/admin/email-notifications/${notification.id}/retry`, {}, admin)).body.status, 'failed');
  assert.equal(await countMessages(alice, first.body.id, message.body), 1);
  const reply = await call('POST', `/api/v1/requests/${first.body.id}/messages`, { body: 'Admin reply', clientMessageId: randomUUID() }, admin);
  assert.equal(reply.status, 201);
  assert.equal(await countMessages(alice, first.body.id, 'Admin reply'), 1);
  const statusPath = `/api/v1/admin/requests/${first.body.id}/status`;
  assert.equal((await call('PATCH', statusPath, { status: 'reviewing' }, admin, { 'If-Match': '1' })).status, 200);
  assert.equal((await call('PATCH', statusPath, { status: 'needs_info' }, admin, { 'If-Match': '1' })).status, 409);
}
console.log('Cloudflare runtime smoke passed: registration, ownership, request and message retries.');
