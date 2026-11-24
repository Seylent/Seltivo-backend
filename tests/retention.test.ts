import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createSession, now, sessionCookie } from '../src/auth.js';

process.env.NODE_ENV = 'test';
test('retention is admin-only, defaults to preview and preserves open or recently processed briefs', async () => {
  const db = openDatabase(':memory:');
  const origin = 'https://seltivo.example';
  const app = buildApp({ db, origin, logger: false });
  const timestamp = now(), adminId = crypto.randomUUID();
  db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin',?,?,?)")
    .run(adminId, 'admin@example.test', 'not-a-credential', timestamp, timestamp, timestamp);
  const cookie = sessionCookie(createSession(db, adminId, false, 'admin'), false).split(';')[0];
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  const before = new Date(Date.now() - 90 * 86400000).toISOString();
  const insert = db.prepare("INSERT INTO guest_requests(id,name,contact,features_json,budget,note,telegram_status,status,created_at,processed_at) VALUES (?,'Guest','@guest','[]','','Brief','sent',?,?,?)");
  for (const [status, processed] of [['new', null], ['in_progress', old], ['done', old], ['done', timestamp]]) insert.run(crypto.randomUUID(), status, old, processed);
  const call = (payload: Record<string, unknown>, authenticated = true) => app.inject({ method: 'POST', url: '/api/v1/admin/retention', headers: { origin, ...(authenticated ? { cookie } : {}) }, payload });
  try {
    assert.equal((await call({ before }, false)).statusCode, 401);
    const preview = await call({ before });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().applied, false);
    assert.equal(preview.json().eligible.guestRequests, 1);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM guest_requests').get() as { count: number }).count, 4);
    assert.equal((await call({ before: timestamp, apply: true })).statusCode, 422);
    const result = await call({ before, apply: true });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().deleted.guestRequests, 1);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM guest_requests').get() as { count: number }).count, 3);
    assert.equal((await call({ before })).json().eligible.guestRequests, 0);
  } finally { await app.close(); db.close(); }
});
