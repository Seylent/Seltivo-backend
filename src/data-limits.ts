import type { SeltivoDb } from './db.js';

export const DEFAULT_DATA_LIMITS = {
  accountBytes: 64 * 1024 * 1024,
  databaseBytes: 512 * 1024 * 1024,
  requestsPerAccount: 200,
  messagesPerConversation: 2000,
  guestRequests: 50_000,
} as const;
export type DataLimits = { [K in keyof typeof DEFAULT_DATA_LIMITS]: number };

export function dataLimits(overrides: Partial<DataLimits> = {}): DataLimits {
  const limits = { ...DEFAULT_DATA_LIMITS, ...overrides };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid data limits');
  return limits;
}

export function accountBytes(db: SeltivoDb, userId: string): number {
  const bytes = (sql: string) => (db.prepare(sql).get(userId) as { bytes: number }).bytes;
  return bytes('SELECT COALESCE(SUM(length(CAST(data_json AS BLOB))),0) bytes FROM configurations WHERE owner_id=? AND deleted_at IS NULL')
    + bytes("SELECT COALESCE(SUM(length(CAST(COALESCE(config_snapshot_json,'')||contact_json||note||features_json AS BLOB))),0) bytes FROM requests WHERE customer_id=?")
    + bytes('SELECT COALESCE(SUM(length(CAST(m.body AS BLOB))),0) bytes FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN requests r ON r.id=c.request_id WHERE r.customer_id=?');
}
