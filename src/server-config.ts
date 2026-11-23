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
