import nodemailer from 'nodemailer';
import { openDatabase } from './db.js';
import { buildApp } from './app.js';

const origin = process.env.SELTIVO_PUBLIC_ORIGIN;
if (!origin) throw new Error('SELTIVO_PUBLIC_ORIGIN is required');
if (process.env.NODE_ENV === 'production' && !origin.startsWith('https://')) throw new Error('Production origin must use HTTPS');
const db = openDatabase();
const smtp = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD && process.env.SMTP_FROM
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_PORT === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    }) : null;
const app = buildApp({
  db,
  origin,
  secureCookies: process.env.NODE_ENV === 'production',
  teamEmail: process.env.SELTIVO_TEAM_EMAIL,
  sendMail: smtp ? async (to, subject, text) => { await smtp.sendMail({ from: process.env.SMTP_FROM, to, subject, text }); } : undefined,
});
const port = Number(process.env.PORT ?? 4000);
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
process.on('SIGTERM', async () => { await app.close(); db.close(); });
process.on('SIGINT', async () => { await app.close(); db.close(); });
