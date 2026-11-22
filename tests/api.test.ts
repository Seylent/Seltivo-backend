import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { hashPassword, now } from '../src/auth.js';
import { openDatabase } from '../src/db.js';
import { createWorkerRouter } from '../cloudflare/worker-router.js';

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
    assert.ok(auditLog.body.items.some((item: { action: string }) => item.action === 'request.created'));
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

test('a customer gets exactly one auto-reply in chat, without emails or notification spam', async () => {
  const db = openDatabase(':memory:');
  const sent: string[] = [];
  const app = buildApp({ db, origin, logger: false, teamEmail: 'team@example.test',
    sendMail: async (to) => { sent.push(to); } });
  const call = async (method: string, url: string, payload?: unknown, cookie?: string) => {
    const response: any = await app.inject({ method, url, headers: { origin, ...(cookie ? { cookie } : {}) }, payload } as any);
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null, cookie: response.headers['set-cookie'] as string | undefined };
  };
  const autoReply = 'Привіт, менеджер скоро відповість вам';
  try {
    // У продакшені адмін існує ще до першого листа — автовідповідь пишемо від нього.
    const adminId = randomUUID(), timestamp = now();
    db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin',?,?,?)")
      .run(adminId, 'admin@example.test', await hashPassword('VeryStrongPass123!'), timestamp, timestamp, timestamp);
    const admin = (await call('POST', '/api/v1/auth/login', { email: 'admin@example.test', password: 'VeryStrongPass123!' })).cookie!.split(';')[0];

    await call('POST', '/api/v1/auth/register', { email: 'customer@example.test', password: 'VeryStrongPass123!', name: 'Customer' });
    const customer = (await call('POST', '/api/v1/auth/login', { email: 'customer@example.test', password: 'VeryStrongPass123!' })).cookie!.split(';')[0];
    const config = await call('POST', '/api/v1/configurations', { templateId: 'fashion-01', name: 'Мій сайт', data: { id: 'brand', name: 'Brand', colors: {}, hero: {}, home: {}, products: [] } }, customer);
    const request = await call('POST', '/api/v1/requests', { templateId: 'fashion-01', templateName: 'Fashion 01', configurationId: config.body.id, contact: { name: 'Customer' }, note: '', features: [], clientSubmissionId: randomUUID() }, customer);
    const url = `/api/v1/requests/${request.body.id}/messages`;
    // Вітальне повідомлення в чаті є одразу після створення заявки, ще до листа клієнта.
    const initial = (await call('GET', url, undefined, customer)).body.items;
    assert.deepEqual(initial.map((message: { body: string }) => message.body), [autoReply]);
    assert.equal(initial[0].senderId, adminId);
    const key = randomUUID();
    const first = await call('POST', url, { body: 'Перше питання', clientMessageId: key }, customer);
    assert.equal(first.status, 201);
    let items = (await call('GET', url, undefined, customer)).body.items;
    assert.equal(items.length, 2);
    assert.equal(items[0].body, autoReply);
    assert.equal(items[1].body, 'Перше питання');
    assert.equal(sent.length, 1); // автовідповідь листа не надсилає

    assert.equal((await call('POST', url, { body: 'Перше питання', clientMessageId: key }, customer)).status, 200);
    assert.equal((await call('POST', url, { body: 'Друге питання', clientMessageId: randomUUID() }, customer)).status, 201);
    items = (await call('GET', url, undefined, customer)).body.items;
    assert.equal(items.length, 3);
    assert.equal(items.filter((message: { body: string }) => message.body === autoReply).length, 1);

    assert.equal((await call('POST', url, { body: 'Відповідаю особисто', clientMessageId: randomUUID() }, admin)).status, 201);
    items = (await call('GET', url, undefined, customer)).body.items;
    assert.equal(items.length, 4);
    assert.equal(items.filter((message: { body: string }) => message.body === autoReply).length, 1);
  } finally { await app.close(); db.close(); }
});

