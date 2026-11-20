import { randomUUID } from 'node:crypto';
import type { SeltivoDb } from './db.js';
import { MIGRATIONS } from './schema.js';
import { purgeCustomer } from './delete-account.js';

const tables = [
  'users', 'sessions', 'auth_tokens', 'configurations', 'requests',
  'conversations', 'messages', 'conversation_reads', 'request_events',
  'audit_log', 'email_notifications', 'notifications', 'admin_two_factor', 'guest_requests',
] as const;
type Table = typeof tables[number];
type Row = Record<string, string | number | null>;
type Store = {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
};
type Chunk = { key: string; table: Table; rows: number; bytes: number; sha256: string };
export type BackupManifest = {
  format: 'seltivo-logical-v1';
  createdAt: string;
  schemaVersion: number;
  chunks: Chunk[];
  rowCounts: Record<Table, number>;
};

const latestVersion = MIGRATIONS.at(-1)?.version ?? 0;
const prefix = 'seltivo-backups/v1/';
//Keys come from a staging operator / internal call — validate the full shape, not just a prefix,
// so `../` segments cannot escape the backup namespace.
const manifestKeyPattern = /^seltivo-backups\/v1\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\/manifest\.json$/;
const encoder = new TextEncoder();

function version(db: SeltivoDb): number {
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number };
  return Number(row.version);
}

function assertSchema(db: SeltivoDb): void {
  if (version(db) !== latestVersion) throw new Error('Backup schema version does not match application');
  const actual = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','__miniflare_do_name') AND substr(name,1,5) != '__cf_' AND substr(name,1,4) != '_cf_'").all() as { name: string }[])
    .map((row) => row.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...tables].sort())) throw new Error('Backup table inventory does not match application');
}

