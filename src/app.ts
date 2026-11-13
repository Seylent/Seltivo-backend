import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SeltivoDb } from './db.js';
import { actorFromRequest, audit, clearSessionCookie, createSession, hashPassword, hashToken, newAuthToken, normalizeEmail, now, sessionCookie, verifyPassword, type Actor } from './auth.js';

const id = z.uuid();
const email = z.email().max(254);
const password = z.string().min(12).max(200);
const contact = z.object({ name: z.string().trim().min(2).max(60), email: email.optional(), phone: z.string().trim().max(40).optional(), telegram: z.string().trim().max(80).optional() }).strict();
const feature = z.enum(['telegram-orders', 'online-payment', 'admin-panel', 'delivery', 'other']);
const page = z.object({ offset: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(100).default(50) });
const statuses = ['submitted', 'reviewing', 'needs_info', 'in_progress', 'completed', 'cancelled'] as const;
type Status = typeof statuses[number];
const transitions: Record<Status, Status[]> = {
  submitted: ['reviewing', 'cancelled'], reviewing: ['needs_info', 'in_progress', 'cancelled'],
  needs_info: ['reviewing', 'in_progress', 'cancelled'], in_progress: ['needs_info', 'completed', 'cancelled'],
  completed: [], cancelled: [],
};
const datePlus = (ms: number) => new Date(Date.now() + ms).toISOString();
const fail = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error });

type Mail = (to: string, subject: string, text: string) => Promise<void>;
export type AppOptions = { db: SeltivoDb; origin: string; secureCookies?: boolean; sendMail?: Mail; teamEmail?: string };

function parse<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(body);
  if (!result.success) { fail(reply, 422, 'Перевірте поля запиту.'); return null; }
  return result.data;
}

function configJson(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.name !== 'string' || typeof data.id !== 'string' || !data.colors || !data.hero || !data.home || !Array.isArray(data.products)) return null;
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 8 * 1024 * 1024) return null;
  let images = 0;
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > 30) return false;
    if (typeof node === 'string' && node.startsWith('data:')) {
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(node);
      if (!match || ++images > 30 || match[2].length > 2_800_000) return false;
      const bytes = Buffer.from(match[2], 'base64');
      const signature = bytes.subarray(0, 12);
      return match[1] === 'png' ? signature.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        : match[1] === 'jpeg' ? signature.subarray(0, 3).equals(Buffer.from([255,216,255]))
        : signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP';
    }
    if (Array.isArray(node)) return node.every((item) => walk(item, depth + 1));
    if (node && typeof node === 'object') return Object.values(node).every((item) => walk(item, depth + 1));
    return true;
  };
  return walk(value, 0) ? json : null;
}

