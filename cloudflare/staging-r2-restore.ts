import { createHash, randomUUID } from 'node:crypto';
import { restoreR2Backup, type SnapshotStore } from '../src/r2-backup.js';

type Bucket = SnapshotStore & { delete(keys: string[]): Promise<void> };
export async function checkR2Restore(backups: SnapshotStore, bucket: Bucket, manifestKey: string) {
  const prefix = `restore-checks/${randomUUID()}/`;
  const written = new Map<string, string>();
  const target: SnapshotStore = {
    list: (options) => bucket.list({ ...options, prefix }),
    get: (key) => bucket.get(prefix + key),
    async put(key, data, options) {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const fullKey = prefix + key;
      written.set(fullKey, createHash('sha256').update(bytes).digest('hex'));
      return bucket.put(fullKey, data, options);
    },
  };
  try {
    const restored = await restoreR2Backup(backups, target, manifestKey);
    for (const [key, expected] of written) {
      const object = await bucket.get(key);
      if (!object || object.size > 16 * 1024 * 1024 || createHash('sha256').update(new Uint8Array(await object.arrayBuffer())).digest('hex') !== expected) throw new Error('Restored R2 object checksum mismatch');
    }
    return { ok: true, ...restored };
  } finally {
    if (written.size) await bucket.delete([...written.keys()]);
  }
}
