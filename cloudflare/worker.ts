import { DurableObject } from 'cloudflare:workers';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { openCloudflareDatabase } from '../src/cloudflare-db.js';
import { createWorkerRouter } from './worker-router.js';

interface Env {
  SELTIVO: DurableObjectNamespace;
  SELTIVO_PUBLIC_ORIGIN: string;
  SELTIVO_ADMIN_EMAIL: string;
  SELTIVO_ADMIN_PASSWORD_HASH?: string;
  BREVO_API_KEY?: string;
  BREVO_SENDER_EMAIL?: string;
}

function brevoMail(env: Env) {
  if (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL) return undefined;
  return async (to: string, subject: string, text: string) => {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
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
    if (!env.SELTIVO_PUBLIC_ORIGIN?.startsWith('https://')) {
      throw new Error('SELTIVO_PUBLIC_ORIGIN must be HTTPS');
    }
    const db = openCloudflareDatabase(ctx.storage);
    if (env.SELTIVO_ADMIN_PASSWORD_HASH) {
      const timestamp = new Date().toISOString();
      db.prepare(`INSERT OR IGNORE INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at)
        VALUES (?,?,?,'admin','Seltivo Studio',?,?,?)`)
        .run(randomUUID(), env.SELTIVO_ADMIN_EMAIL, env.SELTIVO_ADMIN_PASSWORD_HASH, timestamp, timestamp, timestamp);
    }
    this.app = buildApp({
      db,
      origin: env.SELTIVO_PUBLIC_ORIGIN,
      secureCookies: true,
      logger: false,
      router: createWorkerRouter(),
      sendMail: brevoMail(env),
    });
  }

  async fetch(request: Request): Promise<Response> {
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
    return new Response(result.rawPayload, { status: result.statusCode, headers });
  }
}

export default {
  fetch(request: Request, env: Env) {
    const id = env.SELTIVO.idFromName('primary');
    return env.SELTIVO.get(id).fetch(request);
  },
};
