import type { SeltivoDb } from './db.js';
import { MIGRATIONS, SCHEMA_SQL } from './schema.js';

type SqlCursor = { toArray(): Record<string, unknown>[] };
type Sql = { exec(query: string, ...values: (string | number | null)[]): SqlCursor };
type Storage = { sql: Sql; transactionSync<T>(callback: () => T): T };

function normalizedSql(value: string): string {
  return value.replace(/\bIF NOT EXISTS\b\s*/gi, '').replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim().replace(/;$/, '');
}

function checkLegacySchema(sql: Sql): void {
  const expected = [...SCHEMA_SQL.matchAll(/CREATE (TABLE|INDEX) IF NOT EXISTS ([a-z_]+)\s*[\s\S]*?;/g)].map((match) => ({
    type: match[1].toLowerCase(), name: match[2], definition: normalizedSql(match[0]),
  }));
  const actual = new Map(sql.exec("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'")
    .toArray().map((entry) => [`${entry.type}:${entry.name}`, normalizedSql(String(entry.sql))]));
  for (const entry of expected) {
    if (actual.get(`${entry.type}:${entry.name}`) !== entry.definition) {
      throw new Error(`incompatible legacy schema: ${entry.name}`);
    }
  }
}

function migrate(storage: Storage): void {
  const { sql } = storage;
  const latest = MIGRATIONS.at(-1)?.version ?? 0;
  MIGRATIONS.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error('Database migrations must have consecutive versions');
  });
  storage.transactionSync(() => {
    sql.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const current = Number(sql.exec('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').toArray()[0].version);
    if (current > latest) throw new Error(`Database version ${current} is newer than this application (${latest})`);
    const legacy = current === 0 && sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").toArray().length > 0;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      sql.exec(migration.sql);
      if (migration.version === 1 && legacy) checkLegacySchema(sql);
      if (sql.exec('PRAGMA foreign_key_check').toArray().length) throw new Error(`Foreign key violations after migration ${migration.version}`);
      sql.exec('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)', migration.version, new Date().toISOString());
    }
  });
}

// The API's SQL is synchronous. A SQLite-backed Durable Object preserves that
// contract while providing persistent storage and serializing concurrent writes.
export function openCloudflareDatabase(storage: Storage): SeltivoDb {
  const { sql } = storage;
  migrate(storage);
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
      if (name === 'foreign_key_check') return sql.exec('PRAGMA foreign_key_check').toArray();
      if (name !== 'quick_check') throw new Error(`Unsupported pragma: ${name}`);
      return Object.values(sql.exec(`PRAGMA ${name}`).toArray()[0])[0];
    },
  };
  return database as unknown as SeltivoDb;
}
