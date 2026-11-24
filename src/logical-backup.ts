import { randomUUID } from 'node:crypto';
import type { SeltivoDb } from './db.js';
import { MIGRATIONS } from './schema.js';
import { purgeCustomer, purgeRequest } from './delete-account.js';

const tables = [
  'users', 'sessions', 'auth_tokens', 'configurations', 'requests',
  'conversations', 'messages', 'conversation_reads', 'request_events',
  'audit_log', 'email_notifications', 'notifications', 'admin_two_factor', 'guest_requests',
] as const;
type Table = typeof tables[number];
type Row = Record<string, string | number | null>;
export type Store = {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
};
type Chunk = { key: string; table: Table; rows: number; bytes: number; sha256: string; iv?: string };
export type BackupManifest = {
  format: 'seltivo-logical-v1';
  createdAt: string;
  schemaVersion: number;
  encryption?: 'aes-gcm-256';
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
  const actual = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','rate_limit_hits','__miniflare_do_name') AND substr(name,1,5) != '__cf_' AND substr(name,1,4) != '_cf_'").all() as { name: string }[])
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

const encryptionMarker = 'aes-gcm-256' as const;
const invalidKeyError = 'Backup encryption key must be a base64-encoded 32-byte key';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encryptionKeyBytes(key: string): Uint8Array {
  const normalized = key.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) throw new Error(invalidKeyError);
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  } catch {
    throw new Error(invalidKeyError);
  }
  if (bytes.byteLength !== 32) throw new Error(invalidKeyError);
  return bytes;
}

async function aesGcmKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Keyset-пагінація за rowid: OFFSET змушував SQLite щоразу проходити всі попередні
// рядки, і копія великої таблиці ставала квадратичною за часом.
function rowsAfter(db: SeltivoDb, table: Table, limit: number, afterRowid: number): { rows: Row[]; lastRowid: number } {
  const raw = db.prepare(`SELECT rowid AS __backup_rowid, * FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`).all(afterRowid, limit) as Row[];
  let lastRowid = afterRowid;
  const rows = raw.map(({ __backup_rowid, ...row }) => {
    lastRowid = Number(__backup_rowid);
    return row;
  });
  for (const row of rows) {
    if (Object.values(row).some((value) => value !== null && (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))))) {
      throw new Error(`Unsupported backup value in ${table}`);
    }
  }
  return { rows, lastRowid };
}

// Each chunk is independent and the manifest is written only after a consistent read.
// Incomplete runs leave orphan chunks, which the 30-day R2 lifecycle removes.
export async function createLogicalBackup(db: SeltivoDb, store: Store, at = new Date(), encryptionKey?: string): Promise<{ key: string; manifest: BackupManifest; bytes: number }> {
  assertSchema(db);
  const cryptoKey = encryptionKey === undefined ? null : await aesGcmKey(encryptionKeyBytes(encryptionKey));
  const startedAt = changes(db);
  const base = `${prefix}${at.toISOString().slice(0, 10)}/${randomUUID()}/`;
  const manifest: BackupManifest = {
    format: 'seltivo-logical-v1', createdAt: at.toISOString(), schemaVersion: latestVersion,
    ...(cryptoKey ? { encryption: encryptionMarker } : {}),
    chunks: [], rowCounts: Object.fromEntries(tables.map((table) => [table, 0])) as Record<Table, number>,
  };
  const maxChunkBytes = 16 * 1024 * 1024;
  const targetChunkBytes = 8 * 1024 * 1024;
  let totalBytes = 0;
  const flushChunk = async (table: Table, chunkIndex: number, rows: Row[]) => {
    const plaintext = JSON.stringify(rows);
    const checksum = await sha256(plaintext);
    let stored = plaintext;
    let iv: string | undefined;
    if (cryptoKey) {
      const ivBytes = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBytes }, cryptoKey, encoder.encode(plaintext));
      stored = bytesToBase64(new Uint8Array(ciphertext));
      iv = bytesToBase64(ivBytes);
    }
    const bytes = encoder.encode(stored).byteLength;
    if (bytes > maxChunkBytes) throw new Error(`Backup chunk too large: ${table}`);
    const chunkKey = `${base}${table}/${String(chunkIndex).padStart(10, '0')}.json`;
    await store.put(chunkKey, stored);
    manifest.chunks.push({ key: chunkKey, table, rows: rows.length, bytes, sha256: checksum, ...(iv ? { iv } : {}) });
    manifest.rowCounts[table] += rows.length;
    totalBytes += bytes;
  };
  for (const table of tables) {
    if (table === 'configurations' || table === 'requests') {
      let chunkRows: Row[] = [];
      let chunkBytes = 2;
      let chunkStartIndex = 0;
      let index = 0;
      for (let afterRowid = 0; ;) {
        const page = rowsAfter(db, table, 1, afterRowid);
        if (!page.rows.length) break;
        afterRowid = page.lastRowid;
        const row = page.rows[0];
        const rowBytes = encoder.encode(JSON.stringify(row)).byteLength + 1;
        if (rowBytes + 2 > maxChunkBytes) throw new Error(`Backup chunk too large: ${table}`);
        if (chunkRows.length > 0 && (chunkBytes + rowBytes > targetChunkBytes || chunkRows.length >= 50)) {
          await flushChunk(table, chunkStartIndex, chunkRows);
          chunkRows = [];
          chunkBytes = 2;
          chunkStartIndex = index;
        }
        chunkRows.push(row);
        chunkBytes += rowBytes;
        index += 1;
      }
      if (chunkRows.length > 0) await flushChunk(table, chunkStartIndex, chunkRows);
    } else {
      const limit = 100;
      for (let afterRowid = 0, index = 0; ; index += limit) {
        const page = rowsAfter(db, table, limit, afterRowid);
        if (!page.rows.length) break;
        afterRowid = page.lastRowid;
        await flushChunk(table, index, page.rows);
      }
    }
  }
  if (changes(db) !== startedAt) throw new Error(CONCURRENT_WRITE);
  const key = `${base}manifest.json`;
  await store.put(key, JSON.stringify(manifest));
  return { key, manifest, bytes: totalBytes };
}

