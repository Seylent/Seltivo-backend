# Відповідь бекенду на аудит (commit e54880c)

Перевірку зроблено за вихідним кодом цього репозиторію (`seltivo-backend`) і локальними юніт-тестами з dummy-даними. Live-тести проти прода не виконувалися. Усі 155 тестів проходять (`npm test`), `npm run typecheck` — чистий.

| # | Fingerprint | Результат | Де реалізовано / що зроблено |
| --- | --- | --- | --- |
| 1 | `verify-email.url-token-auto-signin-without-principal-binding` | **Підтверджено й виправлено** | Було: `/auth/verify-email` видавав новий `seltivo_session` для акаунта токена поверх сесії іншого користувача. Стало: `src/app.ts` — у `/auth/verify-email`, `/auth/resend-verification` запит із чинною сесією іншого principals отримує `403` і не змінює стан/кукі; анонімний та власний потік лишається робочим. Регресія: `tests/backend-audit-fixes.test.ts` (`verification of another principal never replaces the current session`). |
| 2 | `src/admin/auth.role-only-admin-gate-2fa-assurance` | **Підтверджено й виправлено** | `/api/v1/auth/2fa/setup\|enable\|disable` вже вимагали admin + пароль/код (перевірено тестом). Було: сесія, здобута до увімкнення 2FA, лишалася адмінською. Стало: `src/app.ts` — `2fa/enable` і `2fa/disable` в транзакції видаляють усі сесії адміна й чистять кукі; `/api/v1/me` повертає `twoFactorVerified: true` і `assurance: "mfa"` для адміна з увімкненою 2FA — ці поля вже споживає Next-гейт (`src/lib/admin-role.ts:7`), окрема зміна фронту не потрібна. Регресія: `tests/backend-audit-fixes.test.ts`, оновлено `tests/two-factor.test.ts`. |
| 3a | `request-guard.createSharedRateLimiter.unbound-per-isolate-fallback` | **Контроль є в бекенді** | Усі API-запити йдуть в єдиний Durable Object `primary` (`cloudflare/worker.ts:457`, `wrangler.jsonc:19-23`), тому per-IP/global ліміти в `src/app.ts:145-235` спільні для всіх ізолятів; email/export-квоти зберігаються в SQLite `rate_limit_hits` і переживають рестарт. Frontend-фолбак не є єдиним захистом. Регресія: `guest requests are limited by the backend independently of any front-end bucket`. |
| 3b | `forms.submission-id.custom-order-key-missing-account-identity` | **Контроль є в бекенді** | ідемпотентність заявок — `UNIQUE(customer_id, client_submission_id)` (`src/schema.ts:36`), lookup за `actor.id` (`src/app.ts:716`); повідомлення — `UNIQUE(sender_id, client_message_id)`. Дубль з іншого principals створює власний запис, а не перевикористовує чужий; при незбігу даних — 409. Регресія: `a clientSubmissionId from another buyer cannot reuse or block a request`. |
| 4 | `src/app/api/v1/route.admin-gate-canonicalization-mismatch` | **Контроль є в бекенді** | `cloudflare/worker-router.ts` резолвить шлях через WHATWG URL (`.` нормалізується), а `;`, `%00`, `//` не матчать жодного маршруту; кожен `/api/v1/admin/*` ендпоінт самостійно викликає `auth(..., 'admin')` (`src/app.ts:947-1148`). Регресія: `obfuscated admin paths are rejected by the backend router even behind the Next proxy`. |
| 5 | Життєвий цикл акаунта | **Контроль є; додано посилення** | `purgeCustomer` (`src/delete-account.ts`) видаляє заявки, конфігурації, сесії, токени й каскадні дитячі записи; `exportAccount` (`src/data-controls.ts:21`) жорстко обмежений `actor.id`; `reset-password` і `change-password` відкликають усі сесії. Нове: per-account ліміт 5/15 хв на `change-password` (`src/app.ts`). 30-денне зберігання/очищення: `src/admin-retention.ts`, `src/backup-retention.ts`, `src/data-retention.ts`. Регресії: `tests/delete-account.test.ts`, `tests/data-controls.test.ts`, `change-password is throttled per account...`. |
| 6 | `studio.useTrialDraft.indexeddb-drafts-keyed-only-by-template-id` | **Бекенд-частина контролюється** | `GET /api/v1/configurations/:id` фільтрує `owner_id=? AND deleted_at IS NULL` (`src/app.ts:682`). Регресія: `a saved configuration cannot be read by another customer`. IndexedDB-чернетки — browser-local продуктова поведінка, не бекенд. |
| 7 | Конфігурація розгортання | **Поза кодом бекенду** | `TURNSTILE_SECRET_KEY` і WAF-правила налаштовуються у front-end/Cloudflare. Бекенд не має `RATE_LIMITER` біндингу навмисно: ліміти реалізовані в самому DO (див. #3a). |

## Що треба зробити frontend-команді

- Гейт уже споживає `twoFactorVerified`/`assurance` (`src/admin/auth.ts:11`, `src/lib/admin-role.ts:7` у репо storefront, коміт `a8aaf74`) — перевірити на staging, що після увімкнення 2FA адмін із новою сесією проходить гейт, а сесія до увімкнення — ні.
- Підтвердити налаштування `TURNSTILE_SECRET_KEY` у проді й staging та наявність WAF rate-limit для `/api/guest-request` і телеметрії; у поточному коді `verifyTurnstile` повертає `true` без секрету.

## Змінені файли

- `src/app.ts` — principal-binding верифікації, відкликання 2FA-сесій, `twoFactorVerified`/`assurance` у `/me`, per-account ліміт change-password.
- `tests/backend-audit-fixes.test.ts` — 8 нових регресійних тестів.
- `tests/two-factor.test.ts` — оновлено під нову поведінку сесій.
- `README.md` — опис нових правил.
