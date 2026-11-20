import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';

process.env.NODE_ENV = 'test';
const origin = 'http://localhost:3000';

test('власні функції у заявці приймаються, а заявку може видалити тільки власник', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin });
  const call = async (method: string, url: string, payload?: unknown, cookie?: string) => {
    const response: any = await app.inject({ method, url, headers: { origin, ...(cookie ? { cookie } : {}) }, payload } as any);
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null, cookie: response.headers['set-cookie'] as string | undefined };
  };
  const user = async (name: string) => {
    const email = `${name}@example.test`;
    assert.equal((await call('POST', '/api/v1/auth/register', { email, password: 'VeryStrongPass123!', name })).status, 201);
    const login = await call('POST', '/api/v1/auth/login', { email, password: 'VeryStrongPass123!' });
    return login.cookie!.split(';')[0];
  };
  try {
    const alice = await user('alice');
    const bob = await user('bob');
    const created = await call('POST', '/api/v1/requests', {
      templateId: 'custom',
      templateName: 'Індивідуальний проєкт',
      configurationId: null,
      contact: { name: 'Alice', telegram: '@alice' },
      note: 'Опис',
      features: ['admin-panel', 'Розумний пошук по каталогу'],
      clientSubmissionId: randomUUID(),
    }, alice);
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.status, 'submitted');

    const requestId = created.body.id;
    assert.equal((await call('DELETE', `/api/v1/requests/${requestId}`, undefined, bob)).status, 404);
    assert.equal((await call('GET', `/api/v1/requests/${requestId}`, undefined, alice)).status, 200);

    assert.equal((await call('DELETE', `/api/v1/requests/${requestId}`, undefined, alice)).status, 204);
    assert.equal((await call('GET', `/api/v1/requests/${requestId}`, undefined, alice)).status, 404);
    assert.equal((await call('GET', '/api/v1/requests', undefined, alice)).body.items.length, 0);
  } finally {
    db.close();
    await app.close();
  }
});
