import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const MAX_OBJECTS = 200;
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const metadata = z.object({ contentType: z.string().optional(), contentLanguage: z.string().optional(), contentDisposition: z.string().optional(), contentEncoding: z.string().optional(), cacheControl: z.string().optional(), cacheExpiry: z.iso.datetime().optional() }).strict();
export type SnapshotStore = {
  list(options: { prefix?: string; cursor?: string; limit: number }): Promise<{ objects: { key: string; size: number; etag: string; uploaded?: Date }[]; truncated: boolean; cursor?: string }>;
  get(key: string): Promise<{ etag: string; size: number; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string>; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, data: string | Uint8Array, options?: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> }): Promise<unknown>;
};
const manifestSchema = z.object({
  format: z.literal('seltivo-r2-v1'), createdAt: z.iso.datetime(),
  objects: z.array(z.object({ key: z.string().min(1).max(1024), backupKey: z.string(), size: z.number().int().min(0).max(MAX_OBJECT_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/), httpMetadata: metadata.optional(), customMetadata: z.record(z.string(), z.string()).optional() }).strict()).max(MAX_OBJECTS),
}).strict();
const manifestPattern = /^seltivo-backups\/v1\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\/r2-manifest\.json$/;
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
async function inventory(store: SnapshotStore) {
  const objects: { key: string; size: number; etag: string; uploaded?: Date }[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ cursor, limit: MAX_OBJECTS + 1 });
    objects.push(...page.objects);
    if (objects.length > MAX_OBJECTS) throw new Error('R2 snapshot exceeds 200 objects; use a batched backup workflow before increasing this limit');
    if (!page.truncated) break;
    if (!page.cursor || page.cursor === cursor) throw new Error('Invalid R2 listing cursor');
    cursor = page.cursor;
  } while (true);
  if (objects.some((item) => item.size > MAX_OBJECT_BYTES) || objects.reduce((sum, item) => sum + item.size, 0) > MAX_TOTAL_BYTES) throw new Error('R2 snapshot exceeds backup byte limits');
  return objects.sort((a, b) => a.key.localeCompare(b.key));
}
export async function createR2Backup(source: SnapshotStore, destination: SnapshotStore, at = new Date()) {
  const initial = await inventory(source);
  const base = `seltivo-backups/v1/${at.toISOString().slice(0, 10)}/${randomUUID()}/`;
  const manifest: z.infer<typeof manifestSchema> = { format: 'seltivo-r2-v1', createdAt: at.toISOString(), objects: [] };
  let bytes = 0;
  for (const [index, item] of initial.entries()) {
    const object = await source.get(item.key);
    if (!object || object.etag !== item.etag || object.size !== item.size) throw new Error('R2 source changed during backup');
    const data = new Uint8Array(await object.arrayBuffer());
    if (data.length !== item.size) throw new Error('R2 source changed during backup');
    const backupKey = `${base}objects/${index}`;
    const { cacheExpiry, ...http } = object.httpMetadata ?? {};
    const httpMetadata = metadata.parse({ ...http, ...(cacheExpiry ? { cacheExpiry: cacheExpiry.toISOString() } : {}) });
    await destination.put(backupKey, data);
    manifest.objects.push({ key: item.key, backupKey, size: data.length, sha256: hash(data), httpMetadata, customMetadata: object.customMetadata });
    bytes += data.length;
  }
  if (JSON.stringify(initial) !== JSON.stringify(await inventory(source))) throw new Error('R2 source changed during backup');
  manifestSchema.parse(manifest);
  const key = `${base}r2-manifest.json`;
  await destination.put(key, JSON.stringify(manifest));
  return { key, manifest, bytes };
}

/** Restore only into a new empty bucket, then verify before switching bindings. */
export async function restoreR2Backup(backups: SnapshotStore, target: SnapshotStore, key: string) {
  if (!manifestPattern.test(key)) throw new Error('Invalid R2 backup manifest key');
  if ((await target.list({ limit: 1 })).objects.length) throw new Error('Restore target must be empty');
  const object = await backups.get(key);
  if (!object || object.size > 1024 * 1024) throw new Error('Missing or oversized R2 manifest');
  const manifest = manifestSchema.parse(JSON.parse(new TextDecoder().decode(await object.arrayBuffer())));
  const base = key.slice(0, -'r2-manifest.json'.length);
  if (new Set(manifest.objects.map((item) => item.key)).size !== manifest.objects.length || manifest.objects.some((item, index) => item.backupKey !== `${base}objects/${index}`) || manifest.objects.reduce((sum, item) => sum + item.size, 0) > MAX_TOTAL_BYTES) throw new Error('Invalid R2 manifest inventory');
  async function verified(item: typeof manifest.objects[number]) {
    const saved = await backups.get(item.backupKey);
    if (!saved || saved.size !== item.size) throw new Error('R2 backup checksum mismatch');
    const data = new Uint8Array(await saved.arrayBuffer());
    if (data.length !== item.size || hash(data) !== item.sha256) throw new Error('R2 backup checksum mismatch');
    return data;
  }
  // Validate every object before writing anything; revalidate each read during copy.
  for (const item of manifest.objects) await verified(item);
  for (const item of manifest.objects) await target.put(item.key, await verified(item), { httpMetadata: item.httpMetadata ? { ...item.httpMetadata, cacheExpiry: item.httpMetadata.cacheExpiry ? new Date(item.httpMetadata.cacheExpiry) : undefined } : undefined, customMetadata: item.customMetadata });
  return { objects: manifest.objects.length, bytes: manifest.objects.reduce((sum, item) => sum + item.size, 0) };
}
