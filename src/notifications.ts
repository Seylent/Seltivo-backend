import type { SeltivoDb } from './db.js';
import { now } from './auth.js';
import { renderEmail } from './emails.js';

export type Mail = (to: string, subject: string, text: string, html?: string) => Promise<void>;
export type DeliveryOutcome = 'sent' | 'failed' | 'busy' | 'missing';
type Options = { db: SeltivoDb; origin: string; sendMail?: Mail; log: (entry: Record<string, unknown>) => void };

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_SENDING_MS = 2 * 60_000;
/** Автоповтор: не частіше ніж раз на 10 хв, не більше 6 спроб, лише для листів молодших за 3 дні. */
const RETRY_DELAY_MS = 10 * 60_000;
const MAX_ATTEMPTS = 6;
const RETRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const RETRY_BATCH = 25;

export function createNotificationDelivery({ db, origin, sendMail, log }: Options) {
  const deliver = async (notificationId: string): Promise<DeliveryOutcome> => {
    const started = now();
    const stale = new Date(Date.now() - STALE_SENDING_MS).toISOString();
    const claimed = db.prepare(`UPDATE email_notifications SET status='sending',attempts=attempts+1,last_attempt_at=?,last_error_code=NULL
      WHERE id=? AND (status IN ('pending','failed') OR (status='sending' AND last_attempt_at<?))`).run(started, notificationId, stale);
    if (!claimed.changes) {
      const row = db.prepare('SELECT status FROM email_notifications WHERE id=?').get(notificationId) as { status: string } | undefined;
      return row ? 'busy' : 'missing';
    }
    const row = db.prepare(`SELECT n.recipient,r.id request_id,u.role sender_role,
      (SELECT locale FROM users WHERE email=n.recipient) AS recipient_locale FROM email_notifications n
      JOIN messages m ON m.id=n.message_id JOIN users u ON u.id=m.sender_id
      JOIN conversations c ON c.id=m.conversation_id JOIN requests r ON r.id=c.request_id WHERE n.id=?`)
      .get(notificationId) as { recipient: string; request_id: string; sender_role: string; recipient_locale: string | null } | undefined;
    if (!row) return 'missing';
    const customer = row.sender_role === 'admin';
    const message = renderEmail('chat-message', {
      origin,
      requestId: row.request_id,
      customerReply: customer,
      url: `${origin}/${customer ? 'account' : 'admin'}/requests/${row.request_id}`,
    }, row.recipient_locale);
    try {
      if (!sendMail) throw new Error('mail_not_configured');
      await sendMail(row.recipient, message.subject, message.text, message.html);
      const retentionCutoff = new Date(Date.now() - RETENTION_MS).toISOString();
      db.prepare("UPDATE email_notifications SET status='sent',sent_at=?,last_error_code=NULL WHERE id=?").run(now(), notificationId);
      db.prepare("DELETE FROM email_notifications WHERE status='sent' AND sent_at<?").run(retentionCutoff);
      return 'sent';
    } catch {
      const code = sendMail ? 'provider_error' : 'mail_not_configured';
      db.prepare("UPDATE email_notifications SET status='failed',last_error_code=? WHERE id=?").run(code, notificationId);
      log({ event: 'email_delivery_failed', kind: 'chat', notificationId, code });
      return 'failed';
    }
  };

  /** Повторює недоставлені листи чату з обмеженою частотою. Вичерпані лишаються для ручного повтору в адмінці. */
  const retryDue = async (atMs = Date.now()): Promise<{ attempted: number; sent: number; failed: number }> => {
    const result = { attempted: 0, sent: 0, failed: 0 };
    if (!sendMail) return result;
    const due = db.prepare(`SELECT id FROM email_notifications
      WHERE (status IN ('pending','failed') OR status='sending') AND attempts<? AND created_at>?
        AND (last_attempt_at IS NULL OR last_attempt_at<?)
      ORDER BY created_at LIMIT ?`)
      .all(MAX_ATTEMPTS, new Date(atMs - RETRY_WINDOW_MS).toISOString(), new Date(atMs - RETRY_DELAY_MS).toISOString(), RETRY_BATCH) as { id: string }[];
    for (const { id } of due) {
      const outcome = await deliver(id);
      if (outcome === 'sent') { result.attempted++; result.sent++; }
      else if (outcome === 'failed') { result.attempted++; result.failed++; }
    }
    return result;
  };

  return { deliver, retryDue };
}
