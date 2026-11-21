import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { hashPassword, now } from '../src/auth.js';
import { openDatabase } from '../src/db.js';

process.env.NODE_ENV = 'test';
const origin = 'http://localhost:3000';

test('registration, ownership, idempotent requests, chat and admin status', async () => {
  const db = openDatabase(':memory:');
  const sent: { to: string; text: string }[] = [];
  const app = buildApp({ db, origin, sendMail: async (to, _subject, text) => { sent.push({ to, text }); } });
  const call = async (method: string, url: string, payload?: unknown, cookie?: string, headers?: Record<string, string>) => {
    const response: any = await app.inject({ method, url, headers: { origin, ...(cookie ? { cookie } : {}), ...headers }, payload } as any);
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null, cookie: response.headers['set-cookie'] as string | undefined };
  };
  const user = async (name: string) => {
    const email = `${name}@example.test`;
    const registration = await call('POST', '/api/v1/auth/register', { email, password: 'VeryStrongPass123!', name });
    assert.equal(registration.status, 201);
    assert.equal(registration.body.verificationRequired, false);
    const login = await call('POST', '/api/v1/auth/login', { email, password: 'VeryStrongPass123!' });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.emailVerified, true);
    return login.cookie!.split(';')[0];
  };
  try {
    let alice = await user('alice');
    const bob = await user('bob');
    const config = await call('POST', '/api/v1/configurations', { templateId: 'fashion-01', name: 'Мій сайт', data: { id: 'brand', name: 'Brand', colors: {}, hero: {}, home: {}, products: [] } }, alice);
    assert.equal(config.status, 201);
    assert.equal((await call('GET', `/api/v1/configurations/${config.body.id}`, undefined, bob)).status, 404);
    const submissionKey = randomUUID();
    const submission = { templateId: 'fashion-01', templateName: 'Fashion 01', configurationId: config.body.id, contact: { name: 'Alice', email: 'alice@example.test' }, note: '', features: [], clientSubmissionId: submissionKey };
    const first = await call('POST', '/api/v1/requests', submission, alice);
    assert.equal(first.status, 201);
    const saved = await call('GET', `/api/v1/requests/${first.body.id}`, undefined, alice);
    assert.equal(saved.body.configuration.name, 'Brand');
    const updated = await call('PATCH', `/api/v1/configurations/${config.body.id}`, { name: 'Оновлений сайт', data: { id: 'brand', name: 'Updated', colors: {}, hero: {}, home: {}, products: [] } }, alice, { 'if-match': '1' });
    assert.equal(updated.body.revision, 2);
    assert.equal((await call('GET', `/api/v1/requests/${first.body.id}`, undefined, alice)).body.configuration.name, 'Brand');
    assert.equal((await call('DELETE', `/api/v1/configurations/${config.body.id}`, undefined, bob)).status, 404);
    assert.equal((await call('DELETE', `/api/v1/configurations/${config.body.id}`, undefined, alice)).status, 204);
    assert.equal((await call('GET', `/api/v1/configurations/${config.body.id}`, undefined, alice)).status, 404);
    assert.equal((await call('GET', `/api/v1/requests/${first.body.id}`, undefined, alice)).body.configuration.name, 'Brand');
    assert.equal((await call('GET', `/api/v1/requests/${first.body.id}`, undefined, bob)).status, 404);
    assert.equal((await call('POST', `/api/v1/requests/${first.body.id}/messages`, { body: 'Hi', clientMessageId: randomUUID() }, bob)).status, 404);
    const messageKey = randomUUID();
    const message = await call('POST', `/api/v1/requests/${first.body.id}/messages`, { body: 'Hi', clientMessageId: messageKey }, alice);
    assert.equal(message.status, 201);
    assert.equal((await call('POST', `/api/v1/requests/${first.body.id}/messages`, { body: 'Hi', clientMessageId: messageKey }, alice)).status, 200);
    const messages = await call('GET', `/api/v1/requests/${first.body.id}/messages`, undefined, alice);
    assert.equal(messages.body.items.length, 1);
    assert.equal(messages.body.items[0].readByRecipient, false);
    const adminId = randomUUID(), timestamp = now();
    db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin',?,?,?)")
      .run(adminId, 'admin@example.test', await hashPassword('VeryStrongPass123!'), timestamp, timestamp, timestamp);
    db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin 2',?,?,?)")
      .run(randomUUID(), 'admin2@example.test', await hashPassword('VeryStrongPass123!'), timestamp, timestamp, timestamp);
    const admin = (await call('POST', '/api/v1/auth/login', { email: 'admin@example.test', password: 'VeryStrongPass123!' })).cookie!.split(';')[0];
    const admin2 = (await call('POST', '/api/v1/auth/login', { email: 'admin2@example.test', password: 'VeryStrongPass123!' })).cookie!.split(';')[0];
    assert.equal((await call('GET', '/api/v1/admin/diagnostics', undefined, alice)).status, 403);
    assert.equal((await call('GET', '/api/v1/admin/diagnostics', undefined, admin)).body.ok, true);
    const customersPage = await call('GET', '/api/v1/admin/customers?limit=1', undefined, admin);
    assert.equal(customersPage.body.items.length, 1);
    assert.equal(customersPage.body.nextOffset, 1);
    assert.equal((await call('GET', '/api/v1/admin/customers?limit=1&offset=1', undefined, admin)).body.items.length, 1);
    assert.equal((await call('GET', '/api/v1/requests?limit=1', undefined, alice)).body.items[0].id, first.body.id);
    assert.equal((await call('GET', '/api/v1/notifications/unread-count', undefined, admin)).body.total, 1);
    assert.equal((await call('PATCH', `/api/v1/requests/${first.body.id}/read`, { lastSeenMessageId: message.body.id }, admin)).status, 204);
    assert.equal((await call('GET', '/api/v1/notifications/unread-count', undefined, admin)).body.total, 0);
    assert.equal((await call('GET', `/api/v1/requests/${first.body.id}/messages`, undefined, alice)).body.items[0].readByRecipient, true);
    const status = await call('PATCH', `/api/v1/admin/requests/${first.body.id}/status`, { status: 'reviewing', reason: 'Розпочали' }, admin, { 'if-match': '1' });
    assert.equal(status.status, 200);
    const adminReply = await call('POST', `/api/v1/requests/${first.body.id}/messages`, { body: 'Вітаємо, заявку прийнято', clientMessageId: randomUUID() }, admin);
    assert.equal(adminReply.status, 201);
    const notifications = await call('GET', '/api/v1/notifications', undefined, alice);
    assert.equal(notifications.status, 200);
    assert.equal(notifications.body.unread, 2);
    assert.deepEqual(notifications.body.items.map((item: { kind: string }) => item.kind).sort(), ['message', 'status']);
    assert.equal((await call('GET', '/api/v1/notifications', undefined, bob)).body.items.length, 0);
    assert.equal((await call('PATCH', `/api/v1/notifications/requests/${first.body.id}/read`, {}, bob)).status, 404);
    assert.equal((await call('POST', '/api/v1/auth/logout', {}, alice)).status, 204);
    const returned = await call('POST', '/api/v1/auth/login', { email: 'alice@example.test', password: 'VeryStrongPass123!' });
    const aliceAgain = returned.cookie!.split(';')[0];
    assert.equal((await call('GET', '/api/v1/notifications', undefined, aliceAgain)).body.unread, 2);
    assert.equal((await call('PATCH', `/api/v1/notifications/requests/${first.body.id}/read`, {}, aliceAgain)).status, 204);
    assert.equal((await call('GET', '/api/v1/notifications', undefined, aliceAgain)).body.unread, 0);
    alice = aliceAgain;
    assert.equal((await call('PATCH', `/api/v1/admin/requests/${first.body.id}/status`, { status: 'in_progress' }, admin2, { 'if-match': '1' })).status, 409);
    assert.equal((await call('PATCH', `/api/v1/admin/requests/${first.body.id}/status`, { status: 'in_progress' }, admin2, { 'if-match': '2' })).status, 200);
    assert.equal((await call('GET', `/api/v1/requests/${first.body.id}`, undefined, alice)).body.events.length, 3);
    assert.equal((await call('PATCH', `/api/v1/admin/requests/${first.body.id}/status`, { status: 'completed', reason: 'Готово' }, admin, { 'if-match': '3' })).status, 200);
    assert.equal((await call('POST', `/api/v1/requests/${first.body.id}/messages`, { body: 'Ще питання', clientMessageId: randomUUID() }, alice)).status, 409);
    assert.equal((await call('POST', `/api/v1/admin/requests/${first.body.id}/reopen`, { reason: 'Додаткові правки' }, admin, { 'if-match': '3' })).status, 409);
    const reopened = await call('POST', `/api/v1/admin/requests/${first.body.id}/reopen`, { reason: 'Додаткові правки' }, admin, { 'if-match': '4' });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.status, 'reviewing');
    assert.equal(reopened.body.statusVersion, 5);
    assert.equal((await call('GET', `/api/v1/requests/${first.body.id}`, undefined, alice)).body.events.length, 5);
    assert.equal((await call('GET', '/api/v1/notifications', undefined, alice)).body.unread, 3);
    // Користувач може видалити одне сповіщення або очистити все одразу.
    const notificationsBeforeDelete = await call('GET', '/api/v1/notifications', undefined, alice);
    const notificationId = notificationsBeforeDelete.body.items[0].id as string;
    assert.equal((await call('DELETE', `/api/v1/notifications/${notificationId}`, undefined, bob)).status, 404);
    assert.equal((await call('DELETE', `/api/v1/notifications/${notificationId}`, undefined, alice)).status, 204);
    assert.equal((await call('DELETE', `/api/v1/notifications/${notificationId}`, undefined, alice)).status, 404);
    assert.equal((await call('DELETE', '/api/v1/notifications', undefined, admin)).status, 403);
    assert.equal((await call('DELETE', '/api/v1/notifications', undefined, alice)).status, 204);
    const notificationsAfterDelete = await call('GET', '/api/v1/notifications', undefined, alice);
    assert.equal(notificationsAfterDelete.body.unread, 0);
    assert.equal(notificationsAfterDelete.body.items.length, 0);
    const auditLog = await call('GET', '/api/v1/admin/audit', undefined, admin);
    assert.equal(auditLog.status, 200);
    assert.ok(auditLog.body.items.some((item: { action: string }) => item.action === 'request.reopen'));
    assert.equal((await call('GET', '/api/v1/admin/customers', undefined, alice)).status, 403);
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin, 'content-type': 'application/json' }, payload: '{' });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.headers['cache-control'], 'private, no-store');
    const repeated = await call('POST', '/api/v1/requests', submission, alice);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.id, first.body.id);
    assert.equal((await call('POST', '/api/v1/requests', { ...submission, note: 'Інший вміст' }, alice)).status, 409);
    assert.equal((await call('POST', '/api/v1/auth/logout', {}, alice)).status, 204);
    assert.equal((await call('GET', '/api/v1/me', undefined, alice)).status, 401);
  } finally {
    await app.close(); db.close();
  }
});