export async function restoreLogicalBackup(db: SeltivoDb, store: Store, manifestKey: string, deletedIds: Iterable<string> = [], encryptionKey?: string, deletedRequestIds: Iterable<string> = []): Promise<BackupManifest> {
  if (!manifestKeyPattern.test(manifestKey)) throw new Error('Invalid backup manifest key');
  assertSchema(db);
  const object = await store.get(manifestKey);
  if (!object) throw new Error('Backup manifest missing');
  const manifest = JSON.parse(await object.text()) as BackupManifest;
  if (manifest.format !== 'seltivo-logical-v1' || !Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1 || !Array.isArray(manifest.chunks)) {
    throw new Error('Incompatible backup manifest');
  }
  // Older backups omit columns added by later migrations; a subset INSERT is valid.
  // Semantic migrations have no DDL to replay, so v9's de-verification is applied
  // explicitly after rows and confirmed deletions are imported (see below).
  if (manifest.schemaVersion > latestVersion) throw new Error(`Backup schema version ${manifest.schemaVersion} is newer than this application (${latestVersion})`);
  if (manifest.encryption !== undefined && manifest.encryption !== encryptionMarker) throw new Error(`Unsupported backup encryption marker: ${String(manifest.encryption)}`);
  let cryptoKey: CryptoKey | null = null;
  if (manifest.encryption === encryptionMarker) {
    if (!encryptionKey) throw new Error('Backup is encrypted but no encryption key was provided');
    cryptoKey = await aesGcmKey(encryptionKeyBytes(encryptionKey));
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
    const stored = await part.text();
    if (encoder.encode(stored).byteLength !== chunk.bytes) throw new Error('Backup chunk checksum mismatch');
    let data = stored;
    if (cryptoKey) {
      if (!chunk.iv) throw new Error('Backup chunk missing encryption IV');
      try {
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(chunk.iv) }, cryptoKey, base64ToBytes(stored));
        data = new TextDecoder().decode(plaintext);
      } catch {
        throw new Error('Backup chunk decryption failed');
      }
    }
    if (await sha256(data) !== chunk.sha256) throw new Error('Backup chunk checksum mismatch');
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
  for (const id of deletedRequestIds) purgeRequest(db, id);
  // v9 was a data-only migration: backups taken before it still carry verified
  // customers and their live sessions. Replay its effect so an old backup cannot
  // restore verification or sessions that migration v9 intentionally revoked.
  // Admin accounts are unaffected, exactly as in MIGRATIONS v9.
  if (manifest.schemaVersion < 9) {
    db.transaction(() => {
      db.prepare("UPDATE users SET email_verified_at=NULL WHERE role='customer'").run();
      db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role='customer')").run();
    })();
  }
  if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Foreign key violation after backup restore');
  return manifest;
}

const CONCURRENT_WRITE = 'Database changed during backup; no manifest published';

/**
 * Будь-який запис під час експорту (вхід, повідомлення) скасовує копію. Повторюємо
 * лише цю ситуацію; інші помилки (ключ, схема, R2) одразу йдуть в алерти.
 */
export async function createLogicalBackupWithRetry(db: SeltivoDb, store: Store, at = new Date(), encryptionKey?: string, { attempts = 3, delayMs = 5_000 }: { attempts?: number; delayMs?: number } = {}): Promise<{ key: string; manifest: BackupManifest; bytes: number; attempts: number }> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { ...await createLogicalBackup(db, store, at, encryptionKey), attempts: attempt };
    } catch (error) {
      if (attempt >= attempts || !(error instanceof Error) || error.message !== CONCURRENT_WRITE) throw error;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
