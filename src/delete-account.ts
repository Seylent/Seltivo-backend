import type { SeltivoDb } from './db.js';

// Safe to replay after a restore: a missing customer is already deleted.
export function purgeCustomer(db: SeltivoDb, userId: string): void {
  db.transaction(() => {
    const user = db.prepare("SELECT id FROM users WHERE id=? AND role='customer'").get(userId);
    if (!user) return;
    const requests = db.prepare('SELECT id FROM requests WHERE customer_id=?').all(userId) as { id: string }[];
    for (const request of requests) {
      db.prepare("DELETE FROM audit_log WHERE entity_type='request' AND entity_id=?").run(request.id);
    }
    db.prepare('DELETE FROM audit_log WHERE actor_id=? OR entity_id=?').run(userId, userId);
    db.prepare('DELETE FROM requests WHERE customer_id=?').run(userId);
    db.prepare('DELETE FROM configurations WHERE owner_id=?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM auth_tokens WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM users WHERE id=?').run(userId);
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Foreign key violation after customer purge');
  })();
}

// Повторне видалення заявки після restore/PITR. Діалог, повідомлення, історія
// статусів і сповіщення видаляються каскадом; безпечно викликати повторно.
export function purgeRequest(db: SeltivoDb, requestId: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM requests WHERE id=?').run(requestId);
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Foreign key violation after request purge');
  })();
}
