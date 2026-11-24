import { DurableObject } from 'cloudflare:workers';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { openCloudflareDatabase } from '../src/cloudflare-db.js';
import { createWorkerRouter } from './worker-router.js';
import { purgeCustomer, purgeRequest } from '../src/delete-account.js';
import { createLogicalBackupWithRetry, restoreLogicalBackup } from '../src/logical-backup.js';
import { createR2Backup } from '../src/r2-backup.js';
import { createNotificationDelivery } from '../src/notifications.js';
import { pruneExpiredBackups } from '../src/backup-retention.js';
import { checkR2Restore } from './staging-r2-restore.js';
import { runStagingRestoreCheck } from './staging-restore.js';
import { hashPassword, isValidPasswordHash, normalizeEmail, now } from '../src/auth.js';
import type { SeltivoDb } from '../src/db.js';
export { DeletionLedger } from './deletion-ledger.js';

const LEDGER_TIMEOUT_MS = 5_000;
const LEDGER_RETRY_DELAY_MS = 50;
const MIN_REPLAY_DELAY_MS = 60_000;
const MAX_REPLAY_DELAY_MS = 60 * 60 * 1000;
const PENDING_REPLAY_KEY = 'deletion-replay:pending';

// Bounded exponential backoff: 1m → 2m → 4m → 8m → 16m → 32m → 60m (max).
// Never returns zero, so a persistently failing replay cannot spin in a tight loop.
export function replayRetryDelayMs(attempt: number): number {
  const step = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return Math.min(MAX_REPLAY_DELAY_MS, MIN_REPLAY_DELAY_MS * 2 ** (step - 1));
}

// Structured logs must not carry customer identifiers or email addresses.
export function errorDetails(error: unknown): { errorType: string; message: string } {
  const raw = error instanceof Error ? error.message : 'unknown';
  return {
    errorType: error instanceof Error ? error.name : 'unknown',
    message: raw
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]')
      .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
      .slice(0, 300),
  };
}

// Every DO→DO ledger call is bounded. The constructor and deletion paths get
// one retry; non-ok responses and thrown errors both fail closed after that.
async function ledgerFetch(ledger: DurableObjectStub, init: RequestInit = {}, retries = 1): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await ledger.fetch('https://ledger.internal/deletions', {
        ...init,
        signal: AbortSignal.timeout(LEDGER_TIMEOUT_MS),
      });
      if (response.ok) return response;
      lastError = new Error(`Deletion ledger unavailable (status ${response.status})`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, LEDGER_RETRY_DELAY_MS));
  }
  throw lastError;
}

interface Env {
  SELTIVO: DurableObjectNamespace;
  SELTIVO_DELETIONS: DurableObjectNamespace;
  SELTIVO_BACKUP_BUCKET: R2Bucket;
  SELTIVO_SITE_DATA: R2Bucket;
  SELTIVO_PUBLIC_ORIGIN: string;
  SELTIVO_ADMIN_EMAIL: string;
  SELTIVO_ADMIN_PASSWORD_HASH?: string;
  BREVO_API_KEY?: string;
  BREVO_SENDER_EMAIL?: string;
  SELTIVO_ACCOUNT_DELETION_ENABLED?: string;
  SELTIVO_STAGING?: string;
  SELTIVO_STAGING_TEST_KEY?: string;
  SELTIVO_REQUIRE_EMAIL_VERIFICATION?: string;
  SELTIVO_REQUIRE_ADMIN_2FA?: string;
  SELTIVO_BACKUP_ENCRYPTION_KEY?: string;
}

export function stagingControlsEnabled(env: Env): boolean {
  if (env.SELTIVO_STAGING !== '1') return false;
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.SELTIVO_PUBLIC_ORIGIN);
  return Boolean(env.SELTIVO_STAGING_TEST_KEY)
    && (env.SELTIVO_PUBLIC_ORIGIN === 'https://seltivo-staging.seltivostudio.workers.dev' || local);
}

