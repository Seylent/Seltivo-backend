import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db.js';
import { SCHEMA_SQL } from '../src/schema.js';

function removeTestDirectory(directory: string) {
  const target = resolve(directory);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('seltivo-migration-')) throw new Error(`Unsafe test cleanup path: ${target}`);
  rmSync(target, { recursive: true, force: true });
}

test('an existing unversioned database is upgraded without losing records and reopening is a no-op', () => {
  const directory = mkdtempSync(join(tmpdir(), 'seltivo-migration-'));
  const filename = join(directory, 'legacy.db');
  try {
    const legacy = new Database(filename);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(SCHEMA_SQL);
    legacy.prepare("INSERT INTO users(id,email,password_hash,role,name,created_at,updated_at) VALUES ('u1','user@example.test','hash','customer','User','2026-01-01','2026-01-01')").run();
    legacy.prepare("INSERT INTO configurations(id,owner_id,template_id,name,data_json,created_at,updated_at) VALUES ('c1','u1','fashion-01','Saved','{}','2026-01-01','2026-01-01')").run();
    legacy.prepare("INSERT INTO requests(id,customer_id,template_id,template_name,configuration_id,config_snapshot_json,contact_json,note,features_json,client_submission_id,status,created_at,updated_at) VALUES ('r1','u1','fashion-01','Fashion 01','c1','{}','{}','','[]','submission-1','submitted','2026-01-01','2026-01-01')").run();
    legacy.prepare("INSERT INTO conversations(id,request_id,created_at) VALUES ('v1','r1','2026-01-01')").run();
    legacy.prepare("INSERT INTO messages(conversation_id,sender_id,client_message_id,body,created_at) VALUES ('v1','u1','message-1','Hello','2026-01-01')").run();
    assert.equal(legacy.pragma('user_version', { simple: true }), 0);
    legacy.close();

    const upgraded = openDatabase(filename);
    let rows: unknown[][];
    let schemaVersion: unknown;
    try {
      assert.equal(upgraded.pragma('user_version', { simple: true }), 1);
      assert.equal((upgraded.pragma('foreign_key_check') as unknown[]).length, 0);
      assert.equal(upgraded.pragma('integrity_check', { simple: true }), 'ok');
      rows = ['users', 'configurations', 'requests', 'conversations', 'messages'].map(
        (table) => upgraded.prepare(`SELECT * FROM ${table}`).all(),
      );
      schemaVersion = upgraded.pragma('schema_version', { simple: true });
    } finally { upgraded.close(); }

    const reopened = openDatabase(filename);
    assert.equal(reopened.pragma('user_version', { simple: true }), 1);
    assert.equal(reopened.pragma('schema_version', { simple: true }), schemaVersion);
    assert.deepEqual(['users', 'configurations', 'requests', 'conversations', 'messages'].map(
      (table) => reopened.prepare(`SELECT * FROM ${table}`).all(),
    ), rows);
    reopened.close();
  } finally {
    removeTestDirectory(directory);
  }
});

test('unknown future and incompatible legacy schemas are rejected without changing the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'seltivo-migration-'));
  try {
    const futurePath = join(directory, 'future.db');
    const future = new Database(futurePath);
    future.pragma('user_version = 999');
    future.close();
    let futureError: unknown;
    try { openDatabase(futurePath).close(); } catch (error) { futureError = error; }
    assert.match(String(futureError), /newer than this application/);
    const futureAgain = new Database(futurePath);
    assert.equal(futureAgain.pragma('user_version', { simple: true }), 999);
    futureAgain.close();

    const incompatiblePath = join(directory, 'incompatible.db');
    const incompatible = new Database(incompatiblePath);
    incompatible.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    incompatible.close();
    let incompatibleError: unknown;
    try { openDatabase(incompatiblePath).close(); } catch (error) { incompatibleError = error; }
    assert.match(String(incompatibleError), /incompatible legacy schema/);
    const unchanged = new Database(incompatiblePath);
    assert.equal(unchanged.pragma('user_version', { simple: true }), 0);
    assert.deepEqual(unchanged.prepare('PRAGMA table_info(users)').all().map((column: any) => column.name), ['id']);
    assert.equal((unchanged.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='requests'").get() as { count: number }).count, 0);
    unchanged.close();
  } finally {
    removeTestDirectory(directory);
  }
});
