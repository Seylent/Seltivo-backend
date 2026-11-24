import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://localhost:8787';
const stagingKey = 'staging-runtime-test-key';

let mf: Miniflare;
let workerScript: string;
const backupEncryptionKey = Buffer.alloc(32, 7).toString('base64');
// Seeds a real admin row so the backup contains password_hash + email markers.
const adminPasswordHash = `scrypt:${'a'.repeat(32)}:${'b'.repeat(128)}`;

before(async () => {
  // The production entrypoint imports npm packages (Fastify, Zod, …) and TS
  // sources, which workerd cannot resolve by itself. Bundle it the way Wrangler
  // would, leaving `cloudflare:*` for the runtime; Node builtins are supplied by
  // workerd's nodejs_compat through the require shim below.
  const bundled = await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'cloudflare/worker.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    external: ['cloudflare:*'],
    // Fastify's CJS dependencies call `require("node:*")` at module init. In an
    // ESM worker there is no global `require`, so give esbuild's interop shim a
    // real one from workerd's nodejs_compat.
    banner: {
      js: "import { createRequire } from 'node:module';\nvar require = createRequire('file:///worker.js');",
    },
    logLevel: 'silent',
  });
  const script = bundled.outputFiles?.[0]?.text;
  assert.ok(script, 'esbuild must produce a bundled worker script');
  workerScript = script;

  // The `Miniflare` class takes the lower-level options shape; this beta ships
  // a converter for the public (Wrangler-like) shape used below.
  mf = new Miniflare(convertV4MiniflareOptions({
    name: 'seltivo-api',
    modules: true,
    script,
    compatibilityDate: '2026-11-14',
    compatibilityFlags: ['nodejs_compat'],
    bindings: {
      SELTIVO_PUBLIC_ORIGIN: origin,
      SELTIVO_REQUIRE_EMAIL_VERIFICATION: '0',
      SELTIVO_ADMIN_EMAIL: 'admin@example.test',
      SELTIVO_ADMIN_PASSWORD_HASH: adminPasswordHash,
      SELTIVO_STAGING: '1',
      SELTIVO_STAGING_TEST_KEY: stagingKey,
      SELTIVO_BACKUP_ENCRYPTION_KEY: backupEncryptionKey,
    },
    durableObjects: {
      SELTIVO: { className: 'SeltivoData', useSQLite: true },
      SELTIVO_DELETIONS: { className: 'DeletionLedger', useSQLite: true },
    },
    r2Buckets: ['SELTIVO_BACKUP_BUCKET', 'SELTIVO_SITE_DATA'],
    log: new Log(LogLevel.ERROR),
  }));
});

after(async () => {
  await mf?.dispose();
});

test('GET /api/v1/health returns 200 with { ok: true } through the real Worker', async () => {
  const response = await mf.dispatchFetch(`${origin}/api/v1/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('a mutation without a matching Origin header is rejected with 403', async () => {
  const response = await mf.dispatchFetch(`${origin}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'customer@example.test', password: 'correct-horse', name: 'Customer' }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json() as { error: string }).error, 'Невірне джерело запиту.');
});

test('the top-level fetch handler does not expose /internal/anything', async () => {
  const response = await mf.dispatchFetch(`${origin}/internal/anything`);
  assert.equal(response.status, 404);
});

test('scheduled() reports an exception for an unknown cron instead of silently succeeding', async () => {
  const worker = await mf.getWorker();
  // Miniflare's service binding surfaces a thrown scheduled error as an
  // `exception` outcome rather than rejecting the local promise.
  const result = await (worker as unknown as {
    scheduled(controller: { cron: string; scheduledTime: Date }): Promise<{ outcome: string }>;
  }).scheduled({ cron: 'not-a-real-cron', scheduledTime: new Date() });
  assert.equal(result.outcome, 'exception');
});

test('staging backup route writes a manifest to R2 and produces a distinct key on each call', async () => {
  const backup = async () => {
    const response = await mf.dispatchFetch(`${origin}/internal/staging/backup`, {
      method: 'POST',
      headers: { authorization: `Bearer ${stagingKey}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { key: string; bytes: number };
    assert.match(body.key, /^seltivo-backups\/v1\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\/manifest\.json$/);
    return body.key;
  };

  const first = await backup();
  const second = await backup();
  assert.notEqual(first, second);

  const bucket = await mf.getR2Bucket('SELTIVO_BACKUP_BUCKET');
  for (const key of [first, second]) {
    const manifestObject = await bucket.get(key);
    assert.ok(manifestObject, `${key} manifest must be stored in R2`);
    const manifest = await manifestObject!.json() as {
      encryption?: string;
      chunks: { key: string; iv?: string }[];
    };
    assert.equal(manifest.encryption, 'aes-gcm-256', 'backup manifest must declare encryption');
    assert.ok(manifest.chunks.length > 0, 'backup must contain at least one data chunk to verify');
    for (const chunk of manifest.chunks) {
      assert.match(chunk.iv ?? '', /^[A-Za-z0-9+/]{16}$/, 'each chunk needs a 12-byte base64 IV');
      const part = await bucket.get(chunk.key);
      assert.ok(part, `chunk ${chunk.key} must be stored in R2`);
      const body = await part!.text();
      assert.equal(body.includes('password_hash'), false, 'chunk must not contain plaintext password hashes');
      assert.equal(body.includes('admin@example.test'), false, 'chunk must not contain plaintext emails');
    }
  }
});

test('a Worker without the backup encryption key refuses to write plaintext backups', async () => {
  const unconfigured = new Miniflare(convertV4MiniflareOptions({
    name: 'seltivo-api-no-key',
    modules: true,
    script: workerScript,
    compatibilityDate: '2026-11-14',
    compatibilityFlags: ['nodejs_compat'],
    bindings: {
      SELTIVO_PUBLIC_ORIGIN: origin,
      SELTIVO_REQUIRE_EMAIL_VERIFICATION: '0',
      SELTIVO_ADMIN_EMAIL: 'admin@example.test',
      SELTIVO_STAGING: '1',
      SELTIVO_STAGING_TEST_KEY: stagingKey,
    },
    durableObjects: {
      SELTIVO: { className: 'SeltivoData', useSQLite: true },
      SELTIVO_DELETIONS: { className: 'DeletionLedger', useSQLite: true },
    },
    r2Buckets: ['SELTIVO_BACKUP_BUCKET', 'SELTIVO_SITE_DATA'],
    log: new Log(LogLevel.ERROR),
  }));
  try {
    const response = await unconfigured.dispatchFetch(`${origin}/internal/staging/backup`, {
      method: 'POST', headers: { authorization: `Bearer ${stagingKey}` },
    });
    assert.equal(response.status, 500);
    assert.match((await response.json() as { error: string }).error, /encryption key/i);
    const bucket = await unconfigured.getR2Bucket('SELTIVO_BACKUP_BUCKET');
    const listed = await bucket.list({ prefix: 'seltivo-backups/v1/' });
    assert.equal(listed.objects.length, 0, 'no backup objects are written without a key');
  } finally {
    await unconfigured.dispose();
  }
});