test('failed chat email is visible to admins and retry does not create another message', async () => {
  const db = openDatabase(':memory:');
  let sends = 0;
  const app = buildApp({ db, origin, teamEmail: 'team@example.test', logger: false,
    sendMail: async () => { if (++sends === 1) throw new Error('private provider detail'); } });
  const call = async (method: string, url: string, payload?: unknown, cookie?: string) => {
    const response = await app.inject({ method: method as 'GET', url, headers: { origin, ...(cookie ? { cookie } : {}) }, payload } as any);
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null, cookie: response.headers['set-cookie'] as string | undefined };
  };
  try {
    await call('POST', '/api/v1/auth/register', { email: 'customer@example.test', password: 'VeryStrongPass123!', name: 'Customer' });
    const customer = (await call('POST', '/api/v1/auth/login', { email: 'customer@example.test', password: 'VeryStrongPass123!' })).cookie!.split(';')[0];
    const timestamp = now();
    db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin',?,?,?)")
      .run(randomUUID(), 'admin@example.test', await hashPassword('VeryStrongPass123!'), timestamp, timestamp, timestamp);
    const admin = (await call('POST', '/api/v1/auth/login', { email: 'admin@example.test', password: 'VeryStrongPass123!' })).cookie!.split(';')[0];
    const submitted = await call('POST', '/api/v1/requests', { templateId: 'fashion-01', templateName: 'Fashion 01', contact: { name: 'Customer' }, clientSubmissionId: randomUUID() }, customer);
    assert.equal(submitted.status, 201);
    const url = `/api/v1/requests/${submitted.body.id}/messages`;
    const payload = { body: 'Please help', clientMessageId: randomUUID() };
    assert.equal((await call('POST', url, payload, customer)).status, 201);
    assert.equal((await call('POST', url, payload, customer)).status, 200);
    assert.equal(sends, 1);
    assert.equal((await call('GET', '/api/v1/admin/email-notifications', undefined, customer)).status, 403);
    const failed = await call('GET', '/api/v1/admin/email-notifications', undefined, admin);
    assert.equal(failed.body.items.length, 1);
    assert.equal(failed.body.items[0].status, 'failed');
    assert.equal(failed.body.items[0].lastErrorCode, 'provider_error');
    const retryUrl = `/api/v1/admin/email-notifications/${failed.body.items[0].id}/retry`;
    assert.equal((await call('POST', retryUrl, {}, customer)).status, 403);
    assert.equal((await call('POST', retryUrl, {}, admin)).body.status, 'sent');
    assert.equal((await call('POST', retryUrl, {}, admin)).status, 409);
    assert.equal(sends, 2);
    assert.equal((await call('GET', '/api/v1/admin/email-notifications', undefined, admin)).body.items.length, 0);
    assert.equal((await call('GET', url, undefined, customer)).body.items.length, 1);
  } finally { await app.close(); db.close(); }
});

