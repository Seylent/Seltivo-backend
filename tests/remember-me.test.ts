import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';

const origin = 'https://seltivo.example';
const credentials = { email: 'customer@example.test', password: 'VeryStrongPass123!' };

test('remembered and browser sessions restore, expire, rotate and revoke', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, secureCookies: true, logger: false });
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, cookie?: string, requestOrigin = origin) =>
    app.inject({ method, url, headers: { origin: requestOrigin, ...(cookie ? { cookie } : {}) }, payload } as any);
  try {
    assert.equal((await call('POST', '/api/v1/auth/register', { ...credentials, name: 'Customer' })).statusCode, 201);
    const short = await call('POST', '/api/v1/auth/login', credentials);
    const shortCookie = String(short.headers['set-cookie']);
    const shortToken = shortCookie.split(';')[0];
    assert.match(shortCookie, /HttpOnly; SameSite=Lax; Secure/);
    assert.doesNotMatch(shortCookie, /Max-Age=/);
    const shortExpiry = db.prepare('SELECT expires_at FROM sessions').get() as { expires_at: string };
    assert.ok(Date.parse(shortExpiry.expires_at) - Date.now() <= 12 * 60 * 60 * 1000);
    assert.equal((await call('GET', '/api/v1/me', undefined, shortToken)).statusCode, 200);

    const remembered = await call('POST', '/api/v1/auth/login', { ...credentials, rememberMe: true }, shortToken);
    const longCookie = String(remembered.headers['set-cookie']);
    const longToken = longCookie.split(';')[0];
    assert.match(longCookie, /HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
    assert.equal((await call('GET', '/api/v1/me', undefined, shortToken)).statusCode, 401);
    assert.equal((await call('GET', '/api/v1/me', undefined, longToken)).statusCode, 200);
    const longExpiry = db.prepare('SELECT expires_at FROM sessions').get() as { expires_at: string };
    assert.ok(Date.parse(longExpiry.expires_at) - Date.now() > 29 * 24 * 60 * 60 * 1000);

    assert.equal((await call('POST', '/api/v1/auth/logout', undefined, longToken, 'https://evil.example')).statusCode, 403);
    assert.equal((await call('GET', '/api/v1/me', undefined, longToken)).statusCode, 200);
    const logout = await call('POST', '/api/v1/auth/logout', undefined, longToken);
    assert.equal(logout.statusCode, 204);
    assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await call('GET', '/api/v1/me', undefined, longToken)).statusCode, 401);

    const expiring = await call('POST', '/api/v1/auth/login', { ...credentials, rememberMe: true });
    const expiringToken = String(expiring.headers['set-cookie']).split(';')[0];
    db.prepare('UPDATE sessions SET expires_at=?').run(new Date(Date.now() - 1000).toISOString());
    assert.equal((await call('GET', '/api/v1/me', undefined, expiringToken)).statusCode, 401);
  } finally {
    await app.close(); db.close();
  }
});
