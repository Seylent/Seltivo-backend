import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pruneExpiredBackups } from '../src/backup-retention.js';

test('backup sweep deletes only expired backup objects across listing pages', async () => {
  const at = new Date('2026-11-15T12:00:00.000Z');
  const removed: string[][] = [];
  const store = {
    async list({ cursor }: { prefix: string; cursor?: string; limit: number }) {
      if (!cursor) return { objects: [
        { key: 'seltivo-backups/v1/old/chunk.json', uploaded: new Date('2026-10-15T11:00:00.000Z') },
        { key: 'seltivo-backups/v1/new/chunk.json', uploaded: new Date('2026-11-01T12:00:00.000Z') },
      ], truncated: true, cursor: 'next' };
      return { objects: [
        { key: 'seltivo-backups/v1/at-boundary/manifest.json', uploaded: new Date('2026-10-16T12:00:00.000Z') },
        { key: 'seltivo-backups/v1/new/manifest.json', uploaded: new Date('2026-11-01T12:00:00.000Z') },
      ], truncated: false };
    },
    async delete(keys: string[]) { removed.push(keys); },
  };
  assert.equal(await pruneExpiredBackups(store, at), 2);
  assert.deepEqual(removed.flat(), [
    'seltivo-backups/v1/old/chunk.json',
    'seltivo-backups/v1/at-boundary/manifest.json',
  ]);
});

test('backup sweep rejects a stalled listing cursor', async () => {
  const store = {
    async list() { return { objects: [], truncated: true, cursor: 'stalled' }; },
    async delete(_keys: string[]) { throw new Error('unexpected delete'); },
  };
  await assert.rejects(pruneExpiredBackups(store), /Invalid R2 listing cursor/);
});
