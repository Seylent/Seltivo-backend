# SELTIVO backend

Окремий HTTP API для акаунтів, конфігурацій, заявок і чату. Каталог макетів лишається у Next-застосунку `SELTIVO` (`registry.ts` + `catalog.json`). Бекенд зберігає лише `templateId` і назву, отриману при створенні заявки; ці дані описові, не визначають ціну.

## Запуск

Для локального Node-сервера потрібен Node.js 24+ і локальний диск для SQLite. Production планується на Cloudflare Worker із SQLite-backed Durable Object. У production увімкнено підтвердження email: для входу потрібен одноразовий код із листа. Для локального запуску без пошти залиште SELTIVO_REQUIRE_EMAIL_VERIFICATION вимкненим.

```powershell
npm install
$env:SELTIVO_PUBLIC_ORIGIN = 'http://localhost:3000'
npm run dev
```

Для локального Node-сервера: `npm ci`, `npm run build`, `npm start`. Команди `admin:bootstrap` і `backup` працюють лише з Node/SQLite. Для Worker: `npm run dev:cloudflare` локально; порядок production-релізу й відкриті умови готовності описані в [Cloudflare operations](docs/cloudflare-operations.md).

Сервер слухає `127.0.0.1:4000`. У production проксі має направляти `/api/v1/*` на бекенд під тим самим origin, що й Next. Бекенд не виставляйте напряму в інтернет. Для довіреного локального проксі можна встановити `SELTIVO_TRUST_PROXY=1`, щоб ліміти враховували IP клієнта із forwarded headers. На проксі також потрібні TLS, обмеження тіла запиту й rate limit.

Node база за замовчуванням: `./data/seltivo.db`; для Node-інсталяції задайте `SELTIVO_DB_PATH` на постійному **локальному** томі. Актуальна схема з `src/schema.ts` застосовується послідовними SQL-міграціями; стара заповнена БД без `user_version` оновлюється зі збереженням даних. `foreign_keys` і WAL увімкнені. Node-копія: `npm run backup -- D:\backups\seltivo-20261114T010000Z.db`; перевірка файлу: `npm run backup:verify -- D:\staging\restored.db`. [Процедура Node-резервування](docs/backup-recovery.md) не застосовується до Worker. Worker веде версії в `schema_migrations`; його відновлення описане окремо в [Cloudflare operations](docs/cloudflare-operations.md).

Для Node-пошти заповніть `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`. Без SMTP можна тестувати локальний режим без підтвердження email; відновлення пароля потребує пошти. `SELTIVO_TEAM_EMAIL` отримує сповіщення про повідомлення клієнтів. Збій пошти не скасовує вже збережене повідомлення; адміністратор бачить недоставлені листи в API та адмінці й може повторити доставку.

Для Cloudflare Worker використовуйте Brevo API замість SMTP. У Brevo підтвердьте домен і адресу відправника, активуйте транзакційні листи, створіть API key. Збережіть ключ як секрет Worker командою `npx wrangler secret put BREVO_API_KEY`, а перевірену адресу відправника — `npx wrangler secret put BREVO_SENDER_EMAIL`. Після розгортання перевірте реальну доставку листа відновлення пароля. Не додавайте ключ у `wrangler.jsonc` чи Git. Поки підтвердження email вимкнене, користувач може зареєструвати адресу, якою не володіє; перед увімкненням пошти перегляньте акаунти, створені в цей період.

Для локальної розробки можна задати `SELTIVO_DEV_MAIL=console`: посилання підтвердження та відновлення друкуються в консоль бекенду. У production цей режим вимкнений незалежно від змінної.

Одноразове створення адміністратора:

```powershell
$env:SELTIVO_ADMIN_EMAIL = 'admin@example.com'
$env:SELTIVO_ADMIN_PASSWORD = 'довгий-унікальний-пароль'
npm run admin:bootstrap
Remove-Item Env:SELTIVO_ADMIN_PASSWORD
```

## API

Базовий шлях `/api/v1`. Для всіх POST/PATCH/DELETE передавайте `Origin`, який точно збігається з `SELTIVO_PUBLIC_ORIGIN`. Сесія — HttpOnly cookie `seltivo_session` з `SameSite=Lax` і `Secure` на HTTPS. `POST /auth/login` приймає необов’язковий boolean `rememberMe`: `true` створює серверну сесію й cookie на 30 днів, `false` або відсутнє поле — серверну сесію на 12 годин і cookie до закриття браузера. Ключ сесії зберігається в БД лише як SHA-256 хеш; повторний вхід замінює поточну сесію, вихід анулює її. Раніше видані сесії лишаються чинними до свого попереднього строку дії. Приватні відповіді не слід кешувати на проксі.