test('auto-reply uses the chat language and managers can see the customer language', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false });
  const call = async (method: string, url: string, payload?: unknown, cookie?: string, extraHeaders: Record<string, string> = {}) => {
    const response: any = await app.inject({ method, url, headers: { origin, ...(cookie ? { cookie } : {}), ...extraHeaders }, payload } as any);
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null, cookie: response.headers['set-cookie'] as string | undefined };
  };
  try {
    const adminId = randomUUID(), timestamp = now();
    db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin',?,?,?)")
      .run(adminId, 'admin@example.test', await hashPassword('VeryStrongPass123!'), timestamp, timestamp, timestamp);
    const admin = (await call('POST', '/api/v1/auth/login', { email: 'admin@example.test', password: 'VeryStrongPass123!' })).cookie!.split(';')[0];

    await call('POST', '/api/v1/auth/register', { email: 'english@example.test', password: 'VeryStrongPass123!', name: 'English Customer' });
    const login = await call('POST', '/api/v1/auth/login', { email: 'english@example.test', password: 'VeryStrongPass123!' });
    const customer = login.cookie!.split(';')[0];
    const englishCookie = `${customer}; seltivo-locale=en`;
    assert.equal((await call('GET', '/api/v1/me', undefined, englishCookie)).body.locale, null);

    const config = await call('POST', '/api/v1/configurations', { templateId: 'fashion-01', name: 'My site', data: { id: 'brand', name: 'Brand', colors: {}, hero: {}, home: {}, products: [] } }, englishCookie);
    const request = await call('POST', '/api/v1/requests', { templateId: 'fashion-01', templateName: 'Fashion 01', configurationId: config.body.id, contact: { name: 'English Customer' }, note: '', features: [], clientSubmissionId: randomUUID() }, englishCookie);
    const url = `/api/v1/requests/${request.body.id}/messages`;
    // Мова вітального повідомлення визначається ще на етапі створення заявки.
    assert.equal((await call('GET', url, undefined, englishCookie)).body.items[0].body, 'Hi! A manager will get back to you shortly');
    assert.equal((await call('POST', url, { body: 'Hello', clientMessageId: randomUUID() }, englishCookie)).status, 201);

    const items = (await call('GET', url, undefined, englishCookie)).body.items;
    assert.equal(items[0].body, 'Hi! A manager will get back to you shortly');
    assert.equal(items[1].body, 'Hello');
    assert.equal((await call('GET', '/api/v1/me', undefined, englishCookie)).body.locale, 'en');

    // Менеджер бачить мову клієнта в заявці, списку заявок і картці клієнта.
    assert.equal((await call('GET', `/api/v1/requests/${request.body.id}`, undefined, admin)).body.customerLocale, 'en');
    assert.equal((await call('GET', '/api/v1/admin/requests', undefined, admin)).body.items[0].customerLocale, 'en');
    assert.equal((await call('GET', '/api/v1/admin/customers', undefined, admin)).body.items[0].locale, 'en');
    const customerId = (await call('GET', '/api/v1/me', undefined, englishCookie)).body.id;
    assert.equal((await call('GET', `/api/v1/admin/customers/${customerId}`, undefined, admin)).body.locale, 'en');
    assert.equal((await call('GET', '/api/v1/admin/overview', undefined, admin)).body.waitingReplies[0].customerLocale, 'en');
  } finally { await app.close(); db.close(); }
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
    // Клієнтське повідомлення + автовідповідь «менеджер скоро відповість».
    assert.equal((await call('GET', url, undefined, customer)).body.items.length, 2);
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
    const verifyCode = sent[2].text.match(/\b\d{6}\b/)?.[0];
    assert.ok(verifyCode);
    assert.equal((await call('POST', '/api/v1/auth/verify-email', { email: 'flow@example.test', code: verifyCode })).status, 200);
    assert.equal((await call('POST', '/api/v1/auth/verify-email', { email: 'flow@example.test', code: verifyCode })).status, 422);
  } finally { await app.close(); db.close(); }
});

