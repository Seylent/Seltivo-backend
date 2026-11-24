import { randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SeltivoDb } from './db.js';
import { actorFromRequest, audit, clearSessionCookie, createSession, hashPassword, hashToken, newAuthToken, newEmailCode, normalizeEmail, now, sessionCookie, sessionTokenFromRequest, verifyPassword, type Actor } from './auth.js';
import { generateRecoveryCodes, generateTotpSecret, matchTotpStep, normalizeRecoveryCode, otpauthUri } from './two-factor.js';
import { trialSnapshot } from './trial.js';
import { createChatEvents } from './chat-events.js';
import { renderEmail } from './emails.js';
import { accountPayloadBytes, defaultDataLimits, exportAccount, type DataLimits } from './data-controls.js';
import { createNotificationDelivery, type Mail } from './notifications.js';

const id = z.uuid();
const email = z.email().max(254);
const password = z.string().min(6).max(200);
const contact = z.object({ name: z.string().trim().min(2).max(60), email: email.optional(), phone: z.string().trim().max(40).optional(), telegram: z.string().trim().max(80).optional() }).strict();
const guestRequest = z.object({
  id,
  name: z.string().trim().min(2).max(60),
  contact: z.string().trim().min(3).max(80),
  features: z.array(z.string().trim().min(1).max(60)).max(5),
  budget: z.string().trim().max(60),
  note: z.string().trim().max(1800),
  templateName: z.string().trim().max(120).optional(),
  trial: trialSnapshot.optional(),
  telegramStatus: z.enum(['sent', 'failed']),
}).strict().refine((data) => data.trial ? Boolean(data.templateName) : data.features.length > 0 || data.note.length > 0, {
  message: 'Додайте хоча б одну функцію або опишіть задачу.',
  path: ['note'],
});
const guestStatuses = ['new', 'in_progress', 'done'] as const;
// Користувач може додати власну функцію прямо у формі (TagInput), тож жорсткий
// enum тут відсікав би валідні заявки з 422 «Перевірте поля запиту».
const feature = z.string().trim().min(1).max(80);
const page = z.object({ offset: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(100).default(50) });
const statuses = ['submitted', 'reviewing', 'needs_info', 'in_progress', 'completed', 'cancelled'] as const;
type Status = typeof statuses[number];
const transitions: Record<Status, Status[]> = {
  submitted: ['reviewing', 'cancelled'], reviewing: ['needs_info', 'in_progress', 'cancelled'],
  needs_info: ['reviewing', 'in_progress', 'cancelled'], in_progress: ['needs_info', 'completed', 'cancelled'],
  completed: [], cancelled: [],
};
const fail = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error });

