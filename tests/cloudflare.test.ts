import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { openCloudflareDatabase } from '../src/cloudflare-db.js';
import { SCHEMA_SQL } from '../src/schema.js';
import { createWorkerRouter } from '../cloudflare/worker-router.js';

test('Cloudflare SQL and router preserve login, authorization and Origin checks', async () => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const sql = {
    exec(query: string, ...values: (string | number | null)[]) {
      let rows: Record<string, unknown>[];
      if (!values.length && query.includes('CREATE TABLE')) {
        sqlite.exec(query);
        rows = [];
      } else {
        const statement = sqlite.prepare(query);
        rows = statement.reader ? statement.all(...values) as Record<string, unknown>[]
          : (statement.run(...values), []);
      }
      return { toArray: () => rows };
    },
  };
  const storage = { sql, transactionSync<T>(callback: () => T): T { return sqlite.transaction(callback)(); } };
  const db = openCloudflareDatabase(storage);
  const timestamp = new Date().toISOString();
  const password = 'correct-horse-battery-staple';
  db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin',?,?,?)")
    .run(randomUUID(), 'admin@example.com', await hashPassword(password), timestamp, timestamp, timestamp);
  const origin = 'https://seltivo.example.workers.dev';
  const app = buildApp({ db, origin, secureCookies: true, logger: false, router: createWorkerRouter() });

  const payload = Buffer.from(JSON.stringify({ email: 'admin@example.com', password }));
  const missingOrigin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload });
  assert.equal(missingOrigin.statusCode, 403);

  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload });
  assert.equal(login.statusCode, 200);
  assert.match(String(login.headers['set-cookie']), /HttpOnly.*Secure/);

  const session = String(login.headers['set-cookie']).split(';')[0];
  const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: session } });
  assert.equal(me.statusCode, 200);
  assert.equal(JSON.parse(me.rawPayload.toString()).role, 'admin');
  const diagnostics = await app.inject({ method: 'GET', url: '/api/v1/admin/diagnostics', headers: { cookie: session } });
  assert.equal(diagnostics.statusCode, 200);
  assert.equal(JSON.parse(diagnostics.rawPayload.toString()).ok, true);

  const registration = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { origin }, payload: Buffer.from(JSON.stringify({ email: 'customer@example.com', password, name: 'Customer' })) });
  assert.equal(registration.statusCode, 201);
  const customerLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { Origin: origin }, payload: Buffer.from(JSON.stringify({ email: 'customer@example.com', password, rememberMe: true })) });
  assert.equal(customerLogin.statusCode, 200);
  assert.match(String(customerLogin.headers['set-cookie']), /Max-Age=2592000; Secure/);

  const badUri = await app.inject({ method: 'GET', url: '/api/v1/requests/%E0%A4%A', headers: { Cookie: session } });
  assert.equal(badUri.statusCode, 400);
  sqlite.close();
});

test('Cloudflare upgrades an occupied legacy object once and rejects a future schema', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(SCHEMA_SQL);
  sqlite.prepare("INSERT INTO users(id,email,password_hash,role,name,created_at,updated_at) VALUES ('u1','legacy@example.test','hash','customer','Legacy','2026-01-01','2026-01-01')").run();
  const storage = {
    sql: { exec(query: string, ...values: (string | number | null)[]) {
      if (!values.length && query.includes('CREATE TABLE')) { sqlite.exec(query); return { toArray: () => [] }; }
      const statement = sqlite.prepare(query);
      const rows = statement.reader ? statement.all(...values) : (statement.run(...values), []);
      return { toArray: () => rows as Record<string, unknown>[] };
    } },
    transactionSync<T>(callback: () => T) { return sqlite.transaction(callback)(); },
  };
  try {
    openCloudflareDatabase(storage);
    assert.equal((sqlite.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 1);
    assert.deepEqual(sqlite.prepare('SELECT version FROM schema_migrations ORDER BY version').all(), [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);
    const schemaVersion = sqlite.pragma('schema_version', { simple: true });
    openCloudflareDatabase(storage);
    assert.equal(sqlite.pragma('schema_version', { simple: true }), schemaVersion);
    sqlite.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (999,'2026-01-01')").run();
    assert.throws(() => openCloudflareDatabase(storage), /newer than this application/);
  } finally { sqlite.close(); }
});
