import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyRequest } from 'fastify';
import type { SeltivoDb } from './db.js';

const scrypt = promisify(scryptCallback);
const SHORT_SESSION_MS = 12 * 60 * 60 * 1000;
const REMEMBER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS_PER_USER = 10;
const DUMMY_PASSWORD_HASH = `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;
export const now = () => new Date().toISOString();
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function isValidPasswordHash(stored: string) {
  const [algorithm, salt, hex, ...rest] = stored.split(':');
  return rest.length === 0 && algorithm === 'scrypt' && /^[a-f0-9]{32}$/.test(salt ?? '') && /^[a-f0-9]{128}$/.test(hex ?? '');
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored?: string | null) {
  const target = stored && isValidPasswordHash(stored) ? stored : DUMMY_PASSWORD_HASH;
  const [, salt, hex] = target.split(':');
  const actual = await scrypt(password, salt, 64) as Buffer;
  const matched = timingSafeEqual(actual, Buffer.from(hex, 'hex'));
  return Boolean(stored && isValidPasswordHash(stored)) && matched;
}

export function createSession(db: SeltivoDb, userId: string, rememberMe = false) {
  const timestamp = now();
  db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(timestamp);
  db.prepare(`DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (
    SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC, token_hash DESC LIMIT ?
  )`).run(userId, userId, MAX_SESSIONS_PER_USER - 1);
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(hashToken(token), userId, new Date(Date.now() + (rememberMe ? REMEMBER_SESSION_MS : SHORT_SESSION_MS)).toISOString(), timestamp);
  return token;
}

export function sessionCookie(token: string, secure: boolean, rememberMe = false) {
  return `seltivo_session=${token}; Path=/; HttpOnly; SameSite=Lax${rememberMe ? `; Max-Age=${REMEMBER_SESSION_MS / 1000}` : ''}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean) {
  return `seltivo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export type Actor = { id: string; email: string; role: 'customer' | 'admin'; name: string; email_verified_at: string | null };

export function sessionTokenFromRequest(request: FastifyRequest): string | null {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('seltivo_session='));
  const token = cookie?.slice('seltivo_session='.length);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export function actorFromRequest(db: SeltivoDb, request: FastifyRequest): Actor | null {
  const token = sessionTokenFromRequest(request);
  if (!token) return null;
  return db.prepare(`SELECT u.id,u.email,u.role,u.name,u.email_verified_at FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled_at IS NULL`)
    .get(hashToken(token), now()) as Actor | undefined ?? null;
}

export function newAuthToken(db: SeltivoDb, userId: string, purpose: 'verify' | 'reset', ttlMs: number) {
  const timestamp = now();
  db.prepare('DELETE FROM auth_tokens WHERE (user_id=? AND purpose=?) OR expires_at<=?').run(userId, purpose, timestamp);
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO auth_tokens(token_hash,user_id,purpose,expires_at,created_at) VALUES (?,?,?,?,?)')
    .run(hashToken(token), userId, purpose, new Date(Date.now() + ttlMs).toISOString(), timestamp);
  return token;
}

export function audit(db: SeltivoDb, actorId: string, action: string, entityType: string, entityId: string) {
  db.prepare('INSERT INTO audit_log(id,actor_id,action,entity_type,entity_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), actorId, action, entityType, entityId, now());
}
