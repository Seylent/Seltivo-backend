import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createR2Backup, restoreR2Backup, type SnapshotStore } from '../src/r2-backup.js';
function memoryStore() {
  const files = new Map<string, Uint8Array>();
  const store: SnapshotStore = {
    async list(options) { return { objects: [...files].filter(([key]) => !options.prefix || key.startsWith(options.prefix)).map(([key, data]) => ({ key, size: data.length, etag: Buffer.from(data).toString('base64') })), truncated: false }; },
    async get(key) { const data = files.get(key); return data ? { etag: Buffer.from(data).toString('base64'), size: data.length, arrayBuffer: async () => Uint8Array.from(data).buffer } : null; },
    async put(key, data) { files.set(key, typeof data === 'string' ? new TextEncoder().encode(data) : Uint8Array.from(data)); return {}; },
  };
  return { files, store };
}
test('R2 backup restores catalog, published files and aggregates into an empty bucket', async () => {
  const source = memoryStore(), backups = memoryStore(), restored = memoryStore();
  for (const [key, value] of [['catalog.json', '{"templates":[]}'], ['sites/shop/build/index.html', '<h1>Shop</h1>'], ['analytics/day.json', '{"views":1}']]) await source.store.put(key, value);
  const result = await createR2Backup(source.store, backups.store);
  assert.equal(result.manifest.objects.length, 3);
  await restoreR2Backup(backups.store, restored.store, result.key);
  assert.deepEqual(restored.files, source.files);
  await assert.rejects(restoreR2Backup(backups.store, restored.store, result.key), /empty/);
});
test('R2 restore rejects damaged backup content and keys outside its snapshot', async () => {
  const source = memoryStore(), backups = memoryStore(), restored = memoryStore();
  await source.store.put('catalog.json', '{}');
  const result = await createR2Backup(source.store, backups.store);
  backups.files.set(result.manifest.objects[0].backupKey, new TextEncoder().encode('corrupted'));
  await assert.rejects(restoreR2Backup(backups.store, restored.store, result.key), /checksum/);
  assert.equal(restored.files.size, 0);
  await assert.rejects(restoreR2Backup(backups.store, restored.store, '../outside/manifest.json'), /manifest key/);
});
test('concurrent source edits prevent publishing a completed R2 backup', async () => {
  const source = memoryStore(), backups = memoryStore();
  await source.store.put('catalog.json', '{}');
  const get = source.store.get;
  source.store.get = async (key) => { const value = await get(key); await source.store.put(key, '{"changed":true}'); return value; };
  await assert.rejects(createR2Backup(source.store, backups.store), /changed/);
  assert.ok(![...backups.files.keys()].some((key) => key.endsWith('r2-manifest.json')));
});

import { checkR2Restore } from '../cloudflare/staging-r2-restore.js';
test('staging R2 drill verifies restored content and removes only its own temporary keys', async () => {
  const source = memoryStore(), backups = memoryStore(), staging = memoryStore();
  await source.store.put('catalog.json', '{"templates":[]}');
  await staging.store.put('catalog.json', '{"staging":true}');
  const result = await createR2Backup(source.store, backups.store);
  const bucket = { ...staging.store, async delete(keys: string[]) { keys.forEach((key) => staging.files.delete(key)); } };
  assert.deepEqual(await checkR2Restore(backups.store, bucket, result.key), { ok: true, objects: 1, bytes: 16 });
  assert.deepEqual([...staging.files.keys()], ['catalog.json']);
});
