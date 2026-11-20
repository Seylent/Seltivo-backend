import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

function encodeBase32(bytes: Buffer): string {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let result = '';
  for (let index = 0; index < bits.length; index += 5) {
    result += BASE32[parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
  }
  return result;
}

function decodeBase32(value: string): Buffer {
  let bits = '';
  for (const character of value.toUpperCase().replace(/=+$/, '')) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error('Invalid base32 secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(secret: string, counter: number): string {
  // RFC 4226: 8-byte big-endian counter, HMAC-SHA1, dynamic truncation.
  const buffer = Buffer.alloc(8);
  let remaining = counter;
  for (let index = 7; index >= 0; index -= 1) {
    buffer[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  const digest = createHmac('sha1', decodeBase32(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(value % 1_000_000).padStart(6, '0');
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function totpAt(secret: string, atMs = Date.now()): string {
  return hotp(secret, Math.floor(atMs / STEP_MS));
}

/** RFC 6238: приймаємо поточний крок і сусідні (±30 с) для зсуву годинника. */
export function verifyTotp(code: string, secret: string, atMs = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const step = Math.floor(atMs / STEP_MS);
  const expected = Buffer.from(code);
  for (const delta of [0, -1, 1]) {
    if (timingSafeEqual(expected, Buffer.from(hotp(secret, step + delta)))) return true;
  }
  return false;
}

export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const hex = randomBytes(6).toString('hex').toUpperCase();
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
  });
}

export const normalizeRecoveryCode = (code: string) => code.replace(/[-\s]/g, '').toUpperCase();

export function otpauthUri(secret: string, email: string, issuer = 'SELTIVO'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
