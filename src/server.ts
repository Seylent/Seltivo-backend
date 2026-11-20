import nodemailer from 'nodemailer';
import { openDatabase } from './db.js';
import { buildApp } from './app.js';
import { purgeCustomer } from './delete-account.js';
import { recordLocalDeletion, replayLocalDeletions } from './local-deletion-ledger.js';

const origin = process.env.SELTIVO_PUBLIC_ORIGIN;
if (!origin) throw new Error('SELTIVO_PUBLIC_ORIGIN is required');
if (process.env.NODE_ENV === 'production' && !origin.startsWith('https://')) throw new Error('Production origin must use HTTPS');
const db = openDatabase();
const smtp = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD && process.env.SMTP_FROM
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_PORT === '465',
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    }) : null;
const devMail = process.env.NODE_ENV !== 'production' && process.env.SELTIVO_DEV_MAIL === 'console';
const deletionEnabled = process.env.SELTIVO_ACCOUNT_DELETION_ENABLED === '1';
if (deletionEnabled) {
  // Після restore старої БД видалені акаунти мають зникнути знову.
  const replayed = replayLocalDeletions(db);
  if (replayed) console.log(`Replayed ${replayed} local account deletion(s).`);
}
const app = buildApp({
  db,
  origin,
  secureCookies: process.env.NODE_ENV === 'production',
  requireAdmin2FA: process.env.SELTIVO_REQUIRE_ADMIN_2FA === '1',
  teamEmail: process.env.SELTIVO_TEAM_EMAIL,
  databaseBytes: () => (db.pragma('page_count', { simple: true }) as number) * (db.pragma('page_size', { simple: true }) as number),
  // Як і Worker, локальний сервер не видаляє акаунти без явного прапорця.
  deleteCustomer: deletionEnabled
    ? async (userId) => {
        // Спочатку журнал: якщо purge впаде, наступний старт доробить видалення.
        recordLocalDeletion(userId);
        purgeCustomer(db, userId);
      }
    : undefined,
  sendMail: smtp ? async (to, subject, text) => { await smtp.sendMail({ from: process.env.SMTP_FROM, to, subject, text }); }
    : devMail ? async (to, subject, text) => {
      // Dev-консоль часто потрапляє в логи — токени з посилань друкувати не можна.
      const redact = (value: string) => value.replace(/([?&](?:token|code)=)[^\s&]+/gi, '$1***');
      console.log(`DEV MAIL to ${to}: ${redact(subject)}\n${redact(text)}`);
    } : undefined,
});
const port = Number(process.env.PORT ?? 4000);
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
process.on('SIGTERM', async () => { await app.close(); db.close(); });
process.on('SIGINT', async () => { await app.close(); db.close(); });
