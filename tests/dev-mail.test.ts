import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactDevMail } from '../src/dev-mail.js';
import { renderEmail } from '../src/emails.js';
import { deriveServerSecurity } from '../src/server-config.js';

test('redactDevMail masks the Ukrainian verification code in dev-console output', () => {
  const line = 'DEV MAIL to client@example.com: Код підтвердження SELTIVO\nВаш код підтвердження SELTIVO: 482731';
  const redacted = redactDevMail(line);
  assert.doesNotMatch(redacted, /\b482731\b/);
  assert.match(redacted, /SELTIVO: \*\*\*\*\*\*/);
  assert.match(redacted, /client@example\.com/);
});

test('redactDevMail masks the English verification code that used to leak', () => {
  const redacted = redactDevMail('Your SELTIVO verification code: 123456');
  assert.doesNotMatch(redacted, /\b123456\b/);
  assert.match(redacted, /verification code: \*\*\*\*\*\*/);
});

test('redactDevMail strips token and code URL parameters but keeps harmless ones', () => {
  const line = 'Link: https://seltivostudio.com/reset-password?token=a1b2c3d4e5f6&code=654321&next=%2Faccount';
  const redacted = redactDevMail(line);
  assert.doesNotMatch(redacted, /a1b2c3d4e5f6/);
  assert.doesNotMatch(redacted, /code=654321/);
  assert.match(redacted, /token=\*\*\*/);
  assert.match(redacted, /next=%2Faccount/);
});

test('redactDevMail masks only standalone 6-digit sequences', () => {
  const redacted = redactDevMail('order 1234567 and 123456 and 12 34 56');
  assert.match(redacted, /order 1234567 and \*\*\*\*\*\* and 12 34 56/);
});

test('rendered email never emits a javascript: href from a hostile url', () => {
  const mail = renderEmail('reset-password', {
    origin: 'https://seltivostudio.com',
    url: 'javascript:alert(document.cookie)',
  }, 'en');
  assert.doesNotMatch(mail.html, /javascript:/i);
  assert.match(mail.html, /href="https:\/\/seltivostudio\.com/);
});

test('rendered email never emits a data: scheme from a hostile origin or url', () => {
  const mail = renderEmail('chat-message', {
    origin: 'data:text/html,<script>alert(1)</script>',
    url: 'data:text/html;base64,PHNjcmlwdD4=',
  }, 'uk');
  assert.doesNotMatch(mail.html, /data:/i);
  assert.match(mail.html, /seltivostudio\.com/);
});

test('rendered email keeps legitimate http(s) links intact', () => {
  const url = 'https://seltivostudio.com/reset-password?token=abc&next=%2Fme';
  const mail = renderEmail('reset-password', { origin: 'https://seltivostudio.com', url }, 'en');
  assert.match(mail.html, /href="https:\/\/seltivostudio\.com\/reset-password\?token=abc&amp;next=%2Fme"/);
});

test('redactDevMail strips HTML-escaped amp; token and code parameters', () => {
  const line = 'Link: https://seltivostudio.com/reset-password?token=a1b2c3&amp;code=654321';
  const redacted = redactDevMail(line);
  assert.doesNotMatch(redacted, /a1b2c3/);
  assert.doesNotMatch(redacted, /654321/);
  assert.match(redacted, /token=\*\*\*/);
  assert.match(redacted, /amp;code=\*\*\*/);
});

test('deriveServerSecurity enables secure cookies for an https origin', () => {
  const result = deriveServerSecurity('https://seltivostudio.com', { SELTIVO_DEV_MAIL: 'console' });
  assert.equal(result.secureCookies, true);
});

test('deriveServerSecurity disables secure cookies for a local http origin', () => {
  const result = deriveServerSecurity('http://localhost:3000', { SELTIVO_DEV_MAIL: 'console' });
  assert.equal(result.secureCookies, false);
});

test('deriveServerSecurity refuses dev mail on a non-local origin even in development', () => {
  const result = deriveServerSecurity('https://seltivostudio.com', {
    NODE_ENV: 'development',
    SELTIVO_DEV_MAIL: 'console',
  });
  assert.equal(result.devMail, false);
});

test('deriveServerSecurity enables dev mail on a local origin only with the console flag', () => {
  const result = deriveServerSecurity('http://localhost:3000', { SELTIVO_DEV_MAIL: 'console' });
  assert.equal(result.devMail, true);
});
