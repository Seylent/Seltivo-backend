/**
 * Чисте виведення безпекових налаштувань сервера з origin та оточення.
 * Друк пошти дозволений лише на локальному origin — незалежно від NODE_ENV.
 */
export function deriveServerSecurity(origin: string, env: NodeJS.ProcessEnv): { secureCookies: boolean; devMail: boolean } {
  const localOrigin = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin.replace(/\/+$/, ''));
  return {
    secureCookies: origin.startsWith('https://'),
    devMail: env.SELTIVO_DEV_MAIL === 'console' && localOrigin,
  };
}

/**
 * Як і Worker, Node-сервер не стартує з обов'язковим підтвердженням email без
 * пошти: інакше нові акаунти неможливо підтвердити, а вхід повертає 503.
 */
export function requireMailForVerification(env: NodeJS.ProcessEnv, mailConfigured: boolean): void {
  if (env.SELTIVO_REQUIRE_EMAIL_VERIFICATION === '1' && !mailConfigured) {
    throw new Error('SELTIVO_REQUIRE_EMAIL_VERIFICATION=1 requires SMTP_HOST, SMTP_USER, SMTP_PASSWORD and SMTP_FROM (or SELTIVO_DEV_MAIL=console on a local origin)');
  }
}
