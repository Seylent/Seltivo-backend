import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderEmail } from '../src/emails.js';

test('verification email has the branded code card and a plain-text fallback', () => {
  const mail = renderEmail('verification', { code: '482731' }, 'uk');
  assert.equal(mail.subject, 'Код підтвердження SELTIVO');
  assert.match(mail.text, /SELTIVO: 482731/);
  assert.match(mail.text, /\b482731\b/);
  assert.match(mail.html, /Підтвердіть пошту/);
  assert.match(mail.html, /Введіть цей код/);
  assert.match(mail.html, /482&nbsp;731/);
  assert.match(mail.html, /logo-text-only\.webp/);
  assert.match(mail.html, /selti\.webp/);
  assert.match(mail.html, /role="presentation"/);
  assert.match(mail.html, /text\/html|doctype html/i);
  assert.doesNotMatch(mail.html, /<script/i);
});

test('verification email follows the visitor locale', () => {
  const uk = renderEmail('verification', { code: '123456' }, 'uk');
  const en = renderEmail('verification', { code: '123456' }, 'en');
  assert.match(uk.html, /Підтвердіть пошту/);
  assert.match(en.html, /Verify your email/);
  assert.match(en.text, /Your SELTIVO verification code: 123456/);
});

test('template values are escaped and cannot inject markup', () => {
  const mail = renderEmail('chat-message', {
    requestId: '"><script>alert(1)</script>',
    url: 'https://seltivostudio.com/account/requests/abc',
  }, 'uk');
  assert.doesNotMatch(mail.html, /<script>alert/);
  assert.match(mail.html, /&lt;script&gt;/i);
  assert.match(mail.html, /&quot;/i);
});

test('chat email shows a short request number and keeps the full id in the link', () => {
  const requestId = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
  const mail = renderEmail('chat-message', {
    requestId,
    url: `https://seltivostudio.com/account/requests/${requestId}`,
  }, 'uk');
  assert.match(mail.html, /Заявка № A1B2C3D4/);
  assert.doesNotMatch(mail.html, /Заявка № a1b2c3d4/);
  assert.match(mail.html, /account\/requests\/a1b2c3d4-e5f6-4789-abcd-0123456789ab/);
  assert.match(mail.text, /A1B2C3D4/);
});

test('rounded cards use separated borders so border-radius works in email clients', () => {
  const mail = renderEmail('verification', { code: '482731' }, 'uk');
  const separate = mail.html.match(/border-collapse:separate;border-spacing:0/g) ?? [];
  assert.ok(separate.length >= 3, `expected separated borders on card, code box and button, got ${separate.length}`);
});

test('every transactional kind produces subject, text and html', () => {
  const kinds = ['verification', 'reset-password', 'chat-message'] as const;
  for (const kind of kinds) {
    for (const locale of ['uk', 'en'] as const) {
      const mail = renderEmail(kind, { origin: 'https://seltivostudio.com', code: '123456', url: 'https://seltivostudio.com/reset-password?token=abc' }, locale);
      assert.ok(mail.subject.length > 0, kind);
      assert.ok(mail.text.length > 0, kind);
      assert.match(mail.html, /<!doctype html>/, kind);
      assert.match(mail.html, /@media only screen/, kind);
    }
  }
});
