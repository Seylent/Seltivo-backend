import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createWorkerRouter } from '../cloudflare/worker-router.js';
import { restoreLogicalBackup } from '../src/logical-backup.js';

process.env.NODE_ENV = 'test';
const origin = 'http://localhost:3000';

const postAuth = (app: ReturnType<typeof buildApp>, path: string, email: string, ip: string) =>
  app.inject({
    method: 'POST',
    url: path,
    headers: { origin, 'cf-connecting-ip': ip },
    payload: Buffer.from(JSON.stringify({ email })),
  });

test('forgot-password is limited per account even when the IP rotates', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, router: createWorkerRouter() });
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await postAuth(app, '/api/v1/auth/forgot-password', 'target@example.test', `198.51.100.${attempt + 1}`);
      assert.equal(response.statusCode, 202);
    }
    const blocked = await postAuth(app, '/api/v1/auth/forgot-password', 'target@example.test', '198.51.100.250');
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers['retry-after']) > 0);
    // Інший акаунт не повинен страждати від чужого ліміту.
    assert.equal((await postAuth(app, '/api/v1/auth/forgot-password', 'other@example.test', '198.51.100.251')).statusCode, 202);
  } finally {
    db.close();
  }
});

test('resend-verification is limited per account', async () => {
  const db = openDatabase(':memory:');
  const app = buildApp({ db, origin, router: createWorkerRouter() });
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await postAuth(app, '/api/v1/auth/resend-verification', 'target@example.test', `203.0.113.${attempt + 1}`)).statusCode, 202);
    }
    assert.equal((await postAuth(app, '/api/v1/auth/resend-verification', 'target@example.test', '203.0.113.250')).statusCode, 429);
  } finally {
    db.close();
  }
});

test('backup restore rejects manifest keys with path traversal', async () => {
  const db = openDatabase(':memory:');
  const store = { put: async () => {}, get: async () => null };
  try {
    await assert.rejects(
      restoreLogicalBackup(db, store, 'seltivo-backups/v1/2026-01-01/../../other/manifest.json'),
      /Invalid backup manifest key/,
    );
    await assert.rejects(
      restoreLogicalBackup(db, store, 'seltivo-backups/v1/2026-01-01/valid-uuid/manifest.json.bak'),
      /Invalid backup manifest key/,
    );
  } finally {
    db.close();
  }
});
