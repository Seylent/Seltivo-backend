import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';

process.env.NODE_ENV = 'test';
test('account export contains only owned data and excludes authentication secrets', async () => {
  const db = openDatabase(':memory:');
  const origin = 'https://seltivo.example';
  const app = buildApp({ db, origin, logger: false, requireEmailVerification: false });
  try {
    const customers = [];
    for (const name of ['Alice', 'Bob']) {
      const email = `${name.toLowerCase()}@example.test`;
      const payload = { email, password: 'ExportPassword123!', name };
      const registered = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { origin }, payload });
      assert.equal(registered.statusCode, 201);
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { email, password: payload.password } });
      assert.equal(login.statusCode, 200);
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const config = await app.inject({ method: 'POST', url: '/api/v1/configurations', headers: { origin, cookie }, payload: {
        templateId: 'noir', name: `${name} design`, data: { version: 1, templateId: 'noir', changes: [] },
      } });
      assert.equal(config.statusCode, 201);
      const brief = await app.inject({ method: 'POST', url: '/api/v1/requests', headers: { origin, cookie }, payload: {
        templateId: 'noir', templateName: 'NOIR', configurationId: null,
        contact: { name, email }, note: `${name} private brief`, features: [], clientSubmissionId: crypto.randomUUID(),
      } });
      assert.equal(brief.statusCode, 201);
      const message = await app.inject({ method: 'POST', url: `/api/v1/requests/${brief.json().id}/messages`, headers: { origin, cookie }, payload: {
        body: `${name} private message`, clientMessageId: crypto.randomUUID(),
      } });
      assert.equal(message.statusCode, 201);
      customers.push({ cookie, email });
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me/export' })).statusCode, 401);
    const response = await app.inject({ method: 'GET', url: '/api/v1/me/export', headers: { cookie: customers[0].cookie } });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-disposition']), /attachment.*seltivo-account/);
    assert.match(String(response.headers['cache-control']), /private.*no-store/);
    const exported = response.json();
    assert.equal(exported.profile.email, customers[0].email);
    assert.equal(exported.configurations.length, 1);
    assert.equal(exported.configurations[0].name, 'Alice design');
    assert.equal(exported.requests.length, 1);
    assert.equal(exported.requests[0].note, 'Alice private brief');
    assert.ok(!response.body.includes('Bob private brief'));
    assert.ok(!response.body.includes(customers[1].email));
    assert.equal(exported.messages.length, 1);
    assert.equal(exported.messages[0].body, 'Alice private message');
    for (const forbidden of ['password_hash', 'token_hash', 'sessions', 'auth_tokens', 'admin_two_factor', 'ExportPassword123!']) {
      assert.ok(!response.body.includes(forbidden), forbidden);
    }
    for (let i = 0; i < 2; i++) assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me/export', headers: { cookie: customers[0].cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me/export', headers: { cookie: customers[0].cookie } })).statusCode, 429);
    db.prepare("UPDATE users SET role='admin' WHERE email=?").run(customers[1].email);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me/export', headers: { cookie: customers[1].cookie } })).statusCode, 403);
  } finally { await app.close(); db.close(); }
});
