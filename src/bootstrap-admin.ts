import { randomUUID } from 'node:crypto';
import { hashPassword, normalizeEmail, now } from './auth.js';
import { openDatabase } from './db.js';

const email = process.env.SELTIVO_ADMIN_EMAIL;
const password = process.env.SELTIVO_ADMIN_PASSWORD;
if (!email || !password || password.length < 12) throw new Error('Set SELTIVO_ADMIN_EMAIL and SELTIVO_ADMIN_PASSWORD (12+ characters)');
const db = openDatabase();
const normalized = normalizeEmail(email);
if (db.prepare('SELECT id FROM users WHERE email=?').get(normalized)) throw new Error('Account already exists');
const id = randomUUID(), timestamp = now();
db.prepare("INSERT INTO users(id,email,password_hash,role,name,email_verified_at,created_at,updated_at) VALUES (?,?,?,'admin','Admin',?,?,?)")
  .run(id, normalized, await hashPassword(password), timestamp, timestamp, timestamp);
db.close();
console.log(`Admin created: ${normalized}`);