/** Порівняння sha256-хешів без витоку довжини збігу через час відповіді. */
export function tokenHashesEqual(supplied: string, expected: string): boolean {
  const left = Buffer.from(supplied, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}

export type AppOptions = { db: SeltivoDb; origin: string; secureCookies?: boolean; requireEmailVerification?: boolean; requireAdmin2FA?: boolean; sendMail?: Mail; teamEmail?: string; databaseBytes?: () => number; deleteCustomer?: (userId: string) => Promise<void>; recordRequestDeletion?: (requestId: string) => Promise<void>; selfServiceDeletionEnabled?: boolean; logger?: boolean; router?: FastifyInstance; dataLimits?: Partial<DataLimits> };
const MAX_CONFIGURATIONS_PER_USER = 50;
/** Автовідповідь у чаті, поки менеджер ще не відповів особисто. Мова = мова інтерфейсу клієнта. */
const CHAT_AUTOREPLY = {
  uk: 'Привіт, менеджер скоро відповість вам',
  en: 'Hi! A manager will get back to you shortly',
} as const;
/** За цим префіксом автовідповідь відрізняють від живої відповіді менеджера в звітах. */
const AUTOREPLY_KEY_PREFIX = 'autoreply:';
/** LocaleProvider Next-застосунку зберігає вибрану мову саме в цій cookie. */
const LOCALE_COOKIE = 'seltivo-locale';
const locales = ['uk', 'en'] as const;
type Locale = typeof locales[number];
const isLocale = (value: unknown): value is Locale => typeof value === 'string' && (locales as readonly string[]).includes(value);
function localeFromRequest(request: FastifyRequest): Locale | null {
  const raw = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${LOCALE_COOKIE}=`));
  const value = raw?.slice(LOCALE_COOKIE.length + 1);
  return isLocale(value) ? value : null;
}
/** Пише автовідповідь від першого активного менеджера. Фіксований ключ на заявку дає рівно одне повідомлення. */
function insertChatAutoReply(db: SeltivoDb, conversationId: string, requestId: string, locale: Locale | null, timestamp: string): boolean {
  const key = `${AUTOREPLY_KEY_PREFIX}${requestId}`;
  // Ключ унікальний лише для (sender_id, client_message_id), тож сам INSERT OR IGNORE
  // не захищає від другого привітання, коли перший менеджер став неактивним.
  if (db.prepare('SELECT id FROM messages WHERE conversation_id=? AND client_message_id=?').get(conversationId, key)) return false;
  const sender = db.prepare("SELECT id FROM users WHERE role='admin' AND disabled_at IS NULL ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
  if (!sender) return false;
  return db.prepare('INSERT OR IGNORE INTO messages(conversation_id,sender_id,client_message_id,body,created_at) VALUES (?,?,?,?,?)')
    .run(conversationId, sender.id, key, CHAT_AUTOREPLY[locale ?? 'uk'], timestamp).changes > 0;
}
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SIGNATURE = Buffer.from([255, 216, 255]);

function parse<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(body);
  if (!result.success) { fail(reply, 422, 'Перевірте поля запиту.'); return null; }
  return result.data;
}

function configJson(value: unknown, templateId: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if ('changes' in data || 'trial' in data) {
    const snapshot = trialSnapshot.safeParse('trial' in data ? data.trial : data);
    if (!snapshot.success || snapshot.data.templateId !== templateId) return null;
    if (!('trial' in data)) return JSON.stringify(snapshot.data);
  }
  if (typeof data.name !== 'string' || typeof data.id !== 'string' || !data.colors || !data.hero || !data.home || !Array.isArray(data.products)) return null;
  let images = 0;
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > 30) return false;
    if (typeof node === 'string' && node.startsWith('data:')) {
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(node);
      if (!match || ++images > 30 || match[2].length < 16 || match[2].length > 2_800_000 || match[2].length % 4 !== 0) return false;
      // Перші 16 символів base64 містять рівно 12 байтів заголовка зображення —
      // не декодуємо весь 2 МБ буфер кожного зображення в памʼять.
      const signature = Buffer.from(match[2].slice(0, 16), 'base64');
      return match[1] === 'png' ? signature.subarray(0, 8).equals(PNG_SIGNATURE)
        : match[1] === 'jpeg' ? signature.subarray(0, 3).equals(JPEG_SIGNATURE)
        : signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP';
    }
    if (Array.isArray(node)) return node.every((item) => walk(item, depth + 1));
    if (node && typeof node === 'object') return Object.values(node).every((item) => walk(item, depth + 1));
    return true;
  };
  if (!walk(value, 0)) return null;
  const json = JSON.stringify(value);
  return Buffer.byteLength(json) <= 8 * 1024 * 1024 ? json : null;
}

export function buildApp({ db, origin, secureCookies = false, requireEmailVerification = process.env.SELTIVO_REQUIRE_EMAIL_VERIFICATION === '1', requireAdmin2FA = process.env.SELTIVO_REQUIRE_ADMIN_2FA === '1', sendMail, teamEmail, databaseBytes, deleteCustomer, recordRequestDeletion, selfServiceDeletionEnabled = true, logger = process.env.NODE_ENV !== 'test', router, dataLimits }: AppOptions) {
  // Довіряємо рівно одному проксі: `true` взяв би крайню ліву адресу з
  // X-Forwarded-For, яку клієнт підставляє сам, і обходив би per-IP ліміти.
  const app = router ?? Fastify({ logger, bodyLimit: 9 * 1024 * 1024, trustProxy: process.env.SELTIVO_TRUST_PROXY === '1' ? (_address: string, hop: number) => hop < 1 : false });
  const limits = { ...defaultDataLimits, ...dataLimits };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid data limits');
  const storageAvailable = (reply: FastifyReply) => {
    if (databaseBytes && databaseBytes() >= limits.databaseBytes) {
      fail(reply, 503, 'Сховище тимчасово недоступне. Спробуйте пізніше.');
      return false;
    }
    return true;
  };
  const accountAvailable = (userId: string, addedBytes: number, reply: FastifyReply) => {
    if (addedBytes > 0 && accountPayloadBytes(db, userId) + addedBytes > limits.accountBytes) {
      fail(reply, 422, 'Досягнуто ліміту даних акаунта. Видаліть непотрібні конфігурації або зверніться до підтримки.');
      return false;
    }
    return addedBytes <= 0 || storageAvailable(reply);
  };
  const chatEvents = createChatEvents();
  /** Each entry keeps the window it was recorded with, so staleness pruning uses
   * that key's own window instead of a fixed one. */
  type RateEntry = { times: number[]; windowMs: number };
  const RATE_LIMIT_MAX_KEYS = 10_000;
  const RATE_LIMIT_TRIM_TO = 9_000;
  // Два простори ключів. IP/глобальні ключі контролює атакувальник — вони живуть у
  // пам'яті й можуть витіснятися. Email/export ключі — це блокування й квоти: вони
  // зберігаються в SQLite (лише SHA-256 ключа), тож переживають рестарт Durable Object.
  const attempts = new Map<string, RateEntry>();
  const SENSITIVE_RETENTION_MS = 60 * 60_000;
  const isSensitiveKey = (key: string) => key.startsWith('email:') || key.startsWith('export:');
  /** Reclaims capacity in the IP/global map. Never rejects: every key there is
   * safe to evict, so prune expired entries then drop the oldest until there is room. */
  const makeRoomInGlobal = (current: number) => {
    if (attempts.size < RATE_LIMIT_MAX_KEYS) return;
    for (const [key, entry] of attempts) {
      if (attempts.size <= RATE_LIMIT_TRIM_TO) break;
      if (!entry.times.some((time) => current - time < entry.windowMs)) attempts.delete(key);
    }
    for (const key of attempts.keys()) {
      if (attempts.size < RATE_LIMIT_MAX_KEYS) break;
      attempts.delete(key);
    }
  };
  const recentHits = (key: string, windowMs: number, current: number): number[] => {
    if (!isSensitiveKey(key)) return (attempts.get(key)?.times ?? []).filter((time) => current - time < windowMs);
    if (windowMs > SENSITIVE_RETENTION_MS) throw new Error('Sensitive rate-limit window exceeds retention');
    return (db.prepare('SELECT at FROM rate_limit_hits WHERE key_hash=? AND at>? ORDER BY at').all(hashToken(key), current - windowMs) as { at: number }[])
      .map((row) => Number(row.at));
  };
  const addHit = (key: string, windowMs: number, current: number, recent: number[]) => {
    if (isSensitiveKey(key)) {
      db.prepare('DELETE FROM rate_limit_hits WHERE at<=?').run(current - SENSITIVE_RETENTION_MS);
      db.prepare('INSERT INTO rate_limit_hits(key_hash,at) VALUES (?,?)').run(hashToken(key), current);
      return;
    }
    if (!attempts.has(key)) makeRoomInGlobal(current);
    attempts.set(key, { times: [...recent, current], windowMs });
  };
  const clearRateLimit = (key: string) => {
    if (isSensitiveKey(key)) db.prepare('DELETE FROM rate_limit_hits WHERE key_hash=?').run(hashToken(key));
    else attempts.delete(key);
  };
  const checkRateLimit = (key: string, windowMs: number, max: number, reply: FastifyReply, record = true): boolean => {
    const current = Date.now();
    const recent = recentHits(key, windowMs, current);
    if (recent.length >= max) {
      reply.header('Retry-After', String(Math.max(1, Math.ceil((windowMs - (current - recent[0])) / 1000))));
      fail(reply, 429, 'Забагато запитів. Спробуйте пізніше.');
      return false;
    }
    if (record) addHit(key, windowMs, current, recent);
    else if (!isSensitiveKey(key)) {
      if (recent.length) attempts.set(key, { times: recent, windowMs });
      else attempts.delete(key);
    }
    return true;
  };
  const recordAttempt = (key: string, windowMs: number) => {
    const current = Date.now();
    addHit(key, windowMs, current, recentHits(key, windowMs, current));
  };
  const rateLimitBucket = (method: string, rawPath: string): { bucket: string; windowMs: number; max: number } | null => {
    const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;
    // Адмінські запити змінюють статуси заявок і запускають відправку листів —
    // окремий спільний ліміт, інакше retry-ендпоінт можна закидати листами.
    if (path.startsWith('/api/v1/admin/') && ['POST', 'PATCH', 'DELETE'].includes(method)) {
      return { bucket: 'WRITE:/api/v1/admin', windowMs: 60_000, max: 30 };
    }
    if (method === 'POST') {
      if (path === '/api/v1/auth/register' || path === '/api/v1/auth/forgot-password' || path === '/api/v1/auth/resend-verification') {
        return { bucket: `POST:${path}`, windowMs: 15 * 60_000, max: 5 };
      }
      if (path.startsWith('/api/v1/auth/')) return { bucket: `POST:${path}`, windowMs: 60_000, max: 10 };
      if (path === '/api/v1/guest-requests') return { bucket: 'POST:/api/v1/guest-requests', windowMs: 15 * 60_000, max: 20 };
      if (path === '/api/v1/requests') return { bucket: 'POST:/api/v1/requests', windowMs: 10 * 60_000, max: 5 };
      if (path === '/api/v1/configurations') return { bucket: 'WRITE:/api/v1/configurations', windowMs: 10 * 60_000, max: 20 };
      if (/^\/api\/v1\/requests\/[^/]+\/messages$/.test(path) || path.includes('/messages')) {
        return { bucket: 'POST:/api/v1/requests/:id/messages', windowMs: 60_000, max: 30 };
      }
    }
    if (method === 'PATCH') {
      if (/^\/api\/v1\/configurations\/[^/]+$/.test(path)) return { bucket: 'WRITE:/api/v1/configurations', windowMs: 10 * 60_000, max: 20 };
      if (path === '/api/v1/me') return { bucket: 'PATCH:/api/v1/me', windowMs: 60_000, max: 20 };
    }
    if (method === 'DELETE' && path === '/api/v1/me') return { bucket: 'DELETE:/api/v1/me', windowMs: 60_000, max: 10 };
    // GET дешеві, але необмежені читання (зокрема diagnostics з quick_check)
    // дозволяють зайняти єдиний Durable Object. Загальний м'який ліміт на IP.
    if (method === 'GET' || method === 'HEAD') return { bucket: 'READ:global', windowMs: 60_000, max: 120 };
    return null;
  };
  const unreadCache = new Map<string, { value: unknown; expires: number }>();
  const mail = async (to: string, subject: string, text: string, html?: string) => {
    if (!sendMail) return false;
    try { await sendMail(to, subject, text, html); return true; } catch { app.log.error({ event: 'email_delivery_failed', kind: 'auth' }); return false; }
  };
  const deliverNotification = createNotificationDelivery({ db, origin, sendMail, log: (entry) => app.log.error(entry) }).deliver;
  type TwoFactorRow = { secret: string; enabled_at: string | null; recovery_codes: string };
  const twoFactorRow = (userId: string) => db.prepare('SELECT secret,enabled_at,recovery_codes FROM admin_two_factor WHERE user_id=?').get(userId) as TwoFactorRow | undefined;
  const consumeRecoveryCode = (codesJson: string, code: string) => {
    let codes: string[];
    try { codes = JSON.parse(codesJson) as string[]; } catch { return null; }
    if (!Array.isArray(codes)) return null;
    const target = hashToken(normalizeRecoveryCode(code));
    const index = codes.indexOf(target);
    if (index < 0) return null;
    codes.splice(index, 1);
    return JSON.stringify(codes);
  };
  // RFC 6238 §5.2: прийнятий код не можна використати вдруге. Кроки зростають
  // монотонно, тож зберігаємо останній прийнятий крок у БД (переживає рестарт
  // Durable Object), а умовний UPDATE робить перевірку атомарною.
  const acceptTotp = (userId: string, code: string, secret: string) => {
    const step = matchTotpStep(code, secret);
    if (step === null) return false;
    return db.prepare('UPDATE admin_two_factor SET last_totp_step=? WHERE user_id=? AND (last_totp_step IS NULL OR last_totp_step<?)')
      .run(step, userId, step).changes > 0;
  };
  const recoveryRemaining = (codesJson: string) => {
    try {
      const value = JSON.parse(codesJson);
      return Array.isArray(value) ? value.length : 0;
    } catch { return 0; }
  };
  const auth = (request: FastifyRequest, reply: FastifyReply, role?: 'customer' | 'admin') => {
    const actor = actorFromRequest(db, request);
    if (!actor) { fail(reply, 401, 'Увійдіть до акаунта.'); return null; }
    if (role && actor.role !== role) { fail(reply, 403, 'Недостатньо прав.'); return null; }
    if (requireEmailVerification && actor.role === 'customer' && !actor.email_verified_at) { fail(reply, 403, 'Підтвердьте email кодом із листа.'); return null; }
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
    // Шаблон маршруту (`/api/v1/requests/:id/messages`), а не сирий URL: router
    // декодує percent-encoding, тож `/guest-request%73` інакше відкривав би новий bucket.
    const rawPath = request.routeOptions?.url ?? request.url.split('?')[0];
    const limit = rateLimitBucket(request.method, rawPath);
    if (limit) {
      checkRateLimit(`${request.ip}:${limit.bucket}`, limit.windowMs, limit.max, reply);
    }
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Vary', 'Origin, Cookie');
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    if (typeof error === 'object' && error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return fail(reply, error.statusCode, error.statusCode === 413 ? 'Запит завеликий.' : 'Невірний формат запиту.');
    }
    app.log.error({
      event: 'api_error',
      method: request.method,
      path: request.url.split('?')[0],
      errorType: error instanceof Error ? error.name : 'unknown',
    });
    return fail(reply, 500, 'Помилка сервера.');
  });
  let healthCache = { ok: true, checkedAt: 0 };
  // quick_check і foreign_key_check проходять усю базу й блокують єдиний Durable
  // Object. Дашборд показує результат не старший за 5 хв; diagnostics завжди свіжий.
  let integrityCache: { integrity: unknown; foreignKeyViolations: number; checkedAt: number } | null = null;
  const integrityReport = (fresh: boolean) => {
    if (fresh || !integrityCache || Date.now() - integrityCache.checkedAt > 5 * 60_000) {
      integrityCache = {
        integrity: db.pragma('quick_check', { simple: true }),
        foreignKeyViolations: (db.pragma('foreign_key_check') as unknown[]).length,
        checkedAt: Date.now(),
      };
    }
    return integrityCache;
  };
  app.get('/api/v1/health', async () => {
    // quick_check на великій базі недешевий, а endpoint публічний: кешуємо результат,
    // щоб запитами не можна було зайняти єдиний Durable Object.
    if (Date.now() - healthCache.checkedAt > 30_000) {
      healthCache = { ok: db.pragma('quick_check', { simple: true }) === 'ok', checkedAt: Date.now() };
    }
    return { ok: healthCache.ok };
  });

  app.post('/api/v1/auth/register', async (request, reply) => {
    const body = parse(z.object({ email, password, name: z.string().trim().min(2).max(80) }).strict(), request.body, reply);
    if (!body) return;
    const normalized = normalizeEmail(body.email);
    if (db.prepare('SELECT id FROM users WHERE email=?').get(normalized)) return fail(reply, 409, 'Акаунт із цим email уже існує.');
    const userId = randomUUID();
    const timestamp = now();
    const hash = await hashPassword(body.password);
    const verifiedAt = requireEmailVerification ? null : timestamp;
    try {
      db.prepare(`INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'customer',?,?,?,?)`)
        .run(userId, normalized, hash, body.name, verifiedAt, timestamp, timestamp);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed: users.email')) return fail(reply, 409, 'Акаунт із цим email уже існує.');
      throw error;
    }
    if (requireEmailVerification && sendMail) {
      const code = newEmailCode(db, userId);
      const message = renderEmail('verification', { origin, code }, localeFromRequest(request));
      await mail(normalized, message.subject, message.text, message.html);
    }
    return reply.code(201).send({ id: userId, verificationRequired: requireEmailVerification });
  });
  app.post('/api/v1/auth/resend-verification', async (request, reply) => {
    const body = parse(z.object({ email }).strict(), request.body, reply);
    if (!body) return;
    const normalized = normalizeEmail(body.email);
    // Per-account ліміт: per-IP легко обійти ротацією адрес. Лічимо незалежно
    // від існування акаунта, щоб відповідь не розкривала, чи email зареєстрований.
    const limitKey = `email:resend:${normalized}`;
    if (!checkRateLimit(limitKey, 15 * 60_000, 5, reply, false)) return;
    recordAttempt(limitKey, 15 * 60_000);
    const user = db.prepare('SELECT id,email,email_verified_at FROM users WHERE email=? AND disabled_at IS NULL').get(normalized) as any;
    if (user && !user.email_verified_at && sendMail) {
      const code = newEmailCode(db, user.id);
      const message = renderEmail('verification', { origin, code }, localeFromRequest(request));
      await mail(user.email, message.subject, message.text, message.html);
    }
    return reply.code(202).send({ ok: true });
  });
  app.post('/api/v1/auth/verify-email', async (request, reply) => {
    const body = parse(z.union([
      z.object({ email, code: z.string().regex(/^\d{6}$/) }).strict(),
      z.object({ token: z.string().min(20).max(100) }).strict(),
    ]), request.body, reply);
    if (!body) return;
    let row: { user_id: string; token_hash: string } | undefined;
    if ('code' in body) {
      const normalized = normalizeEmail(body.email);
      const user = db.prepare("SELECT id FROM users WHERE email=? AND role='customer' AND disabled_at IS NULL AND email_verified_at IS NULL").get(normalized) as { id: string } | undefined;
      const token = user && db.prepare("SELECT token_hash,attempts FROM auth_tokens WHERE user_id=? AND purpose='verify' AND expires_at>?").get(user.id, now()) as { token_hash: string; attempts: number } | undefined;
      if (token && token.attempts >= 5) return fail(reply, 429, 'Забагато спроб. Запросіть новий код.');
      if (token) {
        const supplied = hashToken(`${user!.id}:${body.code}`);
        if (tokenHashesEqual(supplied, token.token_hash)) row = { user_id: user!.id, token_hash: token.token_hash };
        else db.prepare('UPDATE auth_tokens SET attempts=attempts+1 WHERE token_hash=?').run(token.token_hash);
      }
    } else {
      row = db.prepare(`SELECT t.user_id,t.token_hash FROM auth_tokens t JOIN users u ON u.id=t.user_id
        WHERE t.token_hash=? AND t.purpose='verify' AND t.expires_at>? AND u.role='customer' AND u.disabled_at IS NULL`)
        .get(hashToken(body.token), now()) as typeof row;
    }
    if (!row) return fail(reply, 422, 'Код недійсний або прострочений.');
    db.transaction(() => {
      db.prepare('UPDATE users SET email_verified_at=?,updated_at=? WHERE id=?').run(now(), now(), row.user_id);
      db.prepare("DELETE FROM auth_tokens WHERE user_id=? AND purpose='verify'").run(row.user_id);
    })();
    // The one-time verification secret proves email ownership. Customer sessions
    // are issued here so the browser never needs to persist the account password.
    const customer = db.prepare("SELECT id FROM users WHERE id=? AND role='customer' AND disabled_at IS NULL").get(row.user_id) as { id: string } | undefined;
    if (customer) reply.header('Set-Cookie', sessionCookie(createSession(db, customer.id, false, 'customer'), secureCookies, false, 'customer'));
    return { ok: true };
  });
  // Гостьові заявки з публічних форм: зберігаємо копію для адмінки.
  // Next-route спочатку зберігає заявку, потім оновлює результат доставки.
  app.post('/api/v1/guest-requests', async (request, reply) => {
    const body = parse(guestRequest, request.body, reply); if (!body) return;
    const trial = body.trial ? JSON.stringify(body.trial) : null;
    const features = JSON.stringify(body.features);
    if (!db.prepare('SELECT id FROM guest_requests WHERE id=?').get(body.id)) {
      const usage = db.prepare("SELECT COUNT(*) count,COALESCE(SUM(length(CAST(name || contact || features_json || budget || note || COALESCE(trial_json,'') AS BLOB))),0) bytes FROM guest_requests").get() as { count: number; bytes: number };
      if (usage.count >= limits.guestRequests || usage.bytes + Buffer.byteLength(JSON.stringify(body)) > limits.guestBytes) return fail(reply, 503, 'Сховище заявок тимчасово заповнене. Спробуйте пізніше.');
      if (!storageAvailable(reply)) return;
    }
    const stored = db.prepare(`INSERT OR IGNORE INTO guest_requests
      (id,name,contact,features_json,budget,note,template_name,telegram_status,status,created_at,trial_json)
      VALUES (?,?,?,?,?,?,?,?,'new',?,?)`)
      .run(body.id, body.name, body.contact, features, body.budget, body.note,
        body.templateName ?? null, body.telegramStatus, now(), trial);
    if (!stored.changes) {
      const same = db.prepare(`SELECT id FROM guest_requests WHERE id=? AND name=? AND contact=? AND features_json=?
        AND budget=? AND note=? AND template_name IS ? AND trial_json IS ?`)
        .get(body.id, body.name, body.contact, features, body.budget, body.note, body.templateName ?? null, trial);
      if (!same) return fail(reply, 409, 'Ключ повтору вже використано.');
      // Повтор із відомим id може лише закрити невдалу доставку; уже 'sent' не перезаписуємо.
      // Решта полів не змінюється — вони вже звірені запитом same вище.
      if (body.telegramStatus === 'sent') db.prepare("UPDATE guest_requests SET telegram_status='sent' WHERE id=? AND telegram_status='failed'").run(body.id);
    }
    if (stored.changes) chatEvents.publish('', { kind: 'request', requestId: body.id });
    return reply.code(stored.changes ? 201 : 200).send({ id: body.id });
  });
  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = parse(z.object({ email, password: z.string().max(200), rememberMe: z.boolean().optional(), code: z.string().trim().max(32).optional() }).strict(), request.body, reply);
    if (!body) return;
    const normalized = normalizeEmail(body.email);
    const emailLimitKey = `email:login:${normalized}`;
    if (!checkRateLimit(emailLimitKey, 15 * 60_000, 10, reply, false)) return;
    const user = db.prepare('SELECT id,email,password_hash,role,name,email_verified_at FROM users WHERE email=? AND disabled_at IS NULL').get(normalized) as any;
    if (!await verifyPassword(body.password, user?.password_hash) || !user) {
      recordAttempt(emailLimitKey, 15 * 60_000);
      return fail(reply, 401, 'Невірний email або пароль.');
    }
    if (requireEmailVerification && user.role === 'customer' && !user.email_verified_at) {
      const pending = db.prepare("SELECT 1 FROM auth_tokens WHERE user_id=? AND purpose='verify' AND expires_at>?").get(user.id, now());
      if (!pending) {
        const limitKey = `email:resend:${normalized}`;
        if (!checkRateLimit(limitKey, 15 * 60_000, 5, reply, false)) return;
        recordAttempt(limitKey, 15 * 60_000);
        const verificationCode = newEmailCode(db, user.id);
        const message = renderEmail('verification', { origin, code: verificationCode }, localeFromRequest(request));
        const sent = await mail(user.email, message.subject, message.text, message.html);
        if (!sent) return fail(reply, 503, 'Не вдалося надіслати код. Спробуйте ще раз на сторінці підтвердження.');
      }
      return fail(reply, 403, 'Підтвердьте email кодом із листа. Якщо листа немає, надішліть код ще раз.');
    }
    let recoveryConsumption: { expected: string; remaining: string } | null = null;
    if (user.role === 'admin') {
      const factor = twoFactorRow(user.id);
      if (factor?.enabled_at) {
        if (!body.code) return reply.code(428).send({ error: 'Введіть код з застосунку авторизації.', twoFactorRequired: true });
        const code = body.code.trim();
        const remaining = /^[A-Za-z0-9-]{8,20}$/.test(code) ? consumeRecoveryCode(factor.recovery_codes, code) : null;
        if (remaining === null && !acceptTotp(user.id, code, factor.secret)) {
          recordAttempt(emailLimitKey, 15 * 60_000);
          return fail(reply, 401, 'Невірний email або пароль.');
        }
        if (remaining !== null) recoveryConsumption = { expected: factor.recovery_codes, remaining };
      } else if (requireAdmin2FA) {
        return reply.code(403).send({ error: 'Для адміністратора потрібно увімкнути двофакторну авторизацію.', twoFactorEnrollmentRequired: true });
      }
    }
    clearRateLimit(emailLimitKey);
    let token: string;
    try {
      token = db.transaction(() => {
        const previous = sessionTokenFromRequest(request);
        if (previous) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(previous));
        if (recoveryConsumption) {
          const consumed = db.prepare('UPDATE admin_two_factor SET recovery_codes=? WHERE user_id=? AND recovery_codes=?')
            .run(recoveryConsumption.remaining, user.id, recoveryConsumption.expected);
          if (!consumed.changes) throw new Error('RECOVERY_CODE_CONSUMED');
        }
        return createSession(db, user.id, body.rememberMe, user.role);
      })();
    } catch (error) {
      if (error instanceof Error && error.message === 'RECOVERY_CODE_CONSUMED') {
        recordAttempt(emailLimitKey, 15 * 60_000);
        return fail(reply, 401, 'Невірний email або пароль.');
      }
      throw error;
    }
    if (user.role === 'admin') audit(db, user.id, 'auth.login', 'user', user.id);
    reply.header('Set-Cookie', sessionCookie(token, secureCookies, body.rememberMe, user.role));
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role, emailVerified: Boolean(user.email_verified_at) } };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const token = sessionTokenFromRequest(request);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
    reply.header('Set-Cookie', clearSessionCookie(secureCookies));
    return reply.code(204).send();
  });
  app.get('/api/v1/auth/2fa/status', async (request, reply) => {
    const actor = auth(request, reply, 'admin'); if (!actor) return;
    const factor = twoFactorRow(actor.id);
    return {
      enabled: Boolean(factor?.enabled_at),
      pending: Boolean(factor && !factor.enabled_at),
      recoveryCodesRemaining: factor ? recoveryRemaining(factor.recovery_codes) : 0,
    };
  });
  app.post('/api/v1/auth/2fa/setup', async (request, reply) => {
    const actor = auth(request, reply, 'admin'); if (!actor) return;
    const body = parse(z.object({ password: z.string().max(200) }).strict(), request.body, reply); if (!body) return;
    const limitKey = `2fa:setup:${actor.id}`;
    if (!checkRateLimit(limitKey, 15 * 60_000, 5, reply, false)) return;
    const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(actor.id) as { password_hash: string } | undefined;
    if (!await verifyPassword(body.password, user?.password_hash)) {
      recordAttempt(limitKey, 15 * 60_000);
      return fail(reply, 401, 'Невірний пароль.');
    }
    if (twoFactorRow(actor.id)?.enabled_at) return fail(reply, 409, '2FA вже увімкнено.');
    const secret = generateTotpSecret();
    const recoveryCodes = generateRecoveryCodes();
    const hashes = JSON.stringify(recoveryCodes.map((code) => hashToken(normalizeRecoveryCode(code))));
    db.prepare(`INSERT INTO admin_two_factor(user_id,secret,enabled_at,recovery_codes) VALUES (?,?,NULL,?)
      ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret,recovery_codes=excluded.recovery_codes,enabled_at=NULL,last_totp_step=NULL`)
      .run(actor.id, secret, hashes);
    audit(db, actor.id, 'auth.2fa.setup', 'user', actor.id);
    return { secret, uri: otpauthUri(secret, actor.email), recoveryCodes };
  });
  app.post('/api/v1/auth/2fa/enable', async (request, reply) => {
    const actor = auth(request, reply, 'admin'); if (!actor) return;
    const body = parse(z.object({ code: z.string().trim().regex(/^\d{6}$/) }).strict(), request.body, reply); if (!body) return;
    const limitKey = `2fa:enable:${actor.id}`;
    if (!checkRateLimit(limitKey, 15 * 60_000, 5, reply, false)) return;
    const factor = twoFactorRow(actor.id);
    if (!factor || factor.enabled_at) return fail(reply, 409, 'Спочатку налаштуйте 2FA.');
    if (!acceptTotp(actor.id, body.code, factor.secret)) {
      recordAttempt(limitKey, 15 * 60_000);
      return fail(reply, 422, 'Невірний код.');
    }
    const result = db.prepare('UPDATE admin_two_factor SET enabled_at=? WHERE user_id=? AND enabled_at IS NULL').run(now(), actor.id);
    if (!result.changes) return fail(reply, 409, '2FA вже увімкнено.');
    audit(db, actor.id, 'auth.2fa.enable', 'user', actor.id);
    return { ok: true };
  });
  app.post('/api/v1/auth/2fa/disable', async (request, reply) => {
    const actor = auth(request, reply, 'admin'); if (!actor) return;
    const body = parse(z.object({ password: z.string().max(200), code: z.string().trim().max(32) }).strict(), request.body, reply); if (!body) return;
    const limitKey = `2fa:disable:${actor.id}`;
    if (!checkRateLimit(limitKey, 15 * 60_000, 5, reply, false)) return;
    const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(actor.id) as { password_hash: string } | undefined;
    if (!await verifyPassword(body.password, user?.password_hash)) {
      recordAttempt(limitKey, 15 * 60_000);
      return fail(reply, 401, 'Невірний пароль.');
    }
    const factor = twoFactorRow(actor.id);
    if (!factor?.enabled_at) return fail(reply, 409, '2FA не увімкнено.');
    const code = body.code.trim();
    const remaining = /^[A-Za-z0-9-]{8,20}$/.test(code) ? consumeRecoveryCode(factor.recovery_codes, code) : null;
    if (remaining === null && !acceptTotp(actor.id, code, factor.secret)) {
      recordAttempt(limitKey, 15 * 60_000);
      return fail(reply, 422, 'Невірний код.');
    }
    db.prepare('DELETE FROM admin_two_factor WHERE user_id=?').run(actor.id);
    audit(db, actor.id, 'auth.2fa.disable', 'user', actor.id);
    return { ok: true };
  });
  app.post('/api/v1/auth/forgot-password', async (request, reply) => {
    const body = parse(z.object({ email }).strict(), request.body, reply);
    if (!body) return;
    const normalized = normalizeEmail(body.email);
    // Per-account ліміт: інакше ботнет із різних IP закидає одну пошту листами.
    // Лічимо до перевірки існування акаунта — відповідь лишається 202 завжди.
    const limitKey = `email:forgot:${normalized}`;
    if (!checkRateLimit(limitKey, 15 * 60_000, 5, reply, false)) return;
    recordAttempt(limitKey, 15 * 60_000);
    const user = db.prepare('SELECT id,email FROM users WHERE email=? AND disabled_at IS NULL').get(normalized) as any;
    if (user && sendMail) {
      const token = newAuthToken(db, user.id, 'reset', 30 * 60 * 1000);
      const message = renderEmail('reset-password', { origin, url: `${origin}/reset-password?token=${token}` }, localeFromRequest(request));
      await mail(user.email, message.subject, message.text, message.html);
    } else if (user) app.log.error({ event: 'email_delivery_failed', kind: 'auth', code: 'mail_not_configured' });
    return reply.code(202).send({ ok: true });
  });
  app.post('/api/v1/auth/reset-password', async (request, reply) => {
    const body = parse(z.object({ token: z.string().min(20).max(100), password }).strict(), request.body, reply);
    if (!body) return;
    const tokenHash = hashToken(body.token);
    const row = db.prepare("SELECT user_id FROM auth_tokens WHERE token_hash=? AND purpose='reset' AND expires_at>?").get(tokenHash, now()) as { user_id: string } | undefined;
    if (!row) return fail(reply, 422, 'Посилання недійсне або прострочене.');
    const hash = await hashPassword(body.password);
    // Під час хешування паралельний запит міг уже використати цей самий токен:
    // споживаємо його атомарно в транзакції, а не покладаємося на SELECT вище.
    const consumed = db.transaction(() => {
      const removed = db.prepare("DELETE FROM auth_tokens WHERE token_hash=? AND purpose='reset' AND expires_at>?").run(tokenHash, now());
      if (!removed.changes) return false;
      db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(hash, now(), row.user_id);
      db.prepare('DELETE FROM auth_tokens WHERE user_id=?').run(row.user_id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);
      return true;
    })();
    if (!consumed) return fail(reply, 422, 'Посилання недійсне або прострочене.');
    return { ok: true };
  });
  app.get('/api/v1/me', async (request, reply) => {
    const actor = auth(request, reply); if (!actor) return;
    const row = db.prepare('SELECT id,email,role,name,phone,telegram,locale,email_verified_at FROM users WHERE id=?').get(actor.id) as any;
    return { id: row.id, email: row.email, role: row.role, name: row.name, phone: row.phone, telegram: row.telegram, locale: row.locale,
      emailVerified: Boolean(row.email_verified_at), accountDeletionAvailable: actor.role === 'customer' && Boolean(deleteCustomer) && selfServiceDeletionEnabled };
  });
  app.patch('/api/v1/me', async (request, reply) => {
    const actor = auth(request, reply); if (!actor) return;
    const body = parse(z.object({ name: z.string().trim().min(2).max(80), phone: z.string().trim().max(40).nullable(), telegram: z.string().trim().max(80).nullable() }).strict(), request.body, reply);
    if (!body) return;
    db.prepare('UPDATE users SET name=?,phone=?,telegram=?,updated_at=? WHERE id=?').run(body.name, body.phone, body.telegram, now(), actor.id);
    return { ok: true };
  });
  app.delete('/api/v1/me', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor) return;
    if (!deleteCustomer || !selfServiceDeletionEnabled) return fail(reply, 503, 'Видалення акаунта тимчасово недоступне.');
    const body = parse(z.object({ password: z.string().min(1).max(200) }).strict(), request.body, reply); if (!body) return;
    const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(actor.id) as { password_hash: string };
    if (!await verifyPassword(body.password, row.password_hash)) return fail(reply, 401, 'Невірний пароль.');
    await deleteCustomer(actor.id);
    unreadCache.clear();
    reply.header('Set-Cookie', clearSessionCookie(secureCookies));
    return reply.code(204).send();
  });
  app.post('/api/v1/auth/change-password', async (request, reply) => {
    const actor = auth(request, reply); if (!actor) return;
    const body = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: password }).strict(), request.body, reply);
    if (!body) return;
    const row = db.prepare('SELECT password_hash FROM users WHERE id=?').get(actor.id) as { password_hash: string };
    if (!await verifyPassword(body.currentPassword, row.password_hash)) return fail(reply, 401, 'Невірний поточний пароль.');
    if (body.currentPassword === body.newPassword) return fail(reply, 422, 'Новий пароль має відрізнятися.');
    const hash = await hashPassword(body.newPassword);
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(hash, now(), actor.id);
      db.prepare("DELETE FROM auth_tokens WHERE user_id=? AND purpose='reset'").run(actor.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(actor.id);
    })();
    reply.header('Set-Cookie', clearSessionCookie(secureCookies));
    return { ok: true };
  });

  const configBody = z.object({ templateId: z.string().regex(/^[a-z0-9-]{1,60}$/), name: z.string().trim().min(1).max(80), data: z.unknown() }).strict();
  app.get('/api/v1/me/export', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor) return;
    if (!checkRateLimit(`export:${actor.id}`, 60 * 60_000, 3, reply)) return;
    const exported = exportAccount(db, actor.id);
    audit(db, actor.id, 'account.exported', 'user', actor.id);
    return reply.header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="seltivo-account.json"')
      .header('Cache-Control', 'private, no-store').send(exported);
  });
  app.get('/api/v1/configurations', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor) return;
    const query = parse(page, request.query, reply); if (!query) return;
    const items = db.prepare('SELECT id,template_id templateId,name,revision,created_at createdAt,updated_at updatedAt FROM configurations WHERE owner_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?').all(actor.id, query.limit, query.offset);
    return { items, nextOffset: (items as unknown[]).length === query.limit ? query.offset + query.limit : null };
  });
  app.post('/api/v1/configurations', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor || !verified(actor, reply)) return;
    const body = parse(configBody, request.body, reply); if (!body) return;
    const activeCount = (db.prepare('SELECT COUNT(*) AS count FROM configurations WHERE owner_id=? AND deleted_at IS NULL').get(actor.id) as { count: number }).count;
    if (activeCount >= MAX_CONFIGURATIONS_PER_USER) return fail(reply, 422, 'Досягнуто ліміту збережених конфігурацій.');
    const json = configJson(body.data, body.templateId); if (!json) return fail(reply, 422, 'Конфігурація завелика або пошкоджена.');
    if (!accountAvailable(actor.id, Buffer.byteLength(json), reply)) return;
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
    const revision = Number(request.headers['if-match']);
    if (!Number.isInteger(revision) || revision < 1) return fail(reply, 400, 'Потрібна версія If-Match.');
    const configId = (request.params as { id: string }).id;
    const existing = db.prepare('SELECT template_id,length(CAST(data_json AS BLOB)) bytes FROM configurations WHERE id=? AND owner_id=? AND deleted_at IS NULL').get(configId, actor.id) as { template_id: string; bytes: number } | undefined;
    if (!existing) return fail(reply, 404, 'Не знайдено.');
    const json = configJson(body.data, existing.template_id); if (!json) return fail(reply, 422, 'Конфігурація завелика або пошкоджена.');
    if (!accountAvailable(actor.id, Buffer.byteLength(json) - existing.bytes, reply)) return;
    const result = db.prepare('UPDATE configurations SET name=?,data_json=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND deleted_at IS NULL')
      .run(body.name, json, now(), configId, actor.id, revision);
    if (!result.changes) return fail(reply, 409, 'Конфігурацію змінено або не знайдено.');
    return { id: configId, revision: revision + 1 };
  });
  app.delete('/api/v1/configurations/:id', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor) return;
    // Заявки зберігають власний config_snapshot_json, тому звільняємо data_json при приховуванні.
    const result = db.prepare("UPDATE configurations SET data_json='{}',deleted_at=? WHERE id=? AND owner_id=? AND deleted_at IS NULL").run(now(), (request.params as any).id, actor.id);
    if (!result.changes) return fail(reply, 404, 'Не знайдено.');
    return reply.code(204).send();
  });

  const requestBody = z.object({ templateId: z.string().regex(/^[a-z0-9-]{1,60}$/), templateName: z.string().trim().min(1).max(80), configurationId: id.nullable().optional(), configurationRevision: z.number().int().positive().optional(), contact, note: z.string().trim().max(2000).default(''), features: z.array(feature).max(12).default([]), clientSubmissionId: id }).strict();
  app.post('/api/v1/requests', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor || !verified(actor, reply)) return;
    const body = parse(requestBody, request.body, reply); if (!body) return;
    const existing = db.prepare('SELECT r.id,r.status,c.id conversationId FROM requests r JOIN conversations c ON c.request_id=r.id WHERE r.customer_id=? AND r.client_submission_id=?').get(actor.id, body.clientSubmissionId);
    if (existing) {
      const prior = db.prepare('SELECT template_id,template_name,configuration_id,contact_json,note,features_json FROM requests WHERE id=?').get((existing as any).id) as any;
      if (prior.template_id !== body.templateId || prior.template_name !== body.templateName || prior.configuration_id !== (body.configurationId ?? null) || prior.contact_json !== JSON.stringify(body.contact) || prior.note !== body.note || prior.features_json !== JSON.stringify(body.features)) return fail(reply, 409, 'Ключ повтору вже використано.');
      return reply.code(200).send(existing);
    }
    let snapshot: string | null = null;
    if (body.configurationId) {
      const configuration = db.prepare('SELECT template_id,data_json,revision FROM configurations WHERE id=? AND owner_id=? AND deleted_at IS NULL')
        .get(body.configurationId, actor.id) as { template_id: string; data_json: string; revision: number } | undefined;
      if (!configuration || configuration.template_id !== body.templateId) return fail(reply, 422, 'Конфігурація не належить цьому макету.');
      if (body.configurationRevision !== undefined && configuration.revision !== body.configurationRevision) {
        return fail(reply, 409, 'Конфігурацію змінено. Відкрийте її ще раз.');
      }
      snapshot = configuration.data_json;
    }
    const count = (db.prepare('SELECT COUNT(*) count FROM requests WHERE customer_id=?').get(actor.id) as { count: number }).count;
    if (count >= limits.requestsPerAccount) return fail(reply, 422, 'Досягнуто ліміту заявок акаунта. Зверніться до підтримки.');
    const requestBytes = Buffer.byteLength((snapshot ?? '') + JSON.stringify(body.contact) + body.note + JSON.stringify(body.features));
    if (!accountAvailable(actor.id, requestBytes + 128, reply)) return;
    const requestId = randomUUID(), conversationId = randomUUID(), timestamp = now();
    // Мова клієнта = мова його інтерфейсу (cookie), інакше останнє збережене значення.
    // Зберігаємо її одразу, щоб вітальне повідомлення було тією ж мовою.
    const cookieLocale = localeFromRequest(request);
    const savedLocale = (db.prepare('SELECT locale FROM users WHERE id=?').get(actor.id) as { locale: string | null } | undefined)?.locale;
    const locale: Locale | null = cookieLocale ?? (isLocale(savedLocale) ? savedLocale : null);
    if (cookieLocale) db.prepare('UPDATE users SET locale=? WHERE id=?').run(cookieLocale, actor.id);
    const greeted = db.transaction(() => {
      db.prepare(`INSERT INTO requests(id,customer_id,template_id,template_name,configuration_id,config_snapshot_json,contact_json,note,features_json,client_submission_id,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'submitted',?,?)`).run(requestId, actor.id, body.templateId, body.templateName, body.configurationId ?? null, snapshot, JSON.stringify(body.contact), body.note, JSON.stringify(body.features), body.clientSubmissionId, timestamp, timestamp);
      db.prepare('INSERT INTO conversations(id,request_id,created_at) VALUES (?,?,?)').run(conversationId, requestId, timestamp);
      // Перше повідомлення в чаті з'являється одразу після створення заявки —
      // клієнту не потрібно спочатку писати першому, щоб побачити відповідь.
      const inserted = insertChatAutoReply(db, conversationId, requestId, locale, timestamp);
      // Автовідповідь — це непрочитане вхідне повідомлення для клієнта,
      // тож вона має з'являтися і в дзвіночку, а не тільки в лічильнику чату.
      if (inserted) db.prepare('INSERT INTO notifications(id,recipient_id,request_id,kind,status,created_at) VALUES (?,?,?,\'message\',NULL,?)')
        .run(randomUUID(), actor.id, requestId, timestamp);
      db.prepare('INSERT INTO request_events(id,request_id,actor_id,old_status,new_status,reason,created_at) VALUES (?,?,?,NULL,?,?,?)').run(randomUUID(), requestId, actor.id, 'submitted', '', timestamp);
      audit(db, actor.id, 'request.created', 'request', requestId);
      return inserted;
    })();
    // Нова заявка створює діалог із першим повідомленням — інакше 10-секундний
    // кеш /notifications/unread-count віддавав би застарілий 0 після SSE-події.
    unreadCache.clear();
    // Адміни бачать нову заявку, клієнт — перше повідомлення в діалозі одразу.
    chatEvents.publish(actor.id, { kind: 'request', requestId });
    if (greeted) chatEvents.publish(actor.id, { kind: 'message', requestId });
    return reply.code(201).send({ id: requestId, status: 'submitted', conversationId });
  });
  app.get('/api/v1/requests', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor) return;
    const query = parse(page, request.query, reply); if (!query) return;
    const items = db.prepare(`SELECT r.id,r.template_id templateId,r.template_name templateName,r.status,r.created_at createdAt,r.updated_at updatedAt,u.locale customerLocale,
      (SELECT m.body FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) lastMessage,
      (SELECT m.created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) lastMessageAt,
      EXISTS(SELECT 1 FROM conversation_reads cr WHERE cr.conversation_id=c.id AND cr.user_id=?) seen
      FROM requests r JOIN conversations c ON c.request_id=r.id JOIN users u ON u.id=r.customer_id
      WHERE r.customer_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?`).all(actor.id, actor.id, query.limit, query.offset);
    return { items, nextOffset: (items as unknown[]).length === query.limit ? query.offset + query.limit : null };
  });
  app.get('/api/v1/requests/:id', async (request, reply) => {
    const actor = auth(request, reply); if (!actor) return;
    const row = requestRow((request.params as any).id, actor); if (!row) return fail(reply, 404, 'Не знайдено.');
    const events = db.prepare('SELECT old_status oldStatus,new_status newStatus,reason,created_at createdAt FROM request_events WHERE request_id=? ORDER BY created_at,rowid').all(row.id);
    const customer = db.prepare('SELECT locale FROM users WHERE id=?').get(row.customer_id) as { locale: string | null } | undefined;
    return { id: row.id, customerId: row.customer_id, customerLocale: customer?.locale ?? null, templateId: row.template_id, templateName: row.template_name, status: row.status, statusVersion: row.status_version, configuration: row.config_snapshot_json ? JSON.parse(row.config_snapshot_json) : null, contact: JSON.parse(row.contact_json), note: row.note, features: JSON.parse(row.features_json), conversationId: row.conversation_id, events, createdAt: row.created_at };
  });
  app.delete('/api/v1/requests/:id', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor || !verified(actor, reply)) return;
    const requestId = (request.params as any).id;
    const row = db.prepare('SELECT id FROM requests WHERE id=? AND customer_id=?').get(requestId, actor.id);
    if (!row) return fail(reply, 404, 'Не знайдено.');
    // Спершу журнал видалень поза основною БД: інакше відновлення з бекапу/PITR
    // повернуло б заявку, яку клієнт уже видалив. Без запису в журнал не видаляємо.
    if (recordRequestDeletion) {
      try { await recordRequestDeletion(requestId); } catch {
        app.log.error({ event: 'request_deletion_ledger_failed' });
        return fail(reply, 503, 'Видалення тимчасово недоступне. Спробуйте пізніше.');
      }
    }
    db.transaction(() => {
      db.prepare('DELETE FROM requests WHERE id=? AND customer_id=?').run(requestId, actor.id);
      db.prepare('INSERT INTO audit_log(id,actor_id,action,entity_type,entity_id,created_at) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), actor.id, 'request.delete', 'request', requestId, now());
    })();
    unreadCache.delete(actor.id);
    return reply.code(204).send();
  });
  app.get('/api/v1/events', async (request, reply) => {
    if (request.method !== 'GET') return reply.code(405).header('Allow', 'GET').send();
    const actor = auth(request, reply); if (!actor) return;
    const stream = chatEvents.subscribe(actor, () => {
      const current = actorFromRequest(db, request);
      return current?.id === actor.id && current.role === actor.role;
    });
    if (!stream) return reply.code(429).header('Retry-After', '30').send({ error: 'Забагато активних підключень.' });
    return reply.header('Content-Type', 'text/event-stream; charset=utf-8')
      .header('Cache-Control', 'private, no-store, no-transform')
      .header('X-Accel-Buffering', 'no').send(stream);
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
    const count = (db.prepare('SELECT COUNT(*) count FROM messages WHERE conversation_id=?').get(row.conversation_id) as { count: number }).count;
    if (count >= limits.messagesPerConversation) return fail(reply, 422, 'Досягнуто ліміту повідомлень діалогу. Зверніться до підтримки.');
    if (!accountAvailable(row.customer_id, Buffer.byteLength(body.body), reply)) return;
    const timestamp = now();
    // Мова клієнта = мова його інтерфейсу (cookie). Якщо cookie ще немає —
    // беремо останнє збережене значення, щоб відповідь не міняла мову випадково.
    let locale: Locale | null = null;
    if (actor.role === 'customer') {
      const cookieLocale = localeFromRequest(request);
      const saved = (db.prepare('SELECT locale FROM users WHERE id=?').get(actor.id) as { locale: string | null } | undefined)?.locale;
      locale = cookieLocale ?? (isLocale(saved) ? saved : null);
      if (cookieLocale) db.prepare('UPDATE users SET locale=? WHERE id=?').run(cookieLocale, actor.id);
    }
    // Для старих заявок, де вітального повідомлення ще немає, воно з'являється
    // на перше звернення клієнта. Фіксований ключ не дає дублювати його.
    const insertAutoReply = actor.role === 'customer';
    const recipient = actor.role === 'admin'
      ? (db.prepare('SELECT email FROM users WHERE id=?').get(row.customer_id) as { email: string }).email
      : teamEmail;
    const notificationId = recipient ? randomUUID() : null;
    const messageId = db.transaction(() => {
      const result = db.prepare('INSERT INTO messages(conversation_id,sender_id,client_message_id,body,created_at) VALUES (?,?,?,?,?)').run(row.conversation_id, actor.id, body.clientMessageId, body.body, timestamp);
      if (insertAutoReply) insertChatAutoReply(db, row.conversation_id, row.id, locale, timestamp);
      if (recipient && notificationId) db.prepare(`INSERT INTO email_notifications(id,message_id,recipient,status,created_at)
        VALUES (?,?,?,'pending',?)`).run(notificationId, Number(result.lastInsertRowid), recipient, timestamp);
      if (actor.role === 'admin') db.prepare('INSERT INTO notifications(id,recipient_id,request_id,kind,status,created_at) VALUES (?,?,?,\'message\',NULL,?)')
        .run(randomUUID(), row.customer_id, row.id, timestamp);
      return Number(result.lastInsertRowid);
    })();
    unreadCache.clear();
    chatEvents.publish(row.customer_id, { kind: 'message', requestId: row.id });
    if (notificationId) await deliverNotification(notificationId);
    return reply.code(201).send({ id: messageId, senderId: actor.id, body: body.body, createdAt: timestamp });
  });
  app.patch('/api/v1/requests/:id/read', async (request, reply) => {
    const actor = auth(request, reply); if (!actor) return;
    const row = requestRow((request.params as any).id, actor); if (!row) return fail(reply, 404, 'Не знайдено.');
    const body = parse(z.object({ lastSeenMessageId: z.number().int().nonnegative() }).strict(), request.body, reply); if (!body) return;
    if (body.lastSeenMessageId > 0 && !db.prepare('SELECT id FROM messages WHERE id=? AND conversation_id=?').get(body.lastSeenMessageId, row.conversation_id)) return fail(reply, 422, 'Повідомлення не належить діалогу.');
    db.prepare(`INSERT INTO conversation_reads(conversation_id,user_id,last_read_message_id,read_at) VALUES (?,?,?,?)
      ON CONFLICT(conversation_id,user_id) DO UPDATE SET last_read_message_id=MAX(last_read_message_id,excluded.last_read_message_id),read_at=excluded.read_at`)
      .run(row.conversation_id, actor.id, body.lastSeenMessageId, now());
    unreadCache.delete(actor.id);
    // Сповіщаємо співрозмовника: його власні повідомлення тепер мають
    // подвійну галочку. Без цієї події стан readByRecipient оновлювався
    // лише після повного перезавантаження чату.
    chatEvents.publish(row.customer_id, { kind: 'read', requestId: row.id });
    return reply.code(204).send();
  });
  app.get('/api/v1/notifications/unread-count', async (request, reply) => {
    const actor = auth(request, reply); if (!actor) return;
    const current = Date.now();
    const cached = unreadCache.get(actor.id);
    if (cached) {
      if (cached.expires > current) return cached.value;
      unreadCache.delete(actor.id);
    }
    const rows = db.prepare(`SELECT r.id requestId,COUNT(m.id) unread FROM requests r
      JOIN conversations c ON c.request_id=r.id
      JOIN messages m ON m.conversation_id=c.id AND m.sender_id<>?
      LEFT JOIN conversation_reads cr ON cr.conversation_id=c.id AND cr.user_id=?
      WHERE (r.customer_id=? OR ?='admin') AND m.id>COALESCE(cr.last_read_message_id,0)
        AND (?<>'admin' OR m.client_message_id NOT LIKE '${AUTOREPLY_KEY_PREFIX}%')
      GROUP BY r.id`).all(actor.id, actor.id, actor.id, actor.role, actor.role) as { requestId: string; unread: number }[];
    const value = { total: rows.reduce((sum, row) => sum + row.unread, 0), byRequest: rows };
    if (unreadCache.size > 5_000) {
      for (const [idKey, entry] of unreadCache) {
        if (entry.expires <= current || unreadCache.size > 4_500) unreadCache.delete(idKey);
      }
    }
    unreadCache.set(actor.id, { value, expires: current + 10_000 });
    return value;
  });
  app.get('/api/v1/notifications', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor) return;
    const items = db.prepare(`SELECT n.id,n.request_id requestId,n.kind,n.status,n.created_at createdAt,n.read_at readAt,r.template_name templateName
      FROM notifications n JOIN requests r ON r.id=n.request_id
      WHERE n.recipient_id=? ORDER BY n.created_at DESC,n.rowid DESC LIMIT 30`).all(actor.id);
    const unread = (db.prepare('SELECT COUNT(*) count FROM notifications WHERE recipient_id=? AND read_at IS NULL').get(actor.id) as { count: number }).count;
    return { items, unread };
  });
  app.patch('/api/v1/notifications/requests/:id/read', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor) return;
    const requestId = (request.params as { id: string }).id;
    if (!db.prepare('SELECT id FROM requests WHERE id=? AND customer_id=?').get(requestId, actor.id)) return fail(reply, 404, 'Не знайдено.');
    const readAt = now();
    const retentionCutoff = new Date(Date.now() - RETENTION_MS).toISOString();
    db.prepare('UPDATE notifications SET read_at=? WHERE recipient_id=? AND request_id=? AND read_at IS NULL').run(readAt, actor.id, requestId);
    db.prepare('DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at<?').run(retentionCutoff);
    return reply.code(204).send();
  });
  app.delete('/api/v1/notifications/:id', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor) return;
    const notificationId = (request.params as { id: string }).id;
    const result = db.prepare('DELETE FROM notifications WHERE id=? AND recipient_id=?').run(notificationId, actor.id);
    if (result.changes === 0) return fail(reply, 404, 'Не знайдено.');
    unreadCache.delete(actor.id);
    return reply.code(204).send();
  });
  app.delete('/api/v1/notifications', async (request, reply) => {
    const actor = auth(request, reply, 'customer'); if (!actor) return;
    db.prepare('DELETE FROM notifications WHERE recipient_id=?').run(actor.id);
    unreadCache.delete(actor.id);
    return reply.code(204).send();
  });

  app.get('/api/v1/admin/customers', async (request, reply) => {
    if (!auth(request, reply, 'admin')) return;
    const query = parse(page, request.query, reply); if (!query) return;
    const items = db.prepare("SELECT id,email,name,phone,telegram,locale,created_at createdAt FROM users WHERE role='customer' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?").all(query.limit, query.offset);
    return { items, nextOffset: (items as unknown[]).length === query.limit ? query.offset + query.limit : null };
  });
  app.get('/api/v1/admin/customers/:id', async (request, reply) => {
    if (!auth(request, reply, 'admin')) return;
    const customerId = (request.params as { id: string }).id;
    type CustomerRow = { id: string; email: string; name: string; phone: string | null; telegram: string | null; locale: string | null; createdAt: string; emailVerifiedAt: string | null };
    const row = db.prepare("SELECT id,email,name,phone,telegram,locale,created_at createdAt,email_verified_at emailVerifiedAt FROM users WHERE id=? AND role='customer'").get(customerId) as CustomerRow | undefined;
    if (!row) return fail(reply, 404, 'Не знайдено.');
    const requests = db.prepare(`SELECT id,template_name templateName,status,created_at createdAt,updated_at updatedAt
      FROM requests WHERE customer_id=? ORDER BY created_at DESC,id DESC LIMIT 30`).all(customerId);
    const configurations = db.prepare(`SELECT id,template_id templateId,name,revision,updated_at updatedAt
      FROM configurations WHERE owner_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT 30`).all(customerId);
    type CustomerStats = { requestsCount: number; configurationsCount: number; messagesCount: number };
    const stats = db.prepare(`SELECT
      (SELECT COUNT(*) FROM requests WHERE customer_id=?) requestsCount,
      (SELECT COUNT(*) FROM configurations WHERE owner_id=? AND deleted_at IS NULL) configurationsCount,
      (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN requests r ON r.id=c.request_id WHERE r.customer_id=?) messagesCount`)
      .get(customerId, customerId, customerId) as CustomerStats;
    return { ...row, requests, configurations, stats };
  });
  app.delete('/api/v1/admin/customers/:id', async (request, reply) => {
    const actor = auth(request, reply, 'admin'); if (!actor) return;
    const customerId = (request.params as { id: string }).id;
    if (!id.safeParse(customerId).success) return fail(reply, 422, 'Невірний ідентифікатор.');
    const customer = db.prepare("SELECT id,email FROM users WHERE id=? AND role='customer'").get(customerId) as { id: string; email: string } | undefined;
    if (!customer) return fail(reply, 404, 'Не знайдено.');
    if (!deleteCustomer) return fail(reply, 503, 'Видалення акаунта тимчасово недоступне.');
    await deleteCustomer(customerId);
    unreadCache.delete(customerId);
    audit(db, actor.id, 'customer.delete', 'user', customerId);
    return reply.code(204).send();
  });
  app.get('/api/v1/admin/requests', async (request, reply) => {
    const actor = auth(request, reply, 'admin'); if (!actor) return;
    const query = parse(page.extend({ status: z.enum(statuses).optional() }), request.query, reply); if (!query) return;
    const sql = `SELECT r.id,r.customer_id customerId,u.name customerName,u.locale customerLocale,r.template_id templateId,r.template_name templateName,r.status,r.status_version statusVersion,r.created_at createdAt,r.updated_at updatedAt,(SELECT m.body FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) lastMessage,(SELECT m.created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) lastMessageAt,EXISTS(SELECT 1 FROM conversation_reads cr WHERE cr.conversation_id=c.id AND cr.user_id=?) seen FROM requests r JOIN users u ON u.id=r.customer_id JOIN conversations c ON c.request_id=r.id`;
    const items = query.status ? db.prepare(`${sql} WHERE r.status=? ORDER BY r.updated_at DESC,r.id DESC LIMIT ? OFFSET ?`).all(actor.id, query.status, query.limit, query.offset) : db.prepare(`${sql} ORDER BY r.updated_at DESC,r.id DESC LIMIT ? OFFSET ?`).all(actor.id, query.limit, query.offset);
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
      db.prepare("INSERT INTO notifications(id,recipient_id,request_id,kind,status,created_at) VALUES (?,?,?,'status',?,?)")
        .run(randomUUID(), row.customer_id, row.id, body.status, now());
      audit(db, actor.id, 'request.status', 'request', row.id);
    })();
    chatEvents.publish(row.customer_id, { kind: 'status', requestId: row.id });
    return { id: row.id, status: body.status, statusVersion: version + 1 };
  });
  app.post('/api/v1/admin/requests/:id/reopen', async (request, reply) => {
    const actor = auth(request, reply, 'admin'); if (!actor) return;
    const body = parse(z.object({ reason: z.string().trim().min(3).max(500) }).strict(), request.body, reply); if (!body) return;
    const version = Number(request.headers['if-match']);
    if (!Number.isInteger(version) || version < 1) return fail(reply, 400, 'Потрібна версія If-Match.');
    const row = db.prepare('SELECT id,status,status_version,customer_id FROM requests WHERE id=?').get((request.params as any).id) as any;
    if (!row) return fail(reply, 404, 'Не знайдено.');
    if (row.status_version !== version || !['completed', 'cancelled'].includes(row.status)) return fail(reply, 409, 'Заявка не завершена або версія застаріла.');
    db.transaction(() => {
      db.prepare("UPDATE requests SET status='reviewing',status_version=status_version+1,updated_at=? WHERE id=?").run(now(), row.id);
      db.prepare('INSERT INTO request_events(id,request_id,actor_id,old_status,new_status,reason,created_at) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), row.id, actor.id, row.status, 'reviewing', body.reason, now());
      db.prepare("INSERT INTO notifications(id,recipient_id,request_id,kind,status,created_at) VALUES (?,?,?,'status','reviewing',?)")
        .run(randomUUID(), row.customer_id, row.id, now());
      audit(db, actor.id, 'request.reopen', 'request', row.id);
    })();
    chatEvents.publish(row.customer_id, { kind: 'status', requestId: row.id });
    return { id: row.id, status: 'reviewing', statusVersion: version + 1 };
  });
  app.get('/api/v1/admin/audit', async (request, reply) => {
    if (!auth(request, reply, 'admin')) return;
    return { items: db.prepare('SELECT id,actor_id actorId,action,entity_type entityType,entity_id entityId,created_at createdAt FROM audit_log ORDER BY created_at DESC,rowid DESC LIMIT 100').all() };
  });
  app.get('/api/v1/admin/guest-requests', async (request, reply) => {
    if (!auth(request, reply, 'admin')) return;
    const query = parse(page, request.query, reply); if (!query) return;
    type GuestRow = { id: string; name: string; contact: string; features_json: string; budget: string; note: string; template_name: string | null; telegram_status: string; status: string; created_at: string; processed_at: string | null; has_trial: number };
    const rows = db.prepare(`SELECT id,name,contact,features_json,budget,note,template_name,telegram_status,status,created_at,processed_at,trial_json IS NOT NULL AS has_trial
      FROM guest_requests ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(query.limit, query.offset) as GuestRow[];
    const items = rows.map(({ features_json, template_name, telegram_status, created_at, processed_at, has_trial, ...row }) => ({
      ...row,
      features: JSON.parse(features_json) as string[],
      templateName: template_name,
      telegramStatus: telegram_status,
      createdAt: created_at,
      processedAt: processed_at,
      hasTrial: Boolean(has_trial),
    }));
    return { items, nextOffset: items.length === query.limit ? query.offset + query.limit : null };
  });
  app.get('/api/v1/admin/guest-requests/:id/trial', async (request, reply) => {
    if (!auth(request, reply, 'admin')) return;
    const guestId = (request.params as { id: string }).id;
    const row = db.prepare('SELECT trial_json FROM guest_requests WHERE id=?').get(guestId) as { trial_json: string | null } | undefined;
    if (!row?.trial_json) return fail(reply, 404, 'Примірку не знайдено.');
    return { trial: JSON.parse(row.trial_json) };
  });
  app.patch('/api/v1/admin/guest-requests/:id/status', async (request, reply) => {
    const actor = auth(request, reply, 'admin'); if (!actor) return;
    const guestId = (request.params as { id: string }).id;
    const body = parse(z.object({ status: z.enum(guestStatuses) }).strict(), request.body, reply); if (!body) return;
    if (!db.prepare('SELECT id FROM guest_requests WHERE id=?').get(guestId)) return fail(reply, 404, 'Не знайдено.');
    db.prepare('UPDATE guest_requests SET status=?,processed_at=? WHERE id=?')
      .run(body.status, body.status === 'new' ? null : now(), guestId);
    audit(db, actor.id, 'guest_request.status', 'guest_request', guestId);
    return { id: guestId, status: body.status };
  });
  app.get('/api/v1/admin/diagnostics', async (request, reply) => {
    if (!auth(request, reply, 'admin')) return;
    const { integrity, foreignKeyViolations } = integrityReport(true);
    return { ok: integrity === 'ok' && foreignKeyViolations === 0, integrity, foreignKeyViolations,
      databaseBytes: databaseBytes?.() ?? null, emailConfigured: Boolean(sendMail) };
  });
  app.get('/api/v1/admin/overview', async (request, reply) => {
    const actor = auth(request, reply, 'admin'); if (!actor) return;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    // Статичні фрагменти SQL — значення статусів не підставляються ззовні.
    const requests = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) last7Days,
      SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END) submitted,
      SUM(CASE WHEN status='reviewing' THEN 1 ELSE 0 END) reviewing,
      SUM(CASE WHEN status='needs_info' THEN 1 ELSE 0 END) needsInfo,
      SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) inProgress,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) cancelled
      FROM requests`).get(since) as Record<string, number | null>;
    const customers = db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) last7Days
      FROM users WHERE role='customer'`).get(since) as { total: number | null; last7Days: number | null };
    // Автовідповідь — службове повідомлення: вона не є непрочитаним для менеджерів
    // і не закриває чергу «очікують відповіді» — там має бути жива відповідь менеджера.
    const notAutoreply = `m.client_message_id NOT LIKE '${AUTOREPLY_KEY_PREFIX}%'`;
    const unread = db.prepare(`SELECT COUNT(m.id) total FROM requests r
      JOIN conversations c ON c.request_id=r.id
      JOIN messages m ON m.conversation_id=c.id AND m.sender_id<>?
      LEFT JOIN conversation_reads cr ON cr.conversation_id=c.id AND cr.user_id=?
      WHERE m.id>COALESCE(cr.last_read_message_id,0) AND ${notAutoreply}`).get(actor.id, actor.id) as { total: number | null };
    const waitingAccount = db.prepare(`SELECT r.id,r.template_name templateName,u.name customerName,u.locale customerLocale,COUNT(*) OVER () total,
      COALESCE((SELECT m.created_at FROM messages m JOIN users sender ON sender.id=m.sender_id
        WHERE m.conversation_id=c.id AND ${notAutoreply} AND sender.role='customer' ORDER BY m.id DESC LIMIT 1),r.created_at) waitingSince
      FROM requests r JOIN users u ON u.id=r.customer_id JOIN conversations c ON c.request_id=r.id
      WHERE r.status NOT IN ('completed','cancelled')
        AND COALESCE((SELECT sender.role FROM messages m JOIN users sender ON sender.id=m.sender_id
          WHERE m.conversation_id=c.id AND ${notAutoreply} ORDER BY m.id DESC LIMIT 1),'customer')='customer'
      ORDER BY waitingSince ASC,r.id ASC LIMIT 5`).all() as Array<{ id: string; templateName: string; customerName: string; waitingSince: string; total: number }>;
    const waitingGuest = db.prepare(`SELECT id,name customerName,template_name templateName,created_at waitingSince,COUNT(*) OVER () total
      FROM guest_requests WHERE status='new' ORDER BY created_at ASC,id ASC LIMIT 5`).all() as Array<{ id: string; templateName: string | null; customerName: string; waitingSince: string; total: number }>;
    const emailProblems = (db.prepare("SELECT COUNT(*) count FROM email_notifications WHERE status IN ('pending','failed')").get() as { count: number }).count;
    const { integrity, foreignKeyViolations: foreignKeys } = integrityReport(false);
    const recentAudit = db.prepare(`SELECT a.id,a.action,a.entity_type entityType,a.entity_id entityId,a.created_at createdAt,u.name actorName
      FROM audit_log a JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC,a.rowid DESC LIMIT 6`).all();
    const number = (value: number | null | undefined) => Number(value ?? 0);
    return {
      requests: {
        total: number(requests.total), last7Days: number(requests.last7Days),
        byStatus: {
          submitted: number(requests.submitted), reviewing: number(requests.reviewing),
          needsInfo: number(requests.needsInfo), inProgress: number(requests.inProgress),
          completed: number(requests.completed), cancelled: number(requests.cancelled),
        },
      },
      customers: { total: number(customers.total), last7Days: number(customers.last7Days) },
      messages: { unread: number(unread.total) },
      waitingRepliesCount: (waitingAccount[0]?.total ?? 0) + (waitingGuest[0]?.total ?? 0),
      waitingReplies: [...waitingAccount.map(({ total: _total, ...item }) => ({ ...item, kind: 'account' as const })),
        ...waitingGuest.map(({ total: _total, ...item }) => ({ ...item, kind: 'guest' as const }))]
        .sort((a, b) => a.waitingSince.localeCompare(b.waitingSince)).slice(0, 5),
      email: { problems: emailProblems },
      system: { ok: integrity === 'ok' && foreignKeys === 0, integrity, foreignKeyViolations: foreignKeys,
        databaseBytes: databaseBytes?.() ?? null, emailConfigured: Boolean(sendMail) },
      recentAudit,
    };
  });
  app.get('/api/v1/admin/email-notifications', async (request, reply) => {
    if (!auth(request, reply, 'admin')) return;
    const query = parse(page, request.query, reply); if (!query) return;
    const items = db.prepare(`SELECT n.id,n.message_id messageId,r.id requestId,n.recipient,n.status,n.attempts,
      n.last_attempt_at lastAttemptAt,n.last_error_code lastErrorCode,n.created_at createdAt
      FROM email_notifications n JOIN messages m ON m.id=n.message_id
      JOIN conversations c ON c.id=m.conversation_id JOIN requests r ON r.id=c.request_id
      WHERE n.status<>'sent' ORDER BY n.created_at DESC,n.id DESC LIMIT ? OFFSET ?`).all(query.limit, query.offset);
    return { items, nextOffset: (items as unknown[]).length === query.limit ? query.offset + query.limit : null };
  });
  app.post('/api/v1/admin/email-notifications/:id/retry', async (request, reply) => {
    const actor = auth(request, reply, 'admin'); if (!actor) return;
    const notificationId = (request.params as { id: string }).id;
    if (!id.safeParse(notificationId).success) return fail(reply, 422, 'Невірний ідентифікатор.');
    const outcome = await deliverNotification(notificationId);
    if (outcome === 'missing') return fail(reply, 404, 'Не знайдено.');
    if (outcome === 'busy') return fail(reply, 409, 'Відправлення вже обробляється або виконане.');
    audit(db, actor.id, 'email.retry', 'email_notification', notificationId);
    return { id: notificationId, status: outcome };
  });
  return app;
}



