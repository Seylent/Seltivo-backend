import type { SeltivoDb } from './db.js';
import { SCHEMA_SQL } from './schema.js';

type SqlCursor = { toArray(): Record<string, unknown>[] };
type Sql = { exec(query: string, ...values: (string | number | null)[]): SqlCursor };
type Storage = { sql: Sql; transactionSync<T>(callback: () => T): T };

// The API's SQL is synchronous. A SQLite-backed Durable Object preserves that
// contract while providing persistent storage and serializing concurrent writes.
export function openCloudflareDatabase(storage: Storage): SeltivoDb {
  const { sql } = storage;
  sql.exec(SCHEMA_SQL);
  const database = {
    prepare(query: string) {
      return {
        get(...values: (string | number | null)[]) {
          return sql.exec(query, ...values).toArray()[0];
        },
        all(...values: (string | number | null)[]) {
          return sql.exec(query, ...values).toArray();
        },
        run(...values: (string | number | null)[]) {
          sql.exec(query, ...values);
          const { changes } = sql.exec('SELECT changes() AS changes').toArray()[0] as { changes: number };
          const { id } = sql.exec('SELECT last_insert_rowid() AS id').toArray()[0] as { id: number };
          return { changes, lastInsertRowid: id };
        },
      };
    },
    transaction<T>(callback: () => T) {
      return () => storage.transactionSync(callback);
    },
    pragma(name: string) {
      if (name !== 'quick_check') throw new Error(`Unsupported pragma: ${name}`);
      return Object.values(sql.exec('PRAGMA quick_check').toArray()[0])[0];
    },
  };
  return database as unknown as SeltivoDb;
}