function brevoMail(env: Env) {
  if (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL) return undefined;
  return async (to: string, subject: string, text: string, html?: string) => {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { 'api-key': env.BREVO_API_KEY!, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: env.BREVO_SENDER_EMAIL, name: 'Seltivo' },
        to: [{ email: to }],
        subject,
        textContent: text,
        ...(html ? { htmlContent: html } : {}),
      }),
    });
    if (!response.ok) throw new Error(`Brevo email failed with status ${response.status}`);
  };
}

export class SeltivoData extends DurableObject<Env> {
  private app: ReturnType<typeof buildApp>;
  private db: SeltivoDb;
  private backupBucket: R2Bucket;
  private siteBucket: R2Bucket;
  private ledger: DurableObjectStub;
  private restoreProbe: boolean;
  private preBodyWrites = new Map<string, number[]>();
  private notifications: ReturnType<typeof createNotificationDelivery>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const localOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.SELTIVO_PUBLIC_ORIGIN ?? '');
    if (!env.SELTIVO_PUBLIC_ORIGIN?.startsWith('https://') && !localOrigin) throw new Error('SELTIVO_PUBLIC_ORIGIN must be HTTPS outside local development');
    const db = openCloudflareDatabase(ctx.storage);
    this.db = db;
    this.backupBucket = env.SELTIVO_BACKUP_BUCKET;
    this.siteBucket = env.SELTIVO_SITE_DATA;
    const ledger = env.SELTIVO_DELETIONS.get(env.SELTIVO_DELETIONS.idFromName('primary'));
    this.ledger = ledger;
    this.restoreProbe = stagingControlsEnabled(env) && ctx.id.name?.startsWith('restore-check-') === true;
    ctx.blockConcurrencyWhile(async () => {
      const pending = await ctx.storage.get<{ attempts?: number }>(PENDING_REPLAY_KEY);
      if (await this.replayDeletions()) {
        // Clear a leftover retry marker so a resolved replay cannot keep firing alarms.
        if (pending) {
          await ctx.storage.delete(PENDING_REPLAY_KEY);
          await ctx.storage.deleteAlarm();
        }
        return;
      }
      const attempts = typeof pending?.attempts === 'number' ? pending.attempts : 1;
      await ctx.storage.put(PENDING_REPLAY_KEY, { attempts });
      await ctx.storage.setAlarm(Date.now() + replayRetryDelayMs(attempts));
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
    // Журнал видалень доступний завжди: адміністратор може видаляти акаунти
    // незалежно від прапорця самообслуговування DELETE /me.
    const deleteCustomer = async (userId: string) => {
      try {
        await ledgerFetch(ledger, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: userId }),
        });
        purgeCustomer(db, userId);
      } catch (error) {
        ctx.abort();
        throw error;
      }
    };
    // Заявку видаляємо лише після запису в журнал: після PITR її повторно видалить replay.
    const recordRequestDeletion = async (requestId: string) => {
      await ledgerFetch(ledger, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: requestId, kind: 'request' }),
      });
    };
    this.notifications = createNotificationDelivery({
      db, origin: env.SELTIVO_PUBLIC_ORIGIN, sendMail, log: (entry) => console.error(JSON.stringify(entry)),
    });
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
      deleteCustomer,
      recordRequestDeletion,
      selfServiceDeletionEnabled: env.SELTIVO_ACCOUNT_DELETION_ENABLED === '1',
    });
  }

  // Replay is per-id: one poisoned ledger row must not prevent the primary DO
  // from starting. A ledger read failure still throws (fail closed).
  private async replayDeletions(): Promise<boolean> {
    const response = await ledgerFetch(this.ledger);
    const { ids, requestIds = [] } = await response.json() as { ids: string[]; requestIds?: string[] };
    let failed = 0;
    const replay = (purge: (db: SeltivoDb, id: string) => void, list: string[]) => {
      for (const id of list) {
        try {
          purge(this.db, id);
        } catch (error) {
          failed += 1;
          console.error(JSON.stringify({ event: 'deletion_replay_failed', ...errorDetails(error) }));
        }
      }
    };
    replay(purgeCustomer, ids);
    replay(purgeRequest, requestIds);
    return failed === 0;
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
      const ledgerResponse = await this.ledger.fetch('https://ledger.internal/deletions', {
        signal: AbortSignal.timeout(LEDGER_TIMEOUT_MS),
      });
      if (!ledgerResponse.ok) return new Response(null, { status: 503 });
      const { ids, requestIds = [] } = await ledgerResponse.json() as { ids: string[]; requestIds?: string[] };
      try {
        const manifest = await restoreLogicalBackup(this.db, this.backupBucket, body.manifestKey, ids, this.env.SELTIVO_BACKUP_ENCRYPTION_KEY, requestIds);
        const quickCheck = this.db.pragma('quick_check') as string;
        if (quickCheck !== 'ok') throw new Error('Staging quick_check failed');
        return Response.json({ rows: Object.values(manifest.rowCounts).reduce((sum, count) => sum + count, 0), quickCheck });
      } catch (error) {
        console.error(JSON.stringify({ event: 'staging_restore_failed', requestId, ...errorDetails(error) }));
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
    if (stagingControlsEnabled(this.env) && url.pathname === '/internal/r2-restore-check' && request.method === 'POST') {
      const body = await request.json().catch(() => null) as { manifestKey?: unknown } | null;
      if (typeof body?.manifestKey !== 'string') return new Response(null, { status: 422 });
      try { return Response.json(await checkR2Restore(this.backupBucket, this.siteBucket, body.manifestKey)); }
      catch (error) {
        console.error(JSON.stringify({ event: 'r2_restore_check_failed', ...errorDetails(error) }));
        return Response.json({ error: 'R2 restore check failed' }, { status: 500 });
      }
    }
    if (url.pathname === '/internal/backup' && request.method === 'POST') {
      // Backups contain password hashes and admin TOTP secrets — never write them
      // to R2 in plaintext. Legacy plaintext backups remain readable on restore.
      if (!this.env.SELTIVO_BACKUP_ENCRYPTION_KEY) {
        console.error(JSON.stringify({ event: 'backup_encryption_key_missing', requestId }));
        return Response.json({ error: 'Backup encryption key is not configured' }, { status: 500 });
      }
      try {
        const result = await createLogicalBackupWithRetry(this.db, this.backupBucket, undefined, this.env.SELTIVO_BACKUP_ENCRYPTION_KEY);
        const site = await createR2Backup(this.siteBucket, this.backupBucket);
        // Publish the service manifest only after the SQLite copy, R2 snapshot
        // and deletion-ledger IDs are all safely stored.
        const ledgerData = await (await ledgerFetch(this.ledger)).text();
        const ledgerKey = result.key.replace('manifest.json', 'deletion-ledger.json');
        await this.backupBucket.put(ledgerKey, ledgerData);
        const serviceManifest = result.key.replace('manifest.json', 'service-manifest.json');
        await this.backupBucket.put(serviceManifest, JSON.stringify({
          format: 'seltivo-service-v1', createdAt: new Date().toISOString(),
          databaseManifest: result.key, r2Manifest: site.key,
          deletionLedger: { key: ledgerKey, sha256: createHash('sha256').update(ledgerData).digest('hex') },
        }));
        console.log(JSON.stringify({ event: 'backup_completed', requestId, durationMs: Date.now() - started,
          bytes: result.bytes + site.bytes, siteObjects: site.manifest.objects.length,
          attempts: result.attempts, databaseBytes: this.ctx.storage.sql.databaseSize }));
        return Response.json({ key: result.key, bytes: result.bytes + site.bytes, serviceManifest, r2Manifest: site.key });
      } catch (error) {
        console.error(JSON.stringify({ event: 'backup_failed', requestId, durationMs: Date.now() - started,
          errorType: error instanceof Error ? error.name : 'unknown' }));
        return Response.json({ error: 'Backup failed' }, { status: 500 });
      }
    }
    if (url.pathname === '/internal/email-retry' && request.method === 'POST' && !this.restoreProbe) {
      try {
        const result = await this.notifications.retryDue();
        console.log(JSON.stringify({ event: 'email_retry_completed', requestId, durationMs: Date.now() - started, ...result }));
        return Response.json(result);
      } catch (error) {
        console.error(JSON.stringify({ event: 'email_retry_failed', requestId, ...errorDetails(error) }));
        return Response.json({ error: 'Email retry failed' }, { status: 500 });
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
    const stream = (result as typeof result & { stream?: ReadableStream<Uint8Array> }).stream;
    return new Response(stream ?? (result.statusCode === 204 ? null : new Uint8Array(result.rawPayload)), { status: result.statusCode, headers });
  }

  async alarm(): Promise<void> {
    if (this.restoreProbe) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const pending = await this.ctx.storage.get<{ attempts?: number }>(PENDING_REPLAY_KEY);
    if (!pending) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const attempts = (typeof pending.attempts === 'number' ? pending.attempts : 0) + 1;
    let allPurged = false;
    try {
      allPurged = await this.replayDeletions();
    } catch (error) {
      console.error(JSON.stringify({ event: 'deletion_replay_ledger_failed', attempts, ...errorDetails(error) }));
    }
    if (allPurged) {
      await this.ctx.storage.delete(PENDING_REPLAY_KEY);
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // A still-unpurged id is never abandoned: its data would stay accessible
    // after a PITR restore. Keep the marker and retry with bounded backoff.
    const nextDelayMs = replayRetryDelayMs(attempts);
    console.error(JSON.stringify({ event: 'deletion_replay_retry', attempts, nextDelayMs }));
    await this.ctx.storage.put(PENDING_REPLAY_KEY, { attempts });
    await this.ctx.storage.setAlarm(Date.now() + nextDelayMs);
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
      if (path === '/internal/staging/r2-restore-check') {
        const id = env.SELTIVO.idFromName('primary');
        return env.SELTIVO.get(id).fetch(new Request('https://internal.seltivo/internal/r2-restore-check', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await request.text(),
        }));
      }
      if (path === '/internal/staging/restore-check') {
        try {
          const result = await runStagingRestoreCheck(env, await request.json());
          return Response.json(result);
        } catch (error) {
          console.error(JSON.stringify({ event: 'staging_restore_check_failed', ...errorDetails(error) }));
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
      // Повтор листів не має блокувати очищення копій (і навпаки): виконуємо обидва.
      let failure: unknown;
      try {
        const deleted = await pruneExpiredBackups(env.SELTIVO_BACKUP_BUCKET);
        console.log(JSON.stringify({ event: 'backup_retention_completed', deleted, durationMs: Date.now() - started }));
      } catch (error) {
        console.error(JSON.stringify({ event: 'backup_retention_failed', errorType: error instanceof Error ? error.name : 'unknown' }));
        failure = error;
      }
      const retry = await env.SELTIVO.get(env.SELTIVO.idFromName('primary')).fetch(new Request('https://internal.seltivo/internal/email-retry', { method: 'POST' }));
      if (!retry.ok) failure ??= new Error('Email retry failed');
      if (failure) throw failure;
      return;
    }
    if (controller.cron !== '0 2 * * *') throw new Error('Unknown scheduled job');
    const id = env.SELTIVO.idFromName('primary');
    const response = await env.SELTIVO.get(id).fetch(new Request('https://internal.seltivo/internal/backup', { method: 'POST' }));
    if (!response.ok) throw new Error('Daily backup failed');
  },
};
