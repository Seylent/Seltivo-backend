import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyRequest } from 'fastify';
import type { SeltivoDb } from './db.js';

const scrypt = promisify(scryptCallback);
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const now = () => new Date().toISOString();
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, hex] = stored.split(':');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(hex ?? '')) return false;
  const actual = await scrypt(password, salt, 64) as Buffer;
  return timingSafeEqual(actual, Buffer.from(hex, 'hex'));
}

export function createSession(db: SeltivoDb, userId: string) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)')
    .run(hashToken(token), userId, new Date(Date.now() + SESSION_MS).toISOString(), now());
  return token;
}

export function sessionCookie(token: string, secure: boolean) {
  return `seltivo_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean) {
  return `seltivo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export type Actor = { id: string; email: string; role: 'customer' | 'admin'; name: string; email_verified_at: string | null };

export function actorFromRequest(db: SeltivoDb, request: FastifyRequest): Actor | null {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('seltivo_session='));
  const token = cookie?.slice('seltivo_session='.length);
  if (!token || token.length > 100) return null;
  return db.prepare(`SELECT u.id,u.email,u.role,u.name,u.email_verified_at FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled_at IS NULL`)
    .get(hashToken(token), now()) as Actor | undefined ?? null;
}

export function newAuthToken(db: SeltivoDb, userId: string, purpose: 'verify' | 'reset', ttlMs: number) {
  db.prepare('DELETE FROM auth_tokens WHERE user_id=? AND purpose=?').run(userId, purpose);
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO auth_tokens(token_hash,user_id,purpose,expires_at,created_at) VALUES (?,?,?,?,?)')
    .run(hashToken(token), userId, purpose, new Date(Date.now() + ttlMs).toISOString(), now());
  return token;
}

export function audit(db: SeltivoDb, actorId: string, action: string, entityType: string, entityId: string) {
  db.prepare('INSERT INTO audit_log(id,actor_id,action,entity_type,entity_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), actorId, action, entityType, entityId, now());
}
