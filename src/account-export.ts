import type { SeltivoDb } from './db.js';

type Row = Record<string, unknown> & { id: string | number };

/** Streams one row at a time so embedded Studio images cannot fill Worker memory. */
export function accountExport(db: SeltivoDb, userId: string): ReadableStream<Uint8Array> {
  const profile = db.prepare(`SELECT id,email,name,phone,telegram,locale,email_verified_at emailVerifiedAt,
    created_at createdAt,updated_at updatedAt FROM users WHERE id=? AND role='customer'`).get(userId);
  const sections = [
    ['configurations', `SELECT id,template_id templateId,name,data_json data,revision,created_at createdAt,
      updated_at updatedAt,deleted_at deletedAt FROM configurations WHERE owner_id=? AND id>? ORDER BY id LIMIT 1`, ['data'], ''],
    ['requests', `SELECT id,template_id templateId,template_name templateName,status,contact_json contact,note,
      features_json features,config_snapshot_json configuration,created_at createdAt,updated_at updatedAt
      FROM requests WHERE customer_id=? AND id>? ORDER BY id LIMIT 1`, ['contact', 'features', 'configuration'], ''],
    ['messages', `SELECT m.id,c.request_id requestId,u.role senderRole,m.body,m.created_at createdAt
      FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN requests r ON r.id=c.request_id
      JOIN users u ON u.id=m.sender_id WHERE r.customer_id=? AND m.id>? ORDER BY m.id LIMIT 1`, [], 0],
    ['statusHistory', `SELECT e.id,e.request_id requestId,e.old_status oldStatus,e.new_status newStatus,e.reason,e.created_at createdAt
      FROM request_events e JOIN requests r ON r.id=e.request_id WHERE r.customer_id=? AND e.id>? ORDER BY e.id LIMIT 1`, [], ''],
    ['notifications', `SELECT id,request_id requestId,kind,status,created_at createdAt,read_at readAt
      FROM notifications WHERE recipient_id=? AND id>? ORDER BY id LIMIT 1`, [], ''],
  ] as const;
  function* chunks() {
    yield `{"format":"seltivo-account-v1","exportedAt":${JSON.stringify(new Date().toISOString())},"profile":${JSON.stringify(profile)}`;
    for (const [name, sql, jsonFields, initialCursor] of sections) {
      yield `,${JSON.stringify(name)}:[`;
      const query = db.prepare(sql);
      let cursor: string | number = initialCursor;
      let first = true;
      while (true) {
        const row = query.get(userId, cursor) as Row | undefined;
        if (!row) break;
        cursor = row.id;
        for (const field of jsonFields) if (typeof row[field] === 'string') row[field] = JSON.parse(row[field]);
        yield `${first ? '' : ','}${JSON.stringify(row)}`;
        first = false;
      }
      yield ']';
    }
    yield '}';
  }
  const iterator = chunks();
  const encoder = new TextEncoder();
  return new ReadableStream({
    pull(controller) {
      try {
        const next = iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) { controller.error(error); }
    },
    cancel() { iterator.return(); },
  });
}