function changes(db: SeltivoDb): number {
  return Number((db.prepare('SELECT total_changes() AS count').get() as { count: number }).count);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function rowsFor(db: SeltivoDb, table: Table, limit: number, offset: number): Row[] {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`).all(limit, offset) as Row[];
  for (const row of rows) {
    if (Object.values(row).some((value) => value !== null && (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))))) {
      throw new Error(`Unsupported backup value in ${table}`);
    }
  }
  return rows;
}

// Each chunk is independent and the manifest is written only after a consistent read.
// Incomplete runs leave orphan chunks, which the 30-day R2 lifecycle removes.
export async function createLogicalBackup(db: SeltivoDb, store: Store, at = new Date()): Promise<{ key: string; manifest: BackupManifest; bytes: number }> {
  assertSchema(db);
  const startedAt = changes(db);
  const base = `${prefix}${at.toISOString().slice(0, 10)}/${randomUUID()}/`;
  const manifest: BackupManifest = {
    format: 'seltivo-logical-v1', createdAt: at.toISOString(), schemaVersion: latestVersion,
    chunks: [], rowCounts: Object.fromEntries(tables.map((table) => [table, 0])) as Record<Table, number>,
  };
  const maxChunkBytes = 16 * 1024 * 1024;
  const targetChunkBytes = 8 * 1024 * 1024;
  let totalBytes = 0;
  const flushChunk = async (table: Table, chunkIndex: number, rows: Row[]) => {
    const data = JSON.stringify(rows);
    const bytes = encoder.encode(data).byteLength;
    if (bytes > maxChunkBytes) throw new Error(`Backup chunk too large: ${table}`);
    const key = `${base}${table}/${String(chunkIndex).padStart(10, '0')}.json`;
    await store.put(key, data);
    manifest.chunks.push({ key, table, rows: rows.length, bytes, sha256: await sha256(data) });
    manifest.rowCounts[table] += rows.length;
    totalBytes += bytes;
  };
  for (const table of tables) {
    if (table === 'configurations' || table === 'requests') {
      let chunkRows: Row[] = [];
      let chunkBytes = 2;
      let chunkStartOffset = 0;
      for (let offset = 0; ; offset += 1) {
        const rows = rowsFor(db, table, 1, offset);
        if (!rows.length) break;
        const row = rows[0];
        const rowBytes = encoder.encode(JSON.stringify(row)).byteLength + 1;
        if (rowBytes + 2 > maxChunkBytes) throw new Error(`Backup chunk too large: ${table}`);
        if (chunkRows.length > 0 && (chunkBytes + rowBytes > targetChunkBytes || chunkRows.length >= 50)) {
          await flushChunk(table, chunkStartOffset, chunkRows);
          chunkRows = [];
          chunkBytes = 2;
          chunkStartOffset = offset;
        }
        chunkRows.push(row);
        chunkBytes += rowBytes;
      }
      if (chunkRows.length > 0) await flushChunk(table, chunkStartOffset, chunkRows);
    } else {
      const limit = 100;
      for (let offset = 0; ; offset += limit) {
        const rows = rowsFor(db, table, limit, offset);
        if (!rows.length) break;
        await flushChunk(table, offset, rows);
      }
    }
  }
  if (changes(db) !== startedAt) throw new Error('Database changed during backup; no manifest published');
  const key = `${base}manifest.json`;
  await store.put(key, JSON.stringify(manifest));
  return { key, manifest, bytes: totalBytes };
}

export async function restoreLogicalBackup(db: SeltivoDb, store: Store, manifestKey: string, deletedIds: Iterable<string> = []): Promise<BackupManifest> {
  if (!manifestKeyPattern.test(manifestKey)) throw new Error('Invalid backup manifest key');
  assertSchema(db);
  const object = await store.get(manifestKey);
  if (!object) throw new Error('Backup manifest missing');
  const manifest = JSON.parse(await object.text()) as BackupManifest;
  if (manifest.format !== 'seltivo-logical-v1' || manifest.schemaVersion !== latestVersion || !Array.isArray(manifest.chunks)) {
    throw new Error('Incompatible backup manifest');
  }
  const base = manifestKey.slice(0, -'manifest.json'.length);
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const chunkPattern = new RegExp(`^${escapedBase}(${tables.join('|')})/\\d{10}\\.json$`);
  const actualCounts = Object.fromEntries(tables.map((table) => [table, 0])) as Record<Table, number>;
  for (const table of tables) {
    if ((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count !== 0) {
      throw new Error('Restore target must have empty application tables');
    }
  }
  for (const chunk of manifest.chunks) {
    if (!tables.includes(chunk.table) || !chunkPattern.test(chunk.key)) throw new Error('Invalid backup chunk key');
    const part = await store.get(chunk.key);
    if (!part) throw new Error('Backup chunk missing');
    const data = await part.text();
    if (encoder.encode(data).byteLength !== chunk.bytes || await sha256(data) !== chunk.sha256) throw new Error('Backup chunk checksum mismatch');
    const rows = JSON.parse(data) as Row[];
    if (!Array.isArray(rows) || rows.length !== chunk.rows) throw new Error('Backup chunk row count mismatch');
    const allowed = new Set((db.prepare(`PRAGMA table_info(${chunk.table})`).all() as { name: string }[]).map((column) => column.name));
    db.transaction(() => {
      for (const row of rows) {
        const columns = Object.keys(row);
        if (!columns.length || columns.some((column) => !allowed.has(column))) throw new Error('Invalid backup column');
        const values = columns.map((column) => row[column]);
        if (values.some((value) => value !== null && (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))))) throw new Error('Invalid backup value');
        db.prepare(`INSERT INTO ${chunk.table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values);
      }
    })();
    actualCounts[chunk.table] += rows.length;
  }
  for (const table of tables) {
    if (actualCounts[table] !== manifest.rowCounts?.[table]) throw new Error('Backup table row count mismatch');
  }
  for (const id of deletedIds) purgeCustomer(db, id);
  if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Foreign key violation after backup restore');
  return manifest;
}
