import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, SCHEMA_SQL } from './schema.js';

type SchemaEntry = { type: string; name: string; sql: string };

function schemaEntries(db: Database.Database): SchemaEntry[] {
  return db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as SchemaEntry[];
}

function normalizedSql(sql: string): string {
  return sql.replace(/\bIF NOT EXISTS\b\s*/gi, '').replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();
}

function checkLegacySchema(db: Database.Database): void {
  const expected = new Database(':memory:');
  try {
    expected.exec(SCHEMA_SQL);
    const actual = new Map(schemaEntries(db).map((entry) => [`${entry.type}:${entry.name}`, normalizedSql(entry.sql)]));
    for (const entry of schemaEntries(expected)) {
      if (actual.get(`${entry.type}:${entry.name}`) !== normalizedSql(entry.sql)) {
        throw new Error(`incompatible legacy schema: ${entry.name}`);
      }
    }
  } finally { expected.close(); }
}

function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const latest = MIGRATIONS.at(-1)?.version ?? 0;
  if (current > latest) throw new Error(`Database version ${current} is newer than this application (${latest})`);
  if (current === latest) return;
  MIGRATIONS.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error('Database migrations must have consecutive versions');
  });

  const hasLegacyTables = current === 0 && schemaEntries(db).some((entry) => entry.type === 'table');
  db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      db.exec(migration.sql);
      if (migration.version === 1 && hasLegacyTables) checkLegacySchema(db);
      if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error(`Foreign key violations after migration ${migration.version}`);
      db.pragma(`user_version = ${migration.version}`);
    }
  })();
}

export function openDatabase(filename = process.env.SELTIVO_DB_PATH ?? resolve('data/seltivo.db')) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    if ((db.pragma('user_version', { simple: true }) as number) > (MIGRATIONS.at(-1)?.version ?? 0)) {
      throw new Error('Database version is newer than this application');
    }
    db.pragma('journal_mode = WAL');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export type SeltivoDb = ReturnType<typeof openDatabase>;
