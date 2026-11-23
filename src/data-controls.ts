import type { SeltivoDb } from './db.js';

export const defaultDataLimits = {
  accountBytes: 64 * 1024 * 1024,
  requestsPerAccount: 200,
  messagesPerConversation: 10_000,
  guestRequests: 10_000,
  guestBytes: 256 * 1024 * 1024,
  databaseBytes: 1024 * 1024 * 1024,
};
export type DataLimits = typeof defaultDataLimits;

export function accountPayloadBytes(db: SeltivoDb, userId: string): number {
  return (db.prepare(`SELECT
    COALESCE((SELECT SUM(length(CAST(data_json AS BLOB))) FROM configurations WHERE owner_id=? AND deleted_at IS NULL),0) +
    COALESCE((SELECT SUM(length(CAST(COALESCE(config_snapshot_json,'') || contact_json || note || features_json AS BLOB))) FROM requests WHERE customer_id=?),0) +
    COALESCE((SELECT SUM(length(CAST(m.body AS BLOB))) FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN requests r ON r.id=c.request_id WHERE r.customer_id=?),0) bytes`)
    .get(userId, userId, userId) as { bytes: number }).bytes;
}

export function exportAccount(db: SeltivoDb, userId: string) {
  // Explicit columns deliberately exclude password hashes, sessions, auth tokens,
  // TOTP secrets and recovery codes, including credentials belonging to managers.
  return db.transaction(() => ({
    format: 'seltivo-account-v1', exportedAt: new Date().toISOString(),
    profile: db.prepare('SELECT id,email,name,phone,telegram,locale,email_verified_at emailVerifiedAt,created_at createdAt,updated_at updatedAt FROM users WHERE id=?').get(userId),
    configurations: db.prepare('SELECT id,template_id templateId,name,data_json,revision,created_at createdAt,updated_at updatedAt,deleted_at deletedAt FROM configurations WHERE owner_id=? ORDER BY created_at,id').all(userId)
      .map((row: any) => { const { data_json, ...rest } = row; return { ...rest, data: JSON.parse(data_json) }; }),
    requests: db.prepare('SELECT id,template_id templateId,template_name templateName,config_snapshot_json,contact_json,note,features_json,status,created_at createdAt,updated_at updatedAt FROM requests WHERE customer_id=? ORDER BY created_at,id').all(userId)
      .map((row: any) => { const { config_snapshot_json, contact_json, features_json, ...rest } = row; return { ...rest, configuration: config_snapshot_json ? JSON.parse(config_snapshot_json) : null, contact: JSON.parse(contact_json), features: JSON.parse(features_json) }; }),
    messages: db.prepare(`SELECT m.id,c.request_id requestId,u.role senderRole,m.body,m.created_at createdAt FROM messages m
      JOIN conversations c ON c.id=m.conversation_id JOIN requests r ON r.id=c.request_id JOIN users u ON u.id=m.sender_id
      WHERE r.customer_id=? ORDER BY m.id`).all(userId),
    requestEvents: db.prepare(`SELECT e.request_id requestId,e.old_status oldStatus,e.new_status newStatus,e.reason,e.created_at createdAt
      FROM request_events e JOIN requests r ON r.id=e.request_id WHERE r.customer_id=? ORDER BY e.created_at,e.id`).all(userId),
    notifications: db.prepare('SELECT request_id requestId,kind,status,created_at createdAt,read_at readAt FROM notifications WHERE recipient_id=? ORDER BY created_at,id').all(userId),
    reads: db.prepare('SELECT c.request_id requestId,cr.last_read_message_id lastReadMessageId,cr.read_at readAt FROM conversation_reads cr JOIN conversations c ON c.id=cr.conversation_id WHERE cr.user_id=?').all(userId),
    activity: db.prepare('SELECT action,entity_type entityType,entity_id entityId,created_at createdAt FROM audit_log WHERE actor_id=? ORDER BY created_at,id').all(userId),
  }))();
}
