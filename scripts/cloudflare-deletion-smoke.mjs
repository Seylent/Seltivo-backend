import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.SELTIVO_SMOKE_URL ?? 'http://127.0.0.1:8789';
const origin = process.env.SELTIVO_SMOKE_ORIGIN ?? 'http://localhost:3011';
const email = `delete-smoke-${randomUUID()}@example.test`;
const password = 'SmokePassword123!';
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
assert.equal((await call('DELETE', '/api/v1/me', { password: 'bad-password' }, cookie)).status, 401);
assert.equal((await call('DELETE', '/api/v1/me', { password }, cookie)).status, 204);
assert.equal((await call('GET', '/api/v1/me', undefined, cookie)).status, 401);
assert.equal((await call('POST', '/api/v1/auth/login', { email, password })).status, 401);
console.log('Cloudflare deletion smoke passed: password confirmation, account purge, session invalidation.');
