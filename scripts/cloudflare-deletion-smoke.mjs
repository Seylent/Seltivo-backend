import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.SELTIVO_SMOKE_URL ?? 'http://127.0.0.1:8789';
const origin = process.env.SELTIVO_SMOKE_ORIGIN ?? 'https://seltivo-staging.seltivostudio.workers.dev';
const email = `delete-smoke-${randomUUID()}@example.test`;
const password = `Smoke-${randomUUID()}!`;

function isLocalTarget(url) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return false; }
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}
if (!isLocalTarget(base) && !process.env.SELTIVO_SMOKE_ORIGIN) {
  throw new Error('SELTIVO_SMOKE_ORIGIN must be set explicitly when SELTIVO_SMOKE_URL points to a non-local Worker; the default Origin would be rejected with 403.');
}

// This smoke deletes a real account. Refuse the production origin even if it was
// supplied via env or the default was changed — destructive drills are staging-only.
const productionOriginHosts = new Set(['seltivostudio.com', 'www.seltivostudio.com']);
let resolvedOriginHost = '';
try { resolvedOriginHost = new URL(origin).hostname.toLowerCase(); } catch { /* invalid origin fails at request time */ }
if (productionOriginHosts.has(resolvedOriginHost)) {
  throw new Error('Destructive deletion smoke is staging-only: refusing to run with the production origin https://seltivostudio.com. Use a staging Worker and SELTIVO_SMOKE_ORIGIN=https://seltivo-staging.seltivostudio.workers.dev.');
}

async function call(method, path, body, cookie) {
  const response = await fetch(`${base}${path}`, { method, headers: {
    Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: response.status === 204 ? null : await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

assert.equal((await call('POST', '/api/v1/auth/register', { email, password, name: 'Deletion Smoke' })).status, 201);
const login = await call('POST', '/api/v1/auth/login', { email, password });
assert.equal(login.status, 200);
const cookie = login.cookie;
const me = await call('GET', '/api/v1/me', undefined, cookie);
assert.equal(me.status, 200, `GET /api/v1/me returned ${me.status}; cannot verify deletion precondition.`);
assert.equal(me.body?.accountDeletionAvailable, true,
  'Self-service deletion is disabled on this Worker (GET /api/v1/me accountDeletionAvailable=false). Enable SELTIVO_ACCOUNT_DELETION_ENABLED=1 on a staging Worker only — never production — before running this smoke.');
assert.equal((await call('DELETE', '/api/v1/me', { password: 'bad-password' }, cookie)).status, 401);
assert.equal((await call('DELETE', '/api/v1/me', { password }, cookie)).status, 204);
assert.equal((await call('GET', '/api/v1/me', undefined, cookie)).status, 401);
assert.equal((await call('POST', '/api/v1/auth/login', { email, password })).status, 401);
console.log('Cloudflare deletion smoke passed: password confirmation, account purge, session invalidation.');
