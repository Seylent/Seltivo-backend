import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { createWorkerRouter } from '../cloudflare/worker-router.js';

// Node has no `cloudflare:workers` runtime module. Provide a minimal stand-in so
// the Worker modules can be imported for pure unit tests.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: 'mock:cloudflare-workers', shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'mock:cloudflare-workers') {
      return {
        format: 'module',
        source: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { stagingControlsEnabled, errorDetails, replayRetryDelayMs, SeltivoData } = await import('../cloudflare/worker.js');
const { DeletionLedger } = await import('../cloudflare/deletion-ledger.js');

type StagingEnv = Parameters<typeof stagingControlsEnabled>[0];
const env = (partial: Partial<StagingEnv>) => partial as StagingEnv;

test('staging controls stay off without SELTIVO_STAGING even on a local origin', () => {
  assert.equal(stagingControlsEnabled(env({
    SELTIVO_PUBLIC_ORIGIN: 'http://localhost:8787',
    SELTIVO_STAGING_TEST_KEY: 'local-test-key',
  })), false);
});

test('staging controls require the flag together with the key and staging origin', () => {
  assert.equal(stagingControlsEnabled(env({
    SELTIVO_PUBLIC_ORIGIN: 'https://seltivo-staging.seltivostudio.workers.dev',
    SELTIVO_STAGING_TEST_KEY: 'staging-test-key',
    SELTIVO_STAGING: '1',
  })), true);
  assert.equal(stagingControlsEnabled(env({
    SELTIVO_PUBLIC_ORIGIN: 'https://seltivostudio.com',
    SELTIVO_STAGING_TEST_KEY: 'staging-test-key',
    SELTIVO_STAGING: '1',
  })), false);
  assert.equal(stagingControlsEnabled(env({
    SELTIVO_PUBLIC_ORIGIN: 'https://seltivo-staging.seltivostudio.workers.dev',
    SELTIVO_STAGING: '1',
  })), false);
});

test('staging controls enable on a local origin with the flag and test key', () => {
  assert.equal(stagingControlsEnabled(env({
    SELTIVO_PUBLIC_ORIGIN: 'http://localhost:8787',
    SELTIVO_STAGING_TEST_KEY: 'local-test-key',
    SELTIVO_STAGING: '1',
  })), true);
});

test('errorDetails redacts email addresses and UUIDs from error messages', () => {
  const details = errorDetails(new Error(
    'restore failed for admin@example.test id 550e8400-e29b-41d4-a716-446655440000',
  ));
  assert.match(details.message, /\[email\]/);
  assert.match(details.message, /\[id\]/);
  assert.equal(details.message.includes('admin@example.test'), false);
  assert.equal(details.message.includes('550e8400-e29b-41d4-a716-446655440000'), false);
});

test('deletion replay backoff grows exponentially and is capped at 60 minutes', () => {
  assert.equal(replayRetryDelayMs(1), 60_000);
  assert.equal(replayRetryDelayMs(2), 120_000);
  assert.equal(replayRetryDelayMs(3), 240_000);
  assert.equal(replayRetryDelayMs(4), 480_000);
  assert.equal(replayRetryDelayMs(5), 960_000);
  assert.equal(replayRetryDelayMs(6), 1_920_000);
  assert.equal(replayRetryDelayMs(7), 3_600_000);
  assert.equal(replayRetryDelayMs(20), 3_600_000);
});

test('deletion replay alarm never abandons pending ids and logs each retry', async () => {
  const values = new Map<string, { attempts?: number }>();
  let alarmAt: number | undefined;
  const ctx = {
    storage: {
      async get(key: string) { return values.get(key); },
      async put(key: string, value: { attempts?: number }) { values.set(key, value); },
      async delete(key: string) { values.delete(key); },
      async setAlarm(time: number) { alarmAt = time; },
      async deleteAlarm() { alarmAt = undefined; },
    },
  };
  const instance = Object.create((SeltivoData as any).prototype) as any;
  instance.ctx = ctx;
  instance.restoreProbe = false;
  instance.replayDeletions = async () => false;

  const logs: Record<string, any>[] = [];
  const original = console.error;
  console.error = (line: string) => { logs.push(JSON.parse(line)); };
  try {
    values.set('deletion-replay:pending', { attempts: 1 });
    const scheduled: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      await instance.alarm();
      assert.ok(alarmAt !== undefined, 'alarm must stay scheduled while ids are un-purged');
      scheduled.push(alarmAt!);
      assert.equal(values.get('deletion-replay:pending')?.attempts, i + 2);
    }
    const delays = logs.map((line) => line.nextDelayMs as number);
    assert.deepEqual(delays, [
      120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
    for (let i = 1; i < scheduled.length; i += 1) {
      assert.ok(scheduled[i] >= scheduled[i - 1], 'scheduled alarm time must not move backwards');
    }
    assert.equal(logs.some((line) => line.event === 'deletion_replay_abandoned'), false);
    assert.deepEqual(logs.map((line) => line.event), Array(9).fill('deletion_replay_retry'));
    assert.deepEqual(logs.map((line) => line.attempts), [2, 3, 4, 5, 6, 7, 8, 9, 10]);

    instance.replayDeletions = async () => true;
    await instance.alarm();
    assert.equal(values.has('deletion-replay:pending'), false, 'a successful replay clears the marker');
    assert.equal(alarmAt, undefined, 'a successful replay clears the alarm');
  } finally {
    console.error = original;
  }
});

test('replayDeletions isolates a poisoned id and still attempts the remaining ids', async () => {
  const poison = '550e8400-e29b-41d4-a716-446655440000';
  const good = '550e8400-e29b-11d4-a716-446655440001';
  const purged: string[] = [];
  const db = {
    transaction<T>(callback: () => T) { return () => callback(); },
    prepare(_sql: string) {
      return {
        get(id: string) {
          if (id === poison) throw new Error('poisoned ledger row');
          purged.push(id);
          return undefined;
        },
        all() { return []; },
        run() {},
      };
    },
    pragma() { return []; },
  };
  const ledger = { fetch: async () => Response.json({ ids: [poison, good] }) };
  const instance = Object.create((SeltivoData as any).prototype) as any;
  instance.db = db;
  instance.ledger = ledger;

  const logs: Record<string, any>[] = [];
  const original = console.error;
  console.error = (line: string) => { logs.push(JSON.parse(line)); };
  try {
    const allPurged = await instance.replayDeletions();
    assert.equal(allPurged, false);
    assert.deepEqual(purged, [good], 'one bad id must not block the others');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].event, 'deletion_replay_failed');
  } finally {
    console.error = original;
  }
});

