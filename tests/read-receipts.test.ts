import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { hashPassword, now } from '../src/auth.js';
import { openDatabase } from '../src/db.js';

process.env.NODE_ENV = 'test';
const origin = 'http://localhost:3000';

test('marking a conversation read notifies the other side over the live chat channel', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false, sendMail: async () => {} });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const controller = new AbortController();
  const call = async (method: string, url: string, payload?: unknown, cookie?: string) => {
    const response: any = await app.inject({ method, url, headers: { origin, ...(cookie ? { cookie } : {}) }, payload } as any);
    return {
      status: response.statusCode,
      body: response.body ? JSON.parse(response.body) : null,
      cookie: response.headers['set-cookie'] as string | undefined,
    };
  };
  const register = async (name: string) => {
    const email = `${name}@example.test`;
    assert.equal((await call('POST', '/api/v1/auth/register', { email, password: 'VeryStrongPass123!', name })).status, 201);
    const login = await call('POST', '/api/v1/auth/login', { email, password: 'VeryStrongPass123!' });
    return login.cookie!.split(';')[0];
  };
  try {
    const alice = await register('alice');
    const config = await call('POST', '/api/v1/configurations', {
      templateId: 'fashion-01', name: 'Brand',
      data: { id: 'brand', name: 'Brand', colors: {}, hero: {}, home: {}, products: [] },
    }, alice);
    const request = await call('POST', '/api/v1/requests', {
      templateId: 'fashion-01', templateName: 'Fashion 01', configurationId: config.body.id,
      contact: { name: 'Alice', email: 'alice@example.test' }, note: '', features: [],
      clientSubmissionId: randomUUID(),
    }, alice);
    const message = await call('POST', `/api/v1/requests/${request.body.id}/messages`, { body: 'Hi', clientMessageId: randomUUID() }, alice);
    assert.equal(message.status, 201);
    assert.equal((await call('GET', `/api/v1/requests/${request.body.id}/messages`, undefined, alice)).body.items[0].readByRecipient, false);

    const adminId = randomUUID(), timestamp = now();
    db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin',?,?,?)")
      .run(adminId, 'admin@example.test', await hashPassword('VeryStrongPass123!'), timestamp, timestamp, timestamp);
    const admin = (await call('POST', '/api/v1/auth/login', { email: 'admin@example.test', password: 'VeryStrongPass123!' })).cookie!.split(';')[0];

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/events`, { headers: { cookie: alice, origin }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    assert.match(decoder.decode(first.value, { stream: true }), /event: ready/);

    assert.equal((await call('PATCH', `/api/v1/requests/${request.body.id}/read`, { lastSeenMessageId: message.body.id }, admin)).status, 204);
    assert.equal((await call('GET', `/api/v1/requests/${request.body.id}/messages`, undefined, alice)).body.items[0].readByRecipient, true);

    let text = '';
    for (let i = 0; i < 10 && !text.includes('"kind":"read"'); i += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(text, /event: chat/);
    assert.match(text, /"kind":"read"/);
    assert.match(text, new RegExp(`"requestId":"${request.body.id}"`));
    await reader.cancel();
  } finally {
    controller.abort();
    await app.close();
  }
});
