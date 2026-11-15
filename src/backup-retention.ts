const prefix = 'seltivo-backups/v1/';
const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

type BackupStore = {
  list(options: { prefix: string; cursor?: string; limit: number }): Promise<{
    objects: { key: string; uploaded: Date }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string[]): Promise<void>;
};

// R2 lifecycle can lag after expiration. This sweep removes expired backup
// objects explicitly, while the bucket lifecycle remains a fallback.
export async function pruneExpiredBackups(store: BackupStore, at = new Date()): Promise<number> {
  const cutoff = at.getTime() - thirtyDaysMs;
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await store.list({ prefix, cursor, limit: 1000 });
    const expired = page.objects.filter((object) => object.uploaded.getTime() <= cutoff).map((object) => object.key);
    if (expired.length) {
      await store.delete(expired);
      deleted += expired.length;
    }
    if (!page.truncated) break;
    if (!page.cursor || page.cursor === cursor) throw new Error('Invalid R2 listing cursor');
    cursor = page.cursor;
  } while (true);
  return deleted;
}