test('email code gates login, expires, limits guesses and is consumed once', async () => {
  const db = openDatabase(':memory:');
  const sent: string[] = [];
  const app = buildApp({ db, origin, logger: false, router: createWorkerRouter(), requireEmailVerification: true, sendMail: async (_to, _subject, text) => { sent.push(text); } });
  let requestCount = 0;
  const call = async (url: string, payload: unknown) => {
    const response = await app.inject({ method: 'POST', url, headers: { origin, 'cf-connecting-ip': `203.0.113.${++requestCount}` }, payload: Buffer.from(JSON.stringify(payload)) });
    return response.statusCode;
  };
  const email = 'code@example.test';
  const login = () => call('/api/v1/auth/login', { email, password: 'InitialPassword123!' });
  const verify = (code: string) => call('/api/v1/auth/verify-email', { email, code });
  try {
    assert.equal(await call('/api/v1/auth/register', { email, password: 'InitialPassword123!', name: 'Code User' }), 201);
    assert.equal(await login(), 403);
    const firstCode = sent[0].match(/\b\d{6}\b/)?.[0];
    assert.ok(firstCode);
    assert.equal(await verify(firstCode === '000000' ? '000001' : '000000'), 422);
    db.prepare("UPDATE auth_tokens SET expires_at=? WHERE purpose='verify'").run('2000-01-01T00:00:00.000Z');
    assert.equal(await verify(firstCode), 422);
    assert.equal(await call('/api/v1/auth/resend-verification', { email }), 202);
    const secondCode = sent[1].match(/\b\d{6}\b/)?.[0];
    assert.ok(secondCode);
    assert.equal(await verify(firstCode), 422);
    const wrong = secondCode === '000000' ? '000001' : '000000';
    for (let i = 0; i < 4; i++) assert.equal(await verify(wrong), 422);
    assert.equal(await verify(secondCode), 429);
    assert.equal(await call('/api/v1/auth/resend-verification', { email }), 202);
    const thirdCode = sent[2].match(/\b\d{6}\b/)?.[0];
    assert.ok(thirdCode);
    assert.equal(await verify(thirdCode), 200);
    assert.equal(await verify(thirdCode), 422);
    assert.equal(await login(), 200);
  } finally { db.close(); }
});

test('login sends a code to an existing customer who needs to verify', async () => {
  const db = openDatabase(':memory:');
  const sent: string[] = [];
  const app = buildApp({ db, origin, logger: false, router: createWorkerRouter(), requireEmailVerification: true, sendMail: async (_to, _subject, text) => { sent.push(text); } });
  const call = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { origin }, payload: Buffer.from(JSON.stringify(payload)) });
  const email = 'existing@example.test';
  try {
    assert.equal((await call('/api/v1/auth/register', { email, password: 'InitialPassword123!', name: 'Existing User' })).statusCode, 201);
    db.prepare("DELETE FROM auth_tokens WHERE purpose='verify'").run();
    const login = await call('/api/v1/auth/login', { email, password: 'InitialPassword123!' });
    assert.equal(login.statusCode, 403);
    assert.equal(sent.length, 2);
    const code = sent[1].match(/\b\d{6}\b/)?.[0];
    assert.ok(code);
    assert.equal((await call('/api/v1/auth/verify-email', { email, code })).statusCode, 200);
    assert.equal((await call('/api/v1/auth/login', { email, password: 'InitialPassword123!' })).statusCode, 200);
  } finally { db.close(); }
});

test('password policy accepts six characters and rejects five', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, logger: false });
  const call = (url: string, payload: unknown, cookie?: string) => app.inject({ method: 'POST', url, headers: { origin, ...(cookie ? { cookie } : {}) }, payload });
  try {
    assert.equal((await call('/api/v1/auth/register', { email: 'six@example.test', password: '123456', name: 'Six' })).statusCode, 201);
    assert.equal((await call('/api/v1/auth/register', { email: 'five@example.test', password: '12345', name: 'Five' })).statusCode, 422);
    const login = await call('/api/v1/auth/login', { email: 'six@example.test', password: '123456' });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers['set-cookie'] as string | undefined;
    assert.equal((await call('/api/v1/auth/change-password', { currentPassword: '123456', newPassword: '654321' }, cookie)).statusCode, 200);
    const nextLogin = await call('/api/v1/auth/login', { email: 'six@example.test', password: '654321' });
    assert.equal(nextLogin.statusCode, 200);
    assert.equal((await call('/api/v1/auth/change-password', { currentPassword: '654321', newPassword: '12345' }, nextLogin.headers['set-cookie'] as string | undefined)).statusCode, 422);
  } finally { db.close(); }
});
