import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const origin = process.env.SELTIVO_STAGING_ORIGIN ?? 'https://seltivo-staging.seltivostudio.workers.dev';
const backend = process.env.SELTIVO_STAGING_API ?? 'https://seltivo-api-staging.seltivostudio.workers.dev';
function readStagingKey() {
  if (process.env.SELTIVO_STAGING_TEST_KEY) return process.env.SELTIVO_STAGING_TEST_KEY.trim();
  try {
    return readFileSync('.wrangler/codex-staging-key.txt', 'utf8').trim();
  } catch {
    return '';
  }
}
const key = readStagingKey();
if (!key) {
  throw new Error('SELTIVO_STAGING_TEST_KEY is required: temporarily set the staging-only secret with `npx wrangler secret put SELTIVO_STAGING_TEST_KEY --env staging` (or put the key in .wrangler/codex-staging-key.txt), run the drill, then remove it with `npx wrangler secret delete SELTIVO_STAGING_TEST_KEY --env staging`. See docs/cloudflare-operations.md for the drill procedure; never use a production key.');
}

async function api(method, path, body, cookie) {
  const response = await fetch(`${origin}${path}`, { method, headers: {
    Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: response.status === 204 ? null : await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function internal(path, body) {
  const response = await fetch(`${backend}/internal/staging/${path}`, { method: 'POST', headers: {
    Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify(body) });
  assert.equal(response.status, path === 'admin-fixture' ? 201 : 200, `${path} returned ${response.status}`);
  return response.status === 201 ? null : response.json();
}

assert.equal((await api('GET', '/api/v1/health')).status, 200);
const admins = await Promise.all([0, 1].map(async () => {
  const email = `staging-admin-${randomUUID()}@example.test`;
  const password = `AdminSmoke-${randomUUID()}!`;
  await internal('admin-fixture', { email, password });
  const login = await api('POST', '/api/v1/auth/login', { email, password });
  assert.equal(login.status, 200);
  return { email, password };
}));

const customers = [];
for (const label of ['Alice', 'Bob']) {
  const email = `restore-${label.toLowerCase()}-${randomUUID()}@example.test`;
  const password = `CustomerSmoke-${randomUUID()}!`;
  assert.equal((await api('POST', '/api/v1/auth/register', { email, password, name: label })).status, 201);
  const login = await api('POST', '/api/v1/auth/login', { email, password });
  assert.equal(login.status, 200);
  const cookie = login.cookie;
  assert.ok(cookie);
  const submission = { templateId: 'fashion-01', templateName: 'Fashion 01', contact: { name: label }, clientSubmissionId: randomUUID() };
  const first = await api('POST', '/api/v1/requests', submission, cookie);
  assert.equal(first.status, 201);
  const retry = await api('POST', '/api/v1/requests', submission, cookie);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.id, first.body.id);
  const message = { body: `Restore smoke from ${label}`, clientMessageId: randomUUID() };
  assert.equal((await api('POST', `/api/v1/requests/${first.body.id}/messages`, message, cookie)).status, 201);
  assert.equal((await api('POST', `/api/v1/requests/${first.body.id}/messages`, message, cookie)).status, 200);
  customers.push({ email, password, requestId: first.body.id });
}

const backup = await internal('backup', {});
assert.match(backup.key, /^seltivo-backups\/v1\/.+\/manifest\.json$/);
const restored = await internal('restore-check', { manifestKey: backup.key, customers, admins });
assert.equal(restored.ok, true);
assert.ok(restored.restoredRows >= 8);
console.log(`Staging restore passed: ${restored.restoredRows} rows, two customers, two admins, request history and chat.`);
