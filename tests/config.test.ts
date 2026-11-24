import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

type Vars = Record<string, string>;
type WranglerConfig = { vars?: Vars; env?: Record<string, { vars?: Vars }> };

/** Strip // comments without touching // inside quoted strings (e.g. https:// URLs). */
function stripLineComments(source: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      if (i < source.length) out += '\n';
      continue;
    }
    out += char;
  }
  return out;
}

const wranglerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../wrangler.jsonc');
const source = readFileSync(wranglerPath, 'utf8');
const config = JSON.parse(stripLineComments(source)) as WranglerConfig;
const prodVars = config.vars ?? {};
const stagingVars = config.env?.staging?.vars ?? {};

test('wrangler.jsonc pins the hardened production settings at top level', () => {
  assert.equal(prodVars.SELTIVO_PUBLIC_ORIGIN, 'https://seltivostudio.com');
  assert.equal(prodVars.SELTIVO_REQUIRE_EMAIL_VERIFICATION, '1');
  assert.equal(prodVars.SELTIVO_REQUIRE_ADMIN_2FA, '1');
  // Власник підтвердив увімкнення самообслуговування DELETE /me у production 2026-11-24.
  assert.equal(prodVars.SELTIVO_ACCOUNT_DELETION_ENABLED, '1');
});

test('wrangler.jsonc keeps staging-only flags out of production vars', () => {
  assert.equal(prodVars.SELTIVO_STAGING, undefined, 'Staging-only flag SELTIVO_STAGING must not be moved into prod vars');
});

test('wrangler.jsonc production vars carry no secret-named keys', () => {
  for (const key of Object.keys(prodVars)) {
    assert.doesNotMatch(key, /(_KEY|_PASSWORD|_HASH|_TOKEN)$/, `Secret-named key ${key} must not be deployed as a plain var`);
  }
});

test('wrangler.jsonc staging vars keep staging, deletion and relaxed verification flags', () => {
  assert.equal(stagingVars.SELTIVO_STAGING, '1');
  assert.equal(stagingVars.SELTIVO_ACCOUNT_DELETION_ENABLED, '1');
  assert.equal(stagingVars.SELTIVO_REQUIRE_EMAIL_VERIFICATION, '0');
});

test('wrangler.jsonc vars contain no plaintext secret values', () => {
  const secretValuePatterns = [
    /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]+/i,
    /AKIA[0-9A-Z]{16}/,
    /gh[pousr]_[A-Za-z0-9]{20,}/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b[0-9a-f]{32,}\b/i,
  ];
  for (const [envName, vars] of [['prod', prodVars], ['staging', stagingVars]] as const) {
    for (const [key, value] of Object.entries(vars)) {
      for (const pattern of secretValuePatterns) {
        assert.doesNotMatch(value, pattern, `${envName} var ${key} looks like a plaintext secret`);
      }
    }
  }
});
