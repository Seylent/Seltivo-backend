export const SCHEMA_SQL = `
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
  `;

// Append each subsequent schema change as a new { version, sql } entry.
// Version 1 is the schema that existed before PRAGMA user_version was introduced.
export const MIGRATIONS = [
  { version: 1, sql: SCHEMA_SQL },
  { version: 2, sql: `
    CREATE TABLE email_notifications (
      id TEXT PRIMARY KEY,
      message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
      recipient TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      sent_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX email_notifications_status ON email_notifications(status, created_at DESC);
  ` },
  { version: 3, sql: `
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('status','message')),
      status TEXT,
      created_at TEXT NOT NULL,
      read_at TEXT
    );
    CREATE INDEX notifications_recipient ON notifications(recipient_id, created_at DESC);
    CREATE INDEX notifications_request ON notifications(request_id, recipient_id, read_at);
  ` },
  { version: 4, sql: `
    CREATE INDEX IF NOT EXISTS users_role_created ON users(role, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS auth_tokens_expires ON auth_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS audit_actor ON audit_log(actor_id);
    CREATE INDEX IF NOT EXISTS audit_entity ON audit_log(entity_type, entity_id);
  ` },
  { version: 5, sql: `
    CREATE TABLE admin_two_factor (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      secret TEXT NOT NULL,
      enabled_at TEXT,
      recovery_codes TEXT NOT NULL
    );
  ` },
  { version: 6, sql: `
    CREATE TABLE guest_requests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contact TEXT NOT NULL,
      features_json TEXT NOT NULL,
      budget TEXT NOT NULL,
      note TEXT NOT NULL,
      template_name TEXT,
      telegram_status TEXT NOT NULL CHECK(telegram_status IN ('sent','failed')),
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','in_progress','done')),
      created_at TEXT NOT NULL,
      processed_at TEXT
    );
    CREATE INDEX guest_requests_created ON guest_requests(created_at DESC, id DESC);
  ` },
  { version: 7, sql: `
    ALTER TABLE guest_requests ADD COLUMN trial_json TEXT;
  ` },
] as const;