export function buildApp({ db, origin, secureCookies = false, sendMail, teamEmail }: AppOptions) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 9 * 1024 * 1024, trustProxy: process.env.SELTIVO_TRUST_PROXY === '1' });
  const attempts = new Map<string, number[]>();
  const mail = async (to: string, subject: string, text: string) => {
    if (!sendMail) return;
    try { await sendMail(to, subject, text); } catch (error) { app.log.error({ error }, 'mail delivery failed'); }
  };
  const auth = (request: FastifyRequest, reply: FastifyReply, role?: 'customer' | 'admin') => {
    const actor = actorFromRequest(db, request);
    if (!actor) { fail(reply, 401, 'Увійдіть до акаунта.'); return null; }
    if (role && actor.role !== role) { fail(reply, 403, 'Недостатньо прав.'); return null; }
    return actor;
  };
  const verified = (actor: Actor, reply: FastifyReply) => {
    if (!actor.email_verified_at) { fail(reply, 403, 'Підтвердьте email.'); return false; }
    return true;
  };
  const requestRow = (requestId: string, actor: Actor) => db.prepare(`SELECT r.*,c.id conversation_id FROM requests r JOIN conversations c ON c.request_id=r.id
    WHERE r.id=? AND (r.customer_id=? OR ?='admin')`).get(requestId, actor.id, actor.role) as any;

  app.addHook('onRequest', async (request, reply) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) && request.headers.origin !== origin) {
      return fail(reply, 403, 'Невірне джерело запиту.');
    }
    if (request.method === 'POST' && (request.url.startsWith('/api/v1/auth/') || request.url.includes('/messages'))) {
      const key = `${request.ip}:${request.url.split('?')[0]}`;
      const current = Date.now();
      const recent = (attempts.get(key) ?? []).filter((time) => current - time < 60_000);
      if (recent.length >= (request.url.includes('/messages') ? 30 : 10)) return fail(reply, 429, 'Забагато запитів.');
      attempts.set(key, [...recent, current]);
      if (attempts.size > 10_000) attempts.clear();
    }
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (typeof error === 'object' && error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return fail(reply, error.statusCode, error.statusCode === 413 ? 'Запит завеликий.' : 'Невірний формат запиту.');
    }
    app.log.error(error);
    return fail(reply, 500, 'Помилка сервера.');
  });
  app.get('/api/v1/health', async () => ({ ok: db.pragma('quick_check', { simple: true }) === 'ok' }));

  app.post('/api/v1/auth/register', async (request, reply) => {
    if (!sendMail) return fail(reply, 503, 'Пошту ще не налаштовано.');
    const body = parse(z.object({ email, password, name: z.string().trim().min(2).max(80) }).strict(), request.body, reply);
    if (!body) return;
    const normalized = normalizeEmail(body.email);
    if (db.prepare('SELECT id FROM users WHERE email=?').get(normalized)) return fail(reply, 409, 'Акаунт із цим email уже існує.');
    const userId = randomUUID();
    const timestamp = now();
    const hash = await hashPassword(body.password);
    try {
      db.prepare(`INSERT INTO users(id,email,password_hash,role,name,created_at,updated_at) VALUES (?,?,?,'customer',?,?,?)`)
        .run(userId, normalized, hash, body.name, timestamp, timestamp);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed: users.email')) return fail(reply, 409, 'Акаунт із цим email уже існує.');
      throw error;
    }
    const token = newAuthToken(db, userId, 'verify', 24 * 60 * 60 * 1000);
    await mail(normalized, 'Підтвердьте email SELTIVO', `${origin}/verify-email?token=${token}`);
    return reply.code(201).send({ id: userId, verificationRequired: true });
  });
  app.post('/api/v1/auth/resend-verification', async (request, reply) => {
    const body = parse(z.object({ email }).strict(), request.body, reply);
    if (!body) return;
    const user = db.prepare('SELECT id,email,email_verified_at FROM users WHERE email=? AND disabled_at IS NULL').get(normalizeEmail(body.email)) as any;
    if (user && !user.email_verified_at && sendMail) {
      const token = newAuthToken(db, user.id, 'verify', 24 * 60 * 60 * 1000);
      await mail(user.email, 'Підтвердьте email SELTIVO', `${origin}/verify-email?token=${token}`);
    }
    return reply.code(202).send({ ok: true });
  });
  app.post('/api/v1/auth/verify-email', async (request, reply) => {
    const body = parse(z.object({ token: z.string().min(20).max(100) }).strict(), request.body, reply);
    if (!body) return;
    const row = db.prepare("SELECT user_id FROM auth_tokens WHERE token_hash=? AND purpose='verify' AND expires_at>?").get(hashToken(body.token), now()) as { user_id: string } | undefined;
    if (!row) return fail(reply, 422, 'Посилання недійсне або прострочене.');
    db.transaction(() => {
      db.prepare('UPDATE users SET email_verified_at=?,updated_at=? WHERE id=?').run(now(), now(), row.user_id);
      db.prepare('DELETE FROM auth_tokens WHERE token_hash=?').run(hashToken(body.token));
    })();
    return { ok: true };
  });
  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = parse(z.object({ email, password: z.string().max(200) }).strict(), request.body, reply);
    if (!body) return;
    const user = db.prepare('SELECT id,email,password_hash,role,name,email_verified_at FROM users WHERE email=? AND disabled_at IS NULL').get(normalizeEmail(body.email)) as any;
    if (!user || !await verifyPassword(body.password, user.password_hash)) return fail(reply, 401, 'Невірний email або пароль.');
    const token = createSession(db, user.id);
    if (user.role === 'admin') audit(db, user.id, 'auth.login', 'user', user.id);
    reply.header('Set-Cookie', sessionCookie(token, secureCookies));
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role, emailVerified: Boolean(user.email_verified_at) } };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const cookie = request.headers.cookie?.split(';').map((s) => s.trim()).find((s) => s.startsWith('seltivo_session='));
    if (cookie) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(cookie.slice(16)));
    reply.header('Set-Cookie', clearSessionCookie(secureCookies));
    return reply.code(204).send();
  });
  app.post('/api/v1/auth/forgot-password', async (request, reply) => {
    const body = parse(z.object({ email }).strict(), request.body, reply);
    if (!body) return;
    const user = db.prepare('SELECT id,email FROM users WHERE email=? AND disabled_at IS NULL').get(normalizeEmail(body.email)) as any;
    if (user && sendMail) {
      const token = newAuthToken(db, user.id, 'reset', 30 * 60 * 1000);
      await mail(user.email, 'Відновлення пароля SELTIVO', `${origin}/reset-password?token=${token}`);
    }
    return reply.code(202).send({ ok: true });
  });
  app.post('/api/v1/auth/reset-password', async (request, reply) => {
    const body = parse(z.object({ token: z.string().min(20).max(100), password }).strict(), request.body, reply);
    if (!body) return;
    const row = db.prepare("SELECT user_id FROM auth_tokens WHERE token_hash=? AND purpose='reset' AND expires_at>?").get(hashToken(body.token), now()) as { user_id: string } | undefined;
    if (!row) return fail(reply, 422, 'Посилання недійсне або прострочене.');
    const hash = await hashPassword(body.password);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(hash, now(), row.user_id);
      db.prepare('DELETE FROM auth_tokens WHERE user_id=?').run(row.user_id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);
    })();
    return { ok: true };
  });
  app.get('/api/v1/me', async (request, reply) => {
    const actor = auth(request, reply); if (!actor) return;
    const row = db.prepare('SELECT id,email,role,name,phone,telegram,email_verified_at FROM users WHERE id=?').get(actor.id) as any;
    return { id: row.id, email: row.email, role: row.role, name: row.name, phone: row.phone, telegram: row.telegram, emailVerified: Boolean(row.email_verified_at) };
  });
  app.patch('/api/v1/me', async (request, reply) => {
    const actor = auth(request, reply); if (!actor) return;
    const body = parse(z.object({ name: z.string().trim().min(2).max(80), phone: z.string().trim().max(40).nullable(), telegram: z.string().trim().max(80).nullable() }).strict(), request.body, reply);
    if (!body) return;
    db.prepare('UPDATE users SET name=?,phone=?,telegram=?,updated_at=? WHERE id=?').run(body.name, body.phone, body.telegram, now(), actor.id);
    return { ok: true };
  });

  const configBody = z.object({ templateId: z.string().regex(/^[a-z0-9-]{1,60}$/), name: z.string().trim().min(1).max(80), data: z.unknown() }).strict();
  app.get('/api/v1/configurations', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor) return;
    const query = parse(page, request.query, reply); if (!query) return;
    const items = db.prepare('SELECT id,template_id templateId,name,revision,created_at createdAt,updated_at updatedAt FROM configurations WHERE owner_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?').all(actor.id, query.limit, query.offset);
    return { items, nextOffset: (items as unknown[]).length === query.limit ? query.offset + query.limit : null };
  });
  app.post('/api/v1/configurations', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor || !verified(actor, reply)) return;
    const body = parse(configBody, request.body, reply); if (!body) return;
    const json = configJson(body.data); if (!json) return fail(reply, 422, 'Конфігурація завелика або пошкоджена.');
    const configId = randomUUID(), timestamp = now();
    db.prepare('INSERT INTO configurations(id,owner_id,template_id,name,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(configId, actor.id, body.templateId, body.name, json, timestamp, timestamp);
    return reply.code(201).send({ id: configId, revision: 1, updatedAt: timestamp });
  });
  app.get('/api/v1/configurations/:id', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor) return;
    const key = (request.params as { id: string }).id;
    const row = db.prepare('SELECT * FROM configurations WHERE id=? AND owner_id=? AND deleted_at IS NULL').get(key, actor.id) as any;
    if (!row) return fail(reply, 404, 'Не знайдено.');
    return { id: row.id, templateId: row.template_id, name: row.name, data: JSON.parse(row.data_json), revision: row.revision, updatedAt: row.updated_at };
  });
  app.patch('/api/v1/configurations/:id', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor || !verified(actor, reply)) return;
    const body = parse(z.object({ name: z.string().trim().min(1).max(80), data: z.unknown() }).strict(), request.body, reply); if (!body) return;
    const json = configJson(body.data); if (!json) return fail(reply, 422, 'Конфігурація завелика або пошкоджена.');
    const revision = Number(request.headers['if-match']);
    if (!Number.isInteger(revision) || revision < 1) return fail(reply, 400, 'Потрібна версія If-Match.');
    const result = db.prepare('UPDATE configurations SET name=?,data_json=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND deleted_at IS NULL')
      .run(body.name, json, now(), (request.params as any).id, actor.id, revision);
    if (!result.changes) return fail(reply, 409, 'Конфігурацію змінено або не знайдено.');
    return { id: (request.params as any).id, revision: revision + 1 };
  });
  app.delete('/api/v1/configurations/:id', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor) return;
    const result = db.prepare('UPDATE configurations SET deleted_at=? WHERE id=? AND owner_id=? AND deleted_at IS NULL').run(now(), (request.params as any).id, actor.id);
    if (!result.changes) return fail(reply, 404, 'Не знайдено.');
    return reply.code(204).send();
  });

  const requestBody = z.object({ templateId: z.string().regex(/^[a-z0-9-]{1,60}$/), templateName: z.string().trim().min(1).max(80), configurationId: id.nullable().optional(), contact, note: z.string().trim().max(2000).default(''), features: z.array(feature).max(5).default([]), clientSubmissionId: id }).strict();
  app.post('/api/v1/requests', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor || !verified(actor, reply)) return;
    const body = parse(requestBody, request.body, reply); if (!body) return;
    const existing = db.prepare('SELECT r.id,r.status,c.id conversationId FROM requests r JOIN conversations c ON c.request_id=r.id WHERE r.customer_id=? AND r.client_submission_id=?').get(actor.id, body.clientSubmissionId);
    if (existing) {
      const prior = db.prepare('SELECT template_id,configuration_id,contact_json,note,features_json FROM requests WHERE id=?').get((existing as any).id) as any;
      if (prior.template_id !== body.templateId || prior.configuration_id !== (body.configurationId ?? null) || prior.contact_json !== JSON.stringify(body.contact) || prior.note !== body.note || prior.features_json !== JSON.stringify(body.features)) return fail(reply, 409, 'Ключ повтору вже використано.');
      return reply.code(200).send(existing);
    }
    let snapshot: string | null = null;
    if (body.configurationId) {
      const configuration = db.prepare('SELECT template_id,data_json FROM configurations WHERE id=? AND owner_id=? AND deleted_at IS NULL').get(body.configurationId, actor.id) as any;
      if (!configuration || configuration.template_id !== body.templateId) return fail(reply, 422, 'Конфігурація не належить цьому макету.');
      snapshot = configuration.data_json;
    }
    const requestId = randomUUID(), conversationId = randomUUID(), timestamp = now();
    db.transaction(() => {
      db.prepare(`INSERT INTO requests(id,customer_id,template_id,template_name,configuration_id,config_snapshot_json,contact_json,note,features_json,client_submission_id,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'submitted',?,?)`).run(requestId, actor.id, body.templateId, body.templateName, body.configurationId ?? null, snapshot, JSON.stringify(body.contact), body.note, JSON.stringify(body.features), body.clientSubmissionId, timestamp, timestamp);
      db.prepare('INSERT INTO conversations(id,request_id,created_at) VALUES (?,?,?)').run(conversationId, requestId, timestamp);
      db.prepare('INSERT INTO request_events(id,request_id,actor_id,old_status,new_status,reason,created_at) VALUES (?,?,?,NULL,?,?,?)').run(randomUUID(), requestId, actor.id, 'submitted', '', timestamp);
    })();
    return reply.code(201).send({ id: requestId, status: 'submitted', conversationId });
  });
  app.get('/api/v1/requests', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor) return;
    const query = parse(page, request.query, reply); if (!query) return;
    const items = db.prepare('SELECT id,template_id templateId,template_name templateName,status,created_at createdAt,updated_at updatedAt FROM requests WHERE customer_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(actor.id, query.limit, query.offset);
    return { items, nextOffset: (items as unknown[]).length === query.limit ? query.offset + query.limit : null };
  });
  app.get('/api/v1/requests/:id', async (request, reply) => {
    const actor = auth(request, reply); if (!actor) return;
    const row = requestRow((request.params as any).id, actor); if (!row) return fail(reply, 404, 'Не знайдено.');
    const events = db.prepare('SELECT old_status oldStatus,new_status newStatus,reason,created_at createdAt FROM request_events WHERE request_id=? ORDER BY created_at').all(row.id);
    return { id: row.id, customerId: row.customer_id, templateId: row.template_id, templateName: row.template_name, status: row.status, statusVersion: row.status_version, configuration: row.config_snapshot_json ? JSON.parse(row.config_snapshot_json) : null, contact: JSON.parse(row.contact_json), note: row.note, features: JSON.parse(row.features_json), conversationId: row.conversation_id, events, createdAt: row.created_at };
  });
  app.get('/api/v1/requests/:id/messages', async (request, reply) => {
    const actor = auth(request, reply); if (!actor) return;
    const row = requestRow((request.params as any).id, actor); if (!row) return fail(reply, 404, 'Не знайдено.');
    const query = parse(z.object({ cursor: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(50).default(50) }), request.query, reply); if (!query) return;
    const items = db.prepare('SELECT id,sender_id senderId,body,created_at createdAt FROM messages WHERE conversation_id=? AND id>? ORDER BY id LIMIT ?').all(row.conversation_id, query.cursor, query.limit + 1) as any[];
    const more = items.length > query.limit;
    if (more) items.pop();
    const reads = db.prepare(`SELECT COALESCE(MAX(CASE WHEN u.role='admin' THEN cr.last_read_message_id END),0) adminRead,
      COALESCE(MAX(CASE WHEN u.id=? THEN cr.last_read_message_id END),0) customerRead
      FROM conversation_reads cr JOIN users u ON u.id=cr.user_id WHERE cr.conversation_id=?`)
      .get(row.customer_id, row.conversation_id) as { adminRead: number; customerRead: number };
    return { items: items.map((message) => ({ ...message, readByRecipient: message.senderId === actor.id ? (actor.role === 'admin' ? reads.customerRead : reads.adminRead) >= message.id : null })), nextCursor: more ? items.at(-1)?.id : null };
  });
  app.post('/api/v1/requests/:id/messages', async (request, reply) => {
    const actor = auth(request, reply); if (!actor || !verified(actor, reply)) return;
    const row = requestRow((request.params as any).id, actor); if (!row) return fail(reply, 404, 'Не знайдено.');
    const body = parse(z.object({ body: z.string().trim().min(1).max(4000), clientMessageId: id }).strict(), request.body, reply); if (!body) return;
    const existing = db.prepare('SELECT id,conversation_id,sender_id senderId,body,created_at createdAt FROM messages WHERE sender_id=? AND client_message_id=?').get(actor.id, body.clientMessageId) as any;
    if (existing) {
      if (existing.conversation_id !== row.conversation_id || existing.body !== body.body) return fail(reply, 409, 'Ключ повтору вже використано.');
      const { conversation_id: _conversationId, ...message } = existing;
      return reply.code(200).send(message);
    }
    if (row.status === 'completed' || row.status === 'cancelled') return fail(reply, 409, 'Діалог завершено.');
    const timestamp = now();
    const result = db.prepare('INSERT INTO messages(conversation_id,sender_id,client_message_id,body,created_at) VALUES (?,?,?,?,?)').run(row.conversation_id, actor.id, body.clientMessageId, body.body, timestamp);
    if (actor.role === 'admin') {
      const customer = db.prepare('SELECT email FROM users WHERE id=?').get(row.customer_id) as { email: string };
      await mail(customer.email, 'Нова відповідь SELTIVO', `Нова відповідь у заявці ${row.id}: ${origin}/account/requests/${row.id}`);
    } else if (teamEmail) {
      await mail(teamEmail, 'Нове повідомлення клієнта SELTIVO', `Нове повідомлення у заявці ${row.id}: ${origin}/admin/requests/${row.id}`);
    }
    return reply.code(201).send({ id: Number(result.lastInsertRowid), senderId: actor.id, body: body.body, createdAt: timestamp });
  });
  app.patch('/api/v1/requests/:id/read', async (request, reply) => {
    const actor = auth(request, reply); if (!actor) return;
    const row = requestRow((request.params as any).id, actor); if (!row) return fail(reply, 404, 'Не знайдено.');
    const body = parse(z.object({ lastSeenMessageId: z.number().int().nonnegative() }).strict(), request.body, reply); if (!body) return;
    if (body.lastSeenMessageId > 0 && !db.prepare('SELECT id FROM messages WHERE id=? AND conversation_id=?').get(body.lastSeenMessageId, row.conversation_id)) return fail(reply, 422, 'Повідомлення не належить діалогу.');
    db.prepare(`INSERT INTO conversation_reads(conversation_id,user_id,last_read_message_id,read_at) VALUES (?,?,?,?)
      ON CONFLICT(conversation_id,user_id) DO UPDATE SET last_read_message_id=MAX(last_read_message_id,excluded.last_read_message_id),read_at=excluded.read_at`)
      .run(row.conversation_id, actor.id, body.lastSeenMessageId, now());
    return reply.code(204).send();
  });
  app.get('/api/v1/notifications/unread-count', async (request, reply) => {
    const actor = auth(request, reply); if (!actor) return;
    const rows = db.prepare(`SELECT r.id requestId,COUNT(m.id) unread FROM requests r
      JOIN conversations c ON c.request_id=r.id
      JOIN messages m ON m.conversation_id=c.id AND m.sender_id<>?
      LEFT JOIN conversation_reads cr ON cr.conversation_id=c.id AND cr.user_id=?
      WHERE (r.customer_id=? OR ?='admin') AND m.id>COALESCE(cr.last_read_message_id,0)
      GROUP BY r.id`).all(actor.id, actor.id, actor.id, actor.role) as { requestId: string; unread: number }[];
    return { total: rows.reduce((sum, row) => sum + row.unread, 0), byRequest: rows };
  });

  app.get('/api/v1/admin/customers', async (request, reply) => {
    if (!auth(request, reply, 'admin')) return;
    const query = parse(page, request.query, reply); if (!query) return;
    const items = db.prepare("SELECT id,email,name,phone,telegram,created_at createdAt FROM users WHERE role='customer' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?").all(query.limit, query.offset);
    return { items, nextOffset: (items as unknown[]).length === query.limit ? query.offset + query.limit : null };
  });
  app.get('/api/v1/admin/customers/:id', async (request, reply) => {
    if (!auth(request, reply, 'admin')) return;
    const row = db.prepare("SELECT id,email,name,phone,telegram,created_at createdAt FROM users WHERE id=? AND role='customer'").get((request.params as any).id);
    if (!row) return fail(reply, 404, 'Не знайдено.');
    return row;
  });
  app.get('/api/v1/admin/requests', async (request, reply) => {
    if (!auth(request, reply, 'admin')) return;
    const query = parse(page.extend({ status: z.enum(statuses).optional() }), request.query, reply); if (!query) return;
    const sql = `SELECT r.id,r.customer_id customerId,u.name customerName,r.template_id templateId,r.template_name templateName,r.status,r.status_version statusVersion,r.created_at createdAt,r.updated_at updatedAt FROM requests r JOIN users u ON u.id=r.customer_id`;
    const items = query.status ? db.prepare(`${sql} WHERE r.status=? ORDER BY r.updated_at DESC,r.id DESC LIMIT ? OFFSET ?`).all(query.status, query.limit, query.offset) : db.prepare(`${sql} ORDER BY r.updated_at DESC,r.id DESC LIMIT ? OFFSET ?`).all(query.limit, query.offset);
    return { items, nextOffset: (items as unknown[]).length === query.limit ? query.offset + query.limit : null };
  });
  app.patch('/api/v1/admin/requests/:id/status', async (request, reply) => {
    const actor = auth(request, reply, 'admin'); if (!actor) return;
    const body = parse(z.object({ status: z.enum(statuses), reason: z.string().trim().max(500).default('') }).strict(), request.body, reply); if (!body) return;
    const version = Number(request.headers['if-match']);
    if (!Number.isInteger(version) || version < 1) return fail(reply, 400, 'Потрібна версія If-Match.');
    const row = db.prepare('SELECT id,status,status_version,customer_id FROM requests WHERE id=?').get((request.params as any).id) as any;
    if (!row) return fail(reply, 404, 'Не знайдено.');
    if (row.status_version !== version || !transitions[row.status as Status].includes(body.status)) return fail(reply, 409, 'Недопустимий перехід або застаріла версія.');
    db.transaction(() => {
      db.prepare('UPDATE requests SET status=?,status_version=status_version+1,updated_at=? WHERE id=?').run(body.status, now(), row.id);
      db.prepare('INSERT INTO request_events(id,request_id,actor_id,old_status,new_status,reason,created_at) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), row.id, actor.id, row.status, body.status, body.reason, now());
      audit(db, actor.id, 'request.status', 'request', row.id);
    })();
    return { id: row.id, status: body.status, statusVersion: version + 1 };
  });
  app.post('/api/v1/admin/requests/:id/reopen', async (request, reply) => {
    const actor = auth(request, reply, 'admin'); if (!actor) return;
    const body = parse(z.object({ reason: z.string().trim().min(3).max(500) }).strict(), request.body, reply); if (!body) return;
    const version = Number(request.headers['if-match']);
    if (!Number.isInteger(version) || version < 1) return fail(reply, 400, 'Потрібна версія If-Match.');
    const row = db.prepare('SELECT id,status,status_version FROM requests WHERE id=?').get((request.params as any).id) as any;
    if (!row) return fail(reply, 404, 'Не знайдено.');
    if (row.status_version !== version || !['completed', 'cancelled'].includes(row.status)) return fail(reply, 409, 'Заявка не завершена або версія застаріла.');
    db.transaction(() => {
      db.prepare("UPDATE requests SET status='reviewing',status_version=status_version+1,updated_at=? WHERE id=?").run(now(), row.id);
      db.prepare('INSERT INTO request_events(id,request_id,actor_id,old_status,new_status,reason,created_at) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), row.id, actor.id, row.status, 'reviewing', body.reason, now());
      audit(db, actor.id, 'request.reopen', 'request', row.id);
    })();
    return { id: row.id, status: 'reviewing', statusVersion: version + 1 };
  });
  app.get('/api/v1/admin/audit', async (request, reply) => {
    if (!auth(request, reply, 'admin')) return;
    return { items: db.prepare('SELECT id,actor_id actorId,action,entity_type entityType,entity_id entityId,created_at createdAt FROM audit_log ORDER BY created_at DESC LIMIT 100').all() };
  });
  return app;
}
