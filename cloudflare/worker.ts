import { DurableObject } from 'cloudflare:workers';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { openCloudflareDatabase } from '../src/cloudflare-db.js';
import { createWorkerRouter } from './worker-router.js';
import { purgeCustomer } from '../src/delete-account.js';
import { createLogicalBackup, restoreLogicalBackup } from '../src/logical-backup.js';
import { pruneExpiredBackups } from '../src/backup-retention.js';
import { runStagingRestoreCheck } from './staging-restore.js';
import { hashPassword, isValidPasswordHash, normalizeEmail, now } from '../src/auth.js';
import type { SeltivoDb } from '../src/db.js';
export { DeletionLedger } from './deletion-ledger.js';

interface Env {
  SELTIVO: DurableObjectNamespace;
  SELTIVO_DELETIONS: DurableObjectNamespace;
  SELTIVO_BACKUP_BUCKET: R2Bucket;
  SELTIVO_PUBLIC_ORIGIN: string;
  SELTIVO_ADMIN_EMAIL: string;
  SELTIVO_ADMIN_PASSWORD_HASH?: string;
  BREVO_API_KEY?: string;
  BREVO_SENDER_EMAIL?: string;
  SELTIVO_ACCOUNT_DELETION_ENABLED?: string;
  SELTIVO_STAGING_TEST_KEY?: string;
  SELTIVO_REQUIRE_EMAIL_VERIFICATION?: string;
  SELTIVO_REQUIRE_ADMIN_2FA?: string;
}

function stagingControlsEnabled(env: Env): boolean {
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.SELTIVO_PUBLIC_ORIGIN);
  return Boolean(env.SELTIVO_STAGING_TEST_KEY)
    && (env.SELTIVO_PUBLIC_ORIGIN === 'https://seltivo-staging.seltivostudio.workers.dev' || local);
}

function brevoMail(env: Env) {
  if (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL) return undefined;
  return async (to: string, subject: string, text: string) => {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { 'api-key': env.BREVO_API_KEY!, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: env.BREVO_SENDER_EMAIL, name: 'Seltivo' },
        to: [{ email: to }],
        subject,
        textContent: text,
      }),
    });
    if (!response.ok) throw new Error(`Brevo email failed with status ${response.status}`);
  };
}