test('profile update, password change, password reset and email verification flows work end-to-end', async () => {
  const db = openDatabase(':memory:');
  const sent: { to: string; subject: string; text: string }[] = [];
  const app = buildApp({ db, origin, logger: false, sendMail: async (to, subject, text) => { sent.push({ to, subject, text }); } });
  const call = async (method: string, url: string, payload?: unknown, cookie?: string) => {
    const response = await app.inject({ method: method as 'GET', url, headers: { origin, ...(cookie ? { cookie } : {}) }, payload } as any);
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null, cookie: response.headers['set-cookie'] as string | undefined };
  };
  try {
    const reg = await call('POST', '/api/v1/auth/register', { email: 'Flow@Example.test', password: 'InitialPassword123!', name: 'Flow User' });
    assert.equal(reg.status, 201);
    const login = await call('POST', '/api/v1/auth/login', { email: 'flow@example.test', password: 'InitialPassword123!' });
    assert.equal(login.status, 200);
    const cookie = login.cookie!.split(';')[0];

    assert.equal((await call('PATCH', '/api/v1/me', { name: 'Updated Name', phone: '+380501112233', telegram: '@flow_user' }, cookie)).status, 200);
    const profile = await call('GET', '/api/v1/me', undefined, cookie);
    assert.equal(profile.body.name, 'Updated Name');
    assert.equal(profile.body.phone, '+380501112233');
    assert.equal(profile.body.telegram, '@flow_user');

    assert.equal((await call('POST', '/api/v1/auth/forgot-password', { email: 'flow@example.test' })).status, 202);
    assert.equal(sent.length, 1);
    const staleResetToken = new URL(sent[0].text.split(': ').pop()!).searchParams.get('token')!;

    assert.equal((await call('POST', '/api/v1/auth/change-password', { currentPassword: 'wrong', newPassword: 'ChangedPassword123!' }, cookie)).status, 401);
    assert.equal((await call('POST', '/api/v1/auth/change-password', { currentPassword: 'InitialPassword123!', newPassword: 'InitialPassword123!' }, cookie)).status, 422);
    assert.equal((await call('POST', '/api/v1/auth/change-password', { currentPassword: 'InitialPassword123!', newPassword: 'ChangedPassword123!' }, cookie)).status, 200);
    assert.equal((await call('GET', '/api/v1/me', undefined, cookie)).status, 401);
    assert.equal((await call('POST', '/api/v1/auth/reset-password', { token: staleResetToken, password: 'AnotherPassword123!' })).status, 422);

    assert.equal((await call('POST', '/api/v1/auth/forgot-password', { email: 'flow@example.test' })).status, 202);
    assert.equal(sent.length, 2);
    const resetToken = new URL(sent[1].text.split(': ').pop()!).searchParams.get('token')!;
    assert.equal((await call('POST', '/api/v1/auth/reset-password', { token: resetToken, password: 'ResetPassword123!' })).status, 200);
    assert.equal((await call('POST', '/api/v1/auth/reset-password', { token: resetToken, password: 'ResetPassword123!' })).status, 422);
    assert.equal((await call('POST', '/api/v1/auth/login', { email: 'flow@example.test', password: 'ChangedPassword123!' })).status, 401);
    assert.equal((await call('POST', '/api/v1/auth/login', { email: 'flow@example.test', password: 'ResetPassword123!' })).status, 200);

    db.prepare('UPDATE users SET email_verified_at=NULL WHERE id=?').run(reg.body.id);
    assert.equal((await call('POST', '/api/v1/auth/resend-verification', { email: 'flow@example.test' })).status, 202);
    assert.equal(sent.length, 3);
    const verifyToken = new URL(sent[2].text.split(': ').pop()!).searchParams.get('token')!;
    assert.equal((await call('POST', '/api/v1/auth/verify-email', { token: verifyToken })).status, 200);
    assert.equal((await call('POST', '/api/v1/auth/verify-email', { token: verifyToken })).status, 422);
  } finally { await app.close(); db.close(); }
});
