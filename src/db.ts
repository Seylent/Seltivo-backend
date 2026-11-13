import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

export function openDatabase(filename = process.env.SELTIVO_DB_PATH ?? resolve('data/seltivo.db')) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('customer','admin')),
      name TEXT NOT NULL, phone TEXT, telegram TEXT, email_verified_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, disabled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id, expires_at);
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset')),
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens(user_id, purpose);
    CREATE TABLE IF NOT EXISTS configurations (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
      template_id TEXT NOT NULL, name TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)),
      revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS configurations_owner ON configurations(owner_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES users(id),
      template_id TEXT NOT NULL, template_name TEXT NOT NULL,
      configuration_id TEXT REFERENCES configurations(id),
      config_snapshot_json TEXT CHECK(config_snapshot_json IS NULL OR json_valid(config_snapshot_json)),
      contact_json TEXT NOT NULL CHECK(json_valid(contact_json)),
      note TEXT NOT NULL, features_json TEXT NOT NULL CHECK(json_valid(features_json)),
      client_submission_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('submitted','reviewing','needs_info','in_progress','completed','cancelled')),
      status_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(customer_id, client_submission_id)
    );
    CREATE INDEX IF NOT EXISTS requests_customer ON requests(customer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS requests_status ON requests(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id),
      client_message_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(sender_id, client_message_id)
    );
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, id);
    CREATE TABLE IF NOT EXISTS conversation_reads (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_message_id INTEGER NOT NULL DEFAULT 0, read_at TEXT NOT NULL,
      PRIMARY KEY(conversation_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS request_events (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL REFERENCES users(id), old_status TEXT,
      new_status TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS request_events_request ON request_events(request_id, created_at);
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id),
      action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_recent ON audit_log(created_at DESC);
  `);
  return db;
}

export type SeltivoDb = ReturnType<typeof openDatabase>;