| Операція | Шлях |
| --- | --- |
| Health | `GET /health` |
| Реєстрація, верифікація, вхід, вихід | `POST /auth/register`, `/auth/resend-verification`, `/auth/verify-email`, `/auth/login`, `/auth/logout` |
| Відновлення та зміна пароля | `POST /auth/forgot-password`, `/auth/reset-password`, `/auth/change-password` |
| Профіль | `GET/PATCH/DELETE /me`, `GET /me/export` (потоковий JSON лише власних даних) |
| Збережені конфігурації | `GET/POST /configurations`, `GET/PATCH/DELETE /configurations/:id` |
| Заявки | `GET/POST /requests`, `GET /requests/:id` |
| Чат та сповіщення | `GET/POST /requests/:id/messages`, `PATCH /requests/:id/read`, `GET /notifications/unread-count`, `GET /notifications`, `PATCH /notifications/requests/:id/read`, `DELETE /notifications/:id`, `DELETE /notifications` (очистити все; лише власні сповіщення) |
| Адміністратор | `GET /admin/customers`, `GET /admin/customers/:id` (з заявками, конфігураціями й лічильниками), `GET /admin/requests`, `PATCH /admin/requests/:id/status`, `POST /admin/requests/:id/reopen`, `GET /admin/email-notifications`, `POST /admin/email-notifications/:id/retry`, `GET /admin/overview` (метрики для дашборду), `GET /admin/diagnostics`, `GET /admin/audit` |
| Гостьові заявки | `POST /guest-requests` (публічний, ідемпотентний за `id`), `GET /admin/guest-requests`, `PATCH /admin/guest-requests/:id/status` (`new`/`in_progress`/`done`) |
| 2FA адміна | `GET /auth/2fa/status`, `POST /auth/2fa/setup` (потрібен пароль), `POST /auth/2fa/enable` (код TOTP), `POST /auth/2fa/disable` (пароль + код); у `POST /auth/login` поле `code` обов'язкове, коли 2FA увімкнено (код відновлення теж приймається один раз) |

Адмінська сесія триває щонайбільше 12 год навіть з `rememberMe`. `SELTIVO_REQUIRE_ADMIN_2FA=1` забороняє вхід адміну без увімкненої 2FA — **спочатку** увімкніть 2FA на всіх адмінських акаунтах через `/admin/security`, і лише потім виставляйте прапорець (інакше адмін не зможе увійти, щоб налаштувати її). Секрети TOTP і хеші кодів відновлення зберігаються в таблиці `admin_two_factor` і потрапляють у логічні бекапи.

Створення заявки вимагає `clientSubmissionId` (UUID); повідомлення — `clientMessageId` (UUID). Повторіть той самий ID і ті самі дані після timeout: сервер поверне попередній результат. Для оновлення конфігурації та статусу потрібен `If-Match` із поточною версією. Чужі заявки й конфігурації повертають 404.

Конфігурація зберігається як JSON до 8 МБ; до 30 зображень PNG/JPEG/WebP можуть бути вкладені як data URL. Створена заявка отримує окремий знімок конфігурації, тому подальше редагування або приховування збереженого варіанта не змінює історію заявки. Діалог оновлюється запитами з інтервалом, WebSocket і вкладень у v1 немає. Повідомлення про відповідь адміністратора надсилається email; помилка доставки не видаляє повідомлення з діалогу.

`DELETE /configurations/:id` приховує збережений варіант, але не стирає знімок у вже створених заявках. `DELETE /me` видаляє клієнтський акаунт разом із заявками й чатом після перевірки пароля. У Worker окремий Durable Object зберігає журнал ID видалень і повторно застосовує їх після PITR. Функція вимкнена за замовчуванням до пробного restore на staging; порядок увімкнення — у [Cloudflare operations](docs/cloudflare-operations.md). Строк даних у вже створених копіях — до 30 днів.

Worker підготовлено до щоденної логічної копії в R2 о 02:00 UTC та погодинного очищення копій, старших за 30 днів. Приватний bucket, 30-денне правило зберігання й пробне відновлення на окремому staging Worker перевірені; деталі та команди повторної перевірки — у [Cloudflare operations](docs/cloudflare-operations.md).

## Перевірки

```powershell
npm run typecheck
npm test
```

Next frontend підключено через `/api/v1` rewrite. Каталог `registry.ts + catalog.json` лишився без міграції; вихідний код Fashion 01 не змінювався. Для запуску обох процесів дивіться README у папці SELTIVO.

## Квоти та кероване очищення

Нові дані мають обмеження: 50 активних конфігурацій і 64 MiB вмісту на акаунт (разом зі знімками заявок та повідомленнями), 200 заявок на акаунт, 2000 повідомлень на діалог, 50 000 гостьових заявок, 512 MiB загальної бази. Межі визначає `DEFAULT_DATA_LIMITS`; `buildApp.dataLimits` дозволяє задати інші перевірені значення. На глобальній межі API відхиляє зростання з 503, на межі акаунта — з 422. Читання, видалення конфігурацій, зменшення їхнього обсягу й повтор уже прийнятого запиту доступні. Існуючі дані автоматично не видаляються.

`POST /api/v1/admin/retention` приймає `{ "before": "2026-08-01T00:00:00.000Z" }` і за замовчуванням повертає лише лічильники. Адміністратор має погодити строк зберігання перед застосуванням. Лише додавання `"apply": true` очищує до 1000 записів кожного типу за виклик, з записом в аудиті. Для завершених гостьових заявок дата перевіряється за `processed_at`; відкриті й нещодавно оброблені заявки не зачіпаються. Також очищуються прострочені сесії/токени, прочитані сповіщення й успішно доставлені листи. Дата має бути щонайменше 30 днів тому. Цей endpoint не стирає акаунти, конфігурації, замовлення чи листування. Відновлена стара копія потребує повторного застосування погодженого очищення; бекапи мають власний строк 30 днів.

Експорт `/me/export` дозволений лише клієнту, не більше трьох завантажень за годину на акаунт; він не містить паролів, токенів або даних інших клієнтів. Видалення акаунта залишається за прапорцем до перевірки відновлення з зовнішнім журналом видалень.