test('onSend hooks receive the request context, reply and payload and can replace the payload', async () => {
  const router = createWorkerRouter();
  router.get('/on-send', () => ({ original: true }));
  let seen: Record<string, unknown> = {};
  router.addHook('onSend', (request: any, reply: any, payload: unknown) => {
    seen = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      statusCode: reply.statusCode,
      payload,
    };
    return { wrapped: payload };
  });

  const response = await router.inject({ method: 'GET', url: '/on-send' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.rawPayload.toString()), { wrapped: { original: true } });
  assert.deepEqual(seen, {
    method: 'GET',
    url: '/on-send',
    headers: {},
    statusCode: 200,
    payload: { original: true },
  });
});

test('onSend hooks returning undefined leave the payload unchanged', async () => {
  const router = createWorkerRouter();
  router.get('/plain', () => ({ untouched: true }));
  router.addHook('onSend', () => undefined);

  const response = await router.inject({ method: 'GET', url: '/plain' });

  assert.deepEqual(JSON.parse(response.rawPayload.toString()), { untouched: true });
});

test('deletion ledger accepts canonical UUIDs v1-v5 with a valid variant', async () => {
  const stored = new Map<string, string>();
  const ctx = {
    storage: {
      async list({ prefix }: { prefix: string }) {
        return { keys: () => [...stored.keys()].filter((key) => key.startsWith(prefix)) };
      },
      async put(key: string, value: string) { stored.set(key, value); },
    },
  };
  const ledger = new (DeletionLedger as any)(ctx, {}) as { fetch(request: Request): Promise<Response> };
  const post = (id: string) => ledger.fetch(new Request('https://ledger.internal/deletions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }));

  assert.equal((await post('not-a-uuid')).status, 422);
  assert.equal((await post('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')).status, 422);
  assert.equal((await post('00000000-0000-0000-0000-000000000000')).status, 422);
  assert.equal((await post('550e8400-e29b-41d4-2716-446655440000')).status, 422, 'invalid variant must be rejected');
  assert.equal((await post('550e8400-e29b-11d4-a716-446655440000')).status, 204, 'v1 ids must be accepted');
  assert.equal((await post('550e8400-e29b-41d4-a716-446655440000')).status, 204);
  assert.deepEqual([...stored.keys()], [
    'customer:550e8400-e29b-11d4-a716-446655440000',
    'customer:550e8400-e29b-41d4-a716-446655440000',
  ]);
});

test('deletion ledger stores request deletions separately and lists them for replay', async () => {
  const stored = new Map<string, string>();
  const ctx = {
    storage: {
      async list({ prefix }: { prefix: string }) {
        const keys = [...stored.keys()].filter((key) => key.startsWith(prefix));
        return { keys: () => keys };
      },
      async put(key: string, value: string) { stored.set(key, value); },
    },
  };
  const ledger = new (DeletionLedger as any)(ctx, {}) as { fetch(request: Request): Promise<Response> };
  const post = (body: unknown) => ledger.fetch(new Request('https://ledger.internal/deletions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  const customer = '550e8400-e29b-41d4-a716-446655440000';
  const request = '650e8400-e29b-41d4-a716-446655440001';
  assert.equal((await post({ id: customer })).status, 204);
  assert.equal((await post({ id: request, kind: 'request' })).status, 204);
  assert.equal((await post({ id: request, kind: 'unknown' })).status, 422);
  const listed = await (await ledger.fetch(new Request('https://ledger.internal/deletions'))).json();
  assert.deepEqual(listed, { ids: [customer], requestIds: [request] });
});

test('replayDeletions also purges deleted requests', async () => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const db = {
    transaction<T>(callback: () => T) { return () => callback(); },
    prepare(sql: string) {
      return {
        get() { return undefined; },
        all() { return []; },
        run(...values: unknown[]) { statements.push({ sql, values }); return { changes: 1 }; },
      };
    },
    pragma() { return []; },
  };
  const request = '650e8400-e29b-41d4-a716-446655440001';
  const instance = Object.create((SeltivoData as any).prototype) as any;
  instance.db = db;
  instance.ledger = { fetch: async () => Response.json({ ids: [], requestIds: [request] }) };
  assert.equal(await instance.replayDeletions(), true);
  assert.ok(statements.some((entry) => entry.sql.includes('DELETE FROM requests WHERE id=?') && entry.values[0] === request));
});