export class SeltivoData extends DurableObject<Env> {
  private app: ReturnType<typeof buildApp>;
  private db: SeltivoDb;
  private backupBucket: R2Bucket;
  private ledger: DurableObjectStub;
  private restoreProbe: boolean;
  private preBodyWrites = new Map<string, number[]>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const localOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.SELTIVO_PUBLIC_ORIGIN ?? '');
    if (!env.SELTIVO_PUBLIC_ORIGIN?.startsWith('https://') && !localOrigin) throw new Error('SELTIVO_PUBLIC_ORIGIN must be HTTPS outside local development');
    const db = openCloudflareDatabase(ctx.storage);
    this.db = db;
    this.backupBucket = env.SELTIVO_BACKUP_BUCKET;
    const ledger = env.SELTIVO_DELETIONS.get(env.SELTIVO_DELETIONS.idFromName('primary'));
    this.ledger = ledger;
    this.restoreProbe = stagingControlsEnabled(env) && ctx.id.name?.startsWith('restore-check-') === true;
    ctx.blockConcurrencyWhile(async () => {
      const response = await ledger.fetch('https://ledger.internal/deletions');
      if (!response.ok) throw new Error('Deletion ledger unavailable');
      const { ids } = await response.json() as { ids: string[] };
      for (const id of ids) purgeCustomer(db, id);
    });
    if (env.SELTIVO_ADMIN_PASSWORD_HASH && !this.restoreProbe) {
      if (!isValidPasswordHash(env.SELTIVO_ADMIN_PASSWORD_HASH)) {
        throw new Error('SELTIVO_ADMIN_PASSWORD_HASH must be a valid scrypt password hash');
      }
      const timestamp = new Date().toISOString();
      db.prepare(`INSERT OR IGNORE INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at)
        VALUES (?,?,?,'admin','Seltivo Studio',?,?,?)`)
        .run(randomUUID(), normalizeEmail(env.SELTIVO_ADMIN_EMAIL), env.SELTIVO_ADMIN_PASSWORD_HASH, timestamp, timestamp, timestamp);
    }
    const requireEmailVerification = env.SELTIVO_REQUIRE_EMAIL_VERIFICATION === '1';
    const sendMail = brevoMail(env);
    // Без пошти unverified-акаунти не зможуть підтвердити email і будуть
    // заблоковані для заявок/конфігурацій — краще одразу впасти зі зрозумілою помилкою.
    if (requireEmailVerification && !sendMail) {
      throw new Error('SELTIVO_REQUIRE_EMAIL_VERIFICATION=1 requires BREVO_API_KEY and BREVO_SENDER_EMAIL');
    }
    this.app = buildApp({
      db,
      origin: env.SELTIVO_PUBLIC_ORIGIN,
      secureCookies: !localOrigin,
      requireEmailVerification,
      requireAdmin2FA: env.SELTIVO_REQUIRE_ADMIN_2FA === '1',
      logger: false,
      router: createWorkerRouter(),
      sendMail,
      teamEmail: env.SELTIVO_ADMIN_EMAIL,
      databaseBytes: () => ctx.storage.sql.databaseSize,
      deleteCustomer: env.SELTIVO_ACCOUNT_DELETION_ENABLED === '1' ? async (userId) => {
        try {
          const response = await ledger.fetch(new Request('https://ledger.internal/deletions', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: userId }),
          }));
          if (!response.ok) throw new Error('Deletion ledger unavailable');
          purgeCustomer(db, userId);
        } catch (error) {
          ctx.abort();
          throw error;
        }
      } : undefined,
    });
  }

  // Грубий per-DO ліміт записів, який спрацьовує ДО читання тіла.
  // Не підміняє точні ліміти в buildApp — лише відсікає явний flood,
  // щоб 429-запити не виділяли 9 МБ і не робили JSON.parse у єдиному DO.
  private preBodyAllow(ip: string): boolean {
    const now = Date.now();
    const recent = (this.preBodyWrites.get(ip) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= 200) {
      this.preBodyWrites.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.preBodyWrites.set(ip, recent);
    if (this.preBodyWrites.size > 5000) {
      for (const [key, times] of this.preBodyWrites) {
        if (!times.length || now - times[times.length - 1] >= 60_000) this.preBodyWrites.delete(key);
      }
      while (this.preBodyWrites.size > 5000) {
        const oldest = this.preBodyWrites.keys().next().value;
        if (oldest === undefined) break;
        this.preBodyWrites.delete(oldest);
      }
    }
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    const started = Date.now();
    const requestId = randomUUID();
    const url = new URL(request.url);
    if (this.restoreProbe && url.pathname === '/internal/restore' && request.method === 'POST') {
      await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
      const body = await request.json().catch(() => null) as { manifestKey?: unknown } | null;
      if (typeof body?.manifestKey !== 'string') return new Response(null, { status: 422 });
      const ledgerResponse = await this.ledger.fetch('https://ledger.internal/deletions');
      if (!ledgerResponse.ok) return new Response(null, { status: 503 });
      const { ids } = await ledgerResponse.json() as { ids: string[] };
      try {
        const manifest = await restoreLogicalBackup(this.db, this.backupBucket, body.manifestKey, ids);
        const quickCheck = this.db.pragma('quick_check') as string;
        if (quickCheck !== 'ok') throw new Error('Staging quick_check failed');
        return Response.json({ rows: Object.values(manifest.rowCounts).reduce((sum, count) => sum + count, 0), quickCheck });
      } catch {
        return new Response(null, { status: 500 });
      }
    }
    if (this.restoreProbe && url.pathname === '/internal/discard' && request.method === 'POST') {
      await this.ctx.storage.deleteAll();
      return new Response(null, { status: 204 });
    }
    if (!this.restoreProbe && this.ctx.id.name === 'primary' && stagingControlsEnabled(this.env)
      && url.pathname === '/internal/admin-fixture' && request.method === 'POST') {
      const body = await request.json().catch(() => null) as { email?: unknown; password?: unknown } | null;
      if (typeof body?.email !== 'string' || !/^staging-admin-[a-z0-9-]+@example\.test$/.test(body.email)
        || typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 200) return new Response(null, { status: 422 });
      const timestamp = now();
      this.db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Staging Admin',?,?,?)")
        .run(randomUUID(), normalizeEmail(body.email), await hashPassword(body.password), timestamp, timestamp, timestamp);
      return new Response(null, { status: 201 });
    }
    if (url.pathname === '/internal/backup' && request.method === 'POST') {
      try {
        const result = await createLogicalBackup(this.db, this.backupBucket);
        console.log(JSON.stringify({ event: 'backup_completed', requestId, durationMs: Date.now() - started,
          bytes: result.bytes, databaseBytes: this.ctx.storage.sql.databaseSize }));
        return Response.json({ key: result.key, bytes: result.bytes });
      } catch (error) {
        console.error(JSON.stringify({ event: 'backup_failed', requestId, durationMs: Date.now() - started,
          errorType: error instanceof Error ? error.name : 'unknown' }));
        return Response.json({ error: 'Backup failed' }, { status: 500 });
      }
    }
    // Відсікаємо явний flood ще до читання тіла (див. preBodyAllow).
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const ip = request.headers.get('cf-connecting-ip')?.trim() || 'unknown';
      if (!this.preBodyAllow(ip)) {
        return Response.json({ error: 'Забагато запитів. Спробуйте пізніше.' }, { status: 429, headers: { 'Retry-After': '60' } });
      }
    }
    const MAX_BODY = 9 * 1024 * 1024;
    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_BODY) {
      return Response.json({ error: 'Запит завеликий.' }, { status: 413 });
    }
    let body: Buffer | undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (request.body) {
        // Читаємо потік шматками й відсікаємо одразу після перевищення ліміту:
        // arrayBuffer() на 60–100 МБ вбиває єдиний Durable Object ще до перевірки.
        const reader = request.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > MAX_BODY) {
              await reader.cancel().catch(() => {});
              return Response.json({ error: 'Запит завеликий.' }, { status: 413 });
            }
            chunks.push(value);
          }
        } catch {
          return Response.json({ error: 'Запит завеликий.' }, { status: 413 });
        }
        body = Buffer.concat(chunks, total);
      } else {
        body = Buffer.alloc(0);
      }
    }
    const result = await this.app.inject({
      method: request.method as 'GET',
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers.entries()),
      payload: body,
    });
    const headers = new Headers();
    for (const [key, value] of Object.entries(result.headers)) {
      if (value !== undefined) headers.set(key, String(value));
    }
    headers.set('X-Request-Id', requestId);
    console.log(JSON.stringify({ event: 'api_request', requestId, method: request.method,
      status: result.statusCode, durationMs: Date.now() - started, databaseBytes: this.ctx.storage.sql.databaseSize }));
    return new Response(result.statusCode === 204 ? null : new Uint8Array(result.rawPayload), { status: result.statusCode, headers });
  }

  async alarm(): Promise<void> {
    if (this.restoreProbe) await this.ctx.storage.deleteAll();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/internal/staging/')) {
      if (!stagingControlsEnabled(env) || request.method !== 'POST') return new Response(null, { status: 404 });
      const provided = Buffer.from(request.headers.get('authorization') ?? '');
      const expected = Buffer.from(`Bearer ${env.SELTIVO_STAGING_TEST_KEY}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return new Response(null, { status: 404 });
      if (path === '/internal/staging/backup') {
        const id = env.SELTIVO.idFromName('primary');
        return env.SELTIVO.get(id).fetch(new Request('https://internal.seltivo/internal/backup', { method: 'POST' }));
      }
      if (path === '/internal/staging/admin-fixture') {
        const id = env.SELTIVO.idFromName('primary');
        return env.SELTIVO.get(id).fetch(new Request('https://internal.seltivo/internal/admin-fixture', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text(),
        }));
      }
      if (path === '/internal/staging/restore-check') {
        try {
          const result = await runStagingRestoreCheck(env, await request.json());
          return Response.json(result);
        } catch (error) {
          console.error(JSON.stringify({ event: 'staging_restore_check_failed', reason: error instanceof Error ? error.message : 'unknown' }));
          return Response.json({ error: 'Staging restore check failed' }, { status: 500 });
        }
      }
      return new Response(null, { status: 404 });
    }
    if (path.startsWith('/internal/')) return new Response(null, { status: 404 });
    const id = env.SELTIVO.idFromName('primary');
    return env.SELTIVO.get(id).fetch(request);
  },
  async scheduled(controller: ScheduledController, env: Env) {
    if (controller.cron === '10 * * * *') {
      const started = Date.now();
      try {
        const deleted = await pruneExpiredBackups(env.SELTIVO_BACKUP_BUCKET);
        console.log(JSON.stringify({ event: 'backup_retention_completed', deleted, durationMs: Date.now() - started }));
      } catch (error) {
        console.error(JSON.stringify({ event: 'backup_retention_failed', errorType: error instanceof Error ? error.name : 'unknown' }));
        throw error;
      }
      return;
    }
    if (controller.cron !== '0 2 * * *') throw new Error('Unknown scheduled job');
    const id = env.SELTIVO.idFromName('primary');
    const response = await env.SELTIVO.get(id).fetch(new Request('https://internal.seltivo/internal/backup', { method: 'POST' }));
    if (!response.ok) throw new Error('Daily backup failed');
  },
};
