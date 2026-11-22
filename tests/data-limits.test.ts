import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createSession, now, sessionCookie } from '../src/auth.js';

process.env.NODE_ENV = 'test';
const origin = 'https://seltivo.example';
const configuration = (size = 0) => ({ templateId: 'noir', name: 'Design', data: { id: 'brand', name: 'Brand', colors: {}, hero: {}, home: {}, products: [], text: 'a'.repeat(size) } });
function fixture(limits: Record<string, number>, databaseBytes?: () => number) {
  const db = openDatabase(':memory:');
  const userId = crypto.randomUUID(), timestamp = now();
  db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'customer','Alice',?,?,?)")
    .run(userId, 'alice@example.test', 'not-a-credential', timestamp, timestamp, timestamp);
  const cookie = sessionCookie(createSession(db, userId), false).split(';')[0];
  const app = buildApp({ db, origin, logger: false, requireEmailVerification: false, dataLimits: limits, databaseBytes });
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>, headers = {}) =>
    app.inject({ method, url, payload, headers: { origin, cookie, ...headers } });
  return { db, app, call, userId, close: async () => { await app.close(); db.close(); } };
}

test('account storage counts saved designs and request snapshots, and allows replacing without double counting', async () => {
  const f = fixture({ accountBytes: 500 });
  try {
    const saved = await f.call('POST', '/api/v1/configurations', configuration(200));
    assert.equal(saved.statusCode, 201);
    const id = saved.json().id;
    const updated = await f.call('PATCH', `/api/v1/configurations/${id}`, { name: 'Updated', data: configuration(200).data }, { 'if-match': '1' });
    assert.equal(updated.statusCode, 200);
    assert.equal((await f.call('POST', '/api/v1/configurations', configuration(200))).statusCode, 422);
    assert.equal((await f.call('POST', '/api/v1/requests', { templateId: 'noir', templateName: 'NOIR', configurationId: id, contact: { name: 'Alice' }, clientSubmissionId: crypto.randomUUID() })).statusCode, 422);
    assert.equal((await f.call('DELETE', `/api/v1/configurations/${id}`)).statusCode, 204);
    assert.equal((await f.call('POST', '/api/v1/configurations', configuration(200))).statusCode, 201);
  } finally { await f.close(); }
});

test('persistent request and guest quotas preserve successful retries at the limit', async () => {
  const f = fixture({ requestsPerAccount: 1, guestRequests: 1 });
  try {
    const request = { templateId: 'noir', templateName: 'NOIR', contact: { name: 'Alice' }, clientSubmissionId: crypto.randomUUID() };
    assert.equal((await f.call('POST', '/api/v1/requests', request)).statusCode, 201);
    assert.equal((await f.call('POST', '/api/v1/requests', request)).statusCode, 200);
    assert.equal((await f.call('POST', '/api/v1/requests', { ...request, clientSubmissionId: crypto.randomUUID() })).statusCode, 422);
    const guest = { id: crypto.randomUUID(), name: 'Guest', contact: '@guest', features: [], budget: '', note: 'Need a store', telegramStatus: 'failed' };
    assert.equal((await f.call('POST', '/api/v1/guest-requests', guest)).statusCode, 201);
    assert.equal((await f.call('POST', '/api/v1/guest-requests', { ...guest, telegramStatus: 'sent' })).statusCode, 200);
    assert.equal((await f.call('POST', '/api/v1/guest-requests', { ...guest, id: crypto.randomUUID() })).statusCode, 503);
    assert.equal((f.db.prepare('SELECT telegram_status FROM guest_requests WHERE id=?').get(guest.id) as { telegram_status: string }).telegram_status, 'sent');
  } finally { await f.close(); }
});

test('global storage ceiling blocks growth while keeping reads and cleanup available', async () => {
  let used = 0;
  const f = fixture({ databaseBytes: 1000 }, () => used);
  try {
    const saved = await f.call('POST', '/api/v1/configurations', configuration());
    assert.equal(saved.statusCode, 201);
    used = 1000;
    assert.equal((await f.call('POST', '/api/v1/configurations', configuration())).statusCode, 503);
    assert.equal((await f.call('GET', '/api/v1/configurations')).statusCode, 200);
    assert.equal((await f.call('DELETE', `/api/v1/configurations/${saved.json().id}`)).statusCode, 204);
  } finally { await f.close(); }
});

test('conversation message ceiling keeps retries available and cannot be bypassed with a new message id', async () => {
  const f = fixture({ messagesPerConversation: 1 });
  try {
    const created = await f.call('POST', '/api/v1/requests', { templateId: 'noir', templateName: 'NOIR', contact: { name: 'Alice' }, clientSubmissionId: crypto.randomUUID() });
    const url = `/api/v1/requests/${created.json().id}/messages`;
    const payload = { body: 'Hello', clientMessageId: crypto.randomUUID() };
    assert.equal((await f.call('POST', url, payload)).statusCode, 201);
    assert.equal((await f.call('POST', url, payload)).statusCode, 200);
    assert.equal((await f.call('POST', url, { ...payload, clientMessageId: crypto.randomUUID() })).statusCode, 422);
  } finally { await f.close(); }
});
