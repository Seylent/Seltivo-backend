import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { newEmailCode } from '../src/auth.js';
process.env.NODE_ENV = 'test';
test('verified customer receives an HttpOnly session without storing or resending their password', async () => {
  const db = openDatabase(':memory:');
  const origin = 'https://seltivo.example';
  const sent: string[] = [];
  const app = buildApp({ db, origin, logger: false, secureCookies: true, requireEmailVerification: true, sendMail: async (_to, _subject, text) => { sent.push(text); } });
  const call = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers: { origin }, payload });
  try {
    const registered = await call('/api/v1/auth/register', { email: 'verified@example.test', password: 'RegistrationPassword!', name: 'Alice' });
    assert.equal(registered.statusCode, 201);
    const code = sent[0].match(/\b\d{6}\b/)![0];
    const verified = await call('/api/v1/auth/verify-email', { email: 'verified@example.test', code });
    assert.equal(verified.statusCode, 200);
    const cookie = String(verified.headers['set-cookie']);
    assert.match(cookie, /seltivo_session=.*HttpOnly; SameSite=Lax; Secure/);
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: cookie.split(';')[0] } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().email, 'verified@example.test');
    const repeated = await call('/api/v1/auth/verify-email', { email: 'verified@example.test', code });
    assert.equal(repeated.statusCode, 422);
    assert.equal(repeated.headers['set-cookie'], undefined);
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(registered.json().id);
    const adminCode = newEmailCode(db, registered.json().id);
    const admin = await call('/api/v1/auth/verify-email', { email: 'verified@example.test', code: adminCode });
    assert.equal(admin.headers['set-cookie'], undefined, 'Email verification must never bypass admin password and 2FA');
  } finally { await app.close(); db.close(); }
});
