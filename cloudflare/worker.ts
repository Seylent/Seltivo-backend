import { DurableObject } from 'cloudflare:workers';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { openCloudflareDatabase } from '../src/cloudflare-db.js';
import { createWorkerRouter } from './worker-router.js';
import { purgeCustomer } from '../src/delete-account.js';
export { DeletionLedger } from './deletion-ledger.js';

interface Env {
  SELTIVO: DurableObjectNamespace;
  SELTIVO_DELETIONS: DurableObjectNamespace;
  SELTIVO_PUBLIC_ORIGIN: string;
  SELTIVO_ADMIN_EMAIL: string;
  SELTIVO_ADMIN_PASSWORD_HASH?: string;
  BREVO_API_KEY?: string;
  BREVO_SENDER_EMAIL?: string;
  SELTIVO_ACCOUNT_DELETION_ENABLED?: string;
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const localOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.SELTIVO_PUBLIC_ORIGIN ?? '');
    if (!env.SELTIVO_PUBLIC_ORIGIN?.startsWith('https://') && !localOrigin) throw new Error('SELTIVO_PUBLIC_ORIGIN must be HTTPS outside local development');
    const db = openCloudflareDatabase(ctx.storage);
    const ledger = env.SELTIVO_DELETIONS.get(env.SELTIVO_DELETIONS.idFromName('primary'));
    ctx.blockConcurrencyWhile(async () => {
      const response = await ledger.fetch('https://ledger.internal/deletions');
      if (!response.ok) throw new Error('Deletion ledger unavailable');
      const { ids } = await response.json() as { ids: string[] };
      for (const id of ids) purgeCustomer(db, id);
    });
    if (env.SELTIVO_ADMIN_PASSWORD_HASH) {
      const timestamp = new Date().toISOString();
      db.prepare(`INSERT OR IGNORE INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at)
        VALUES (?,?,?,'admin','Seltivo Studio',?,?,?)`)
        .run(randomUUID(), env.SELTIVO_ADMIN_EMAIL, env.SELTIVO_ADMIN_PASSWORD_HASH, timestamp, timestamp, timestamp);
    }
    this.app = buildApp({
      db,
      origin: env.SELTIVO_PUBLIC_ORIGIN,
      secureCookies: !localOrigin,
      logger: false,
      router: createWorkerRouter(),
      sendMail: brevoMail(env),
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

  async fetch(request: Request): Promise<Response> {
    const started = Date.now();
    const requestId = randomUUID();
    const url = new URL(request.url);
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? undefined : Buffer.from(await request.arrayBuffer());
    const result = await this.app.inject({
      method: request.method as 'GET',
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      payload: body,
    });
    const headers = new Headers();
    for (const [key, value] of Object.entries(result.headers)) {
      if (value !== undefined) headers.set(key, String(value));
    }
    headers.set('X-Request-Id', requestId);
    console.log(JSON.stringify({ event: 'api_request', requestId, method: request.method,
      status: result.statusCode, durationMs: Date.now() - started, databaseBytes: this.ctx.storage.sql.databaseSize }));
    return new Response(result.statusCode === 204 ? null : result.rawPayload, { status: result.statusCode, headers });
  }
}

export default {
  fetch(request: Request, env: Env) {
    const id = env.SELTIVO.idFromName('primary');
    return env.SELTIVO.get(id).fetch(request);
  },
};
