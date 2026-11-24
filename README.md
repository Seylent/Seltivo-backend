# SELTIVO backend

Окремий HTTP API для акаунтів, конфігурацій, заявок і чату. Каталог макетів лишається у Next-застосунку `SELTIVO` (`registry.ts` + `catalog.json`). Бекенд зберігає лише `templateId` і назву, отриману при створенні заявки; ці дані описові, не визначають ціну.

## Запуск

Для локального Node-сервера потрібен Node.js 24+ і локальний диск для SQLite. Production планується на Cloudflare Worker із SQLite-backed Durable Object. У production `SELTIVO_REQUIRE_EMAIL_VERIFICATION=1`, тож `POST /auth/register` **одразу створює акаунт** із `email_verified_at=null` і повертає `201 { id, verificationRequired: true }`; до підтвердження кодом такий клієнт заблокований (захищені операції повертають `403`). На staging перевірка вимкнена для зручності тестування. Пошта потрібна і для відновлення пароля.

```powershell
npm install
$env:SELTIVO_PUBLIC_ORIGIN = 'http://localhost:3000'
npm run dev
```

Для локального Node-сервера: `npm ci`, `npm run build`, `npm start`. Команди `admin:bootstrap` і `backup` працюють лише з Node/SQLite. Для Worker: `npm run dev:cloudflare` локально; порядок production-релізу й відкриті умови готовності описані в [Cloudflare operations](docs/cloudflare-operations.md).

Сервер слухає `127.0.0.1:4000`. У production проксі має направляти `/api/v1/*` на бекенд під тим самим origin, що й Next. Бекенд не виставляйте напряму в інтернет. Для довіреного локального проксі можна встановити `SELTIVO_TRUST_PROXY=1`, щоб ліміти враховували IP клієнта із forwarded headers. Бекенд довіряє рівно **одному** проксі: береться адреса, яку дописав найближчий проксі в `X-Forwarded-For`, а значення, підставлені самим клієнтом лівіше, ігноруються. На проксі також потрібні TLS, обмеження тіла запиту й rate limit. У production спільний origin належить Next-застосунку, тому **він** задає заголовки безпеки для всього origin, включно з `/api/v1/*`: його глобальне правило перекриває `X-Frame-Options: DENY` і `Referrer-Policy: no-referrer`, які ставить бекенд, значеннями `SAMEORIGIN` / `strict-origin-when-cross-origin`. Це не вразливість: API повертає JSON (`X-Frame-Options` до нього не застосовується), а `Referrer-Policy` береться з початкового документа, не з fetch-відповіді; захист сторінок від клікджекінгу забезпечує frontend через `Content-Security-Policy: frame-ancestors 'none'` на auth/admin-маршрутах. Бекенду не варто покладатися на власні значення цих двох заголовків за Next-проксі; `Cache-Control: private, no-store` і `X-Content-Type-Options: nosniff` до клієнта доходять коректно.

Node база за замовчуванням: `./data/seltivo.db`; для Node-інсталяції задайте `SELTIVO_DB_PATH` на постійному **локальному** томі. Схема застосовується послідовними SQL-міграціями (актуальну версію — зараз v11 — завжди можна прочитати з останньої міграції в репозиторії, а не з цього README); стара заповнена БД без `user_version` оновлюється зі збереженням даних. `foreign_keys` і WAL увімкнені. Node-копія: `npm run backup -- D:\backups\seltivo-20261114T010000Z.db`; перевірка файлу: `npm run backup:verify -- D:\staging\restored.db`. [Процедура Node-резервування](docs/backup-recovery.md) не застосовується до Worker. Worker веде версії в `schema_migrations`; його відновлення описане окремо в [Cloudflare operations](docs/cloudflare-operations.md).

Для Node-пошти заповніть `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`. Реєстрація зараз працює без SMTP, але відновлення пароля без пошти неможливе. `SELTIVO_TEAM_EMAIL` отримує сповіщення про повідомлення клієнтів. Збій пошти не скасовує вже збережене повідомлення; адміністратор бачить недоставлені листи в API та адмінці й може повторити доставку.

Для Cloudflare Worker використовуйте Brevo API замість SMTP. У Brevo підтвердьте домен і адресу відправника, активуйте транзакційні листи, створіть API key. Збережіть ключ як секрет Worker командою `npx wrangler secret put BREVO_API_KEY`, а перевірену адресу відправника — `npx wrangler secret put BREVO_SENDER_EMAIL`. Після розгортання перевірте реальну доставку листа відновлення пароля. Не додавайте ключ у `wrangler.jsonc` чи Git. На staging, де перевірка email вимкнена, користувач може зареєструвати адресу, якою не володіє; перед увімкненням перевірки в production перегляньте акаунти, створені в цей період.

Для локальної розробки можна задати `SELTIVO_DEV_MAIL=console`: посилання підтвердження та відновлення друкуються в консоль бекенду. Режим працює лише для локального origin (`http://localhost` або `http://127.0.0.1`) незалежно від `NODE_ENV`; на будь-якому іншому origin він вимкнений. Шестизначні коди й параметри `token`/`code` у консольному виводі маскуються.

Одноразове створення адміністратора:

```powershell
$env:SELTIVO_ADMIN_EMAIL = 'admin@example.com'
$env:SELTIVO_ADMIN_PASSWORD = 'довгий-унікальний-пароль'
npm run admin:bootstrap
Remove-Item Env:SELTIVO_ADMIN_PASSWORD
```

## API

Базовий шлях `/api/v1`. Для всіх POST/PATCH/DELETE передавайте `Origin`, який точно збігається з `SELTIVO_PUBLIC_ORIGIN`. Блокування входу за email, ліміти листів підтвердження/відновлення та квота експорту зберігаються в таблиці `rate_limit_hits` (лише SHA-256 ключа, без email; у бекапи не потрапляє), тож переживають рестарт Durable Object. Ліміти за IP лишаються в пам'яті. Сесія — HttpOnly cookie `seltivo_session` з `SameSite=Lax` і `Secure` на HTTPS. `POST /auth/login` приймає необов’язковий boolean `rememberMe`: `true` створює серверну сесію й cookie на 30 днів, `false` або відсутнє поле — серверну сесію на 12 годин і cookie до закриття браузера. Ключ сесії зберігається в БД лише як SHA-256 хеш; повторний вхід замінює поточну сесію, вихід анулює її. Раніше видані сесії лишаються чинними до свого попереднього строку дії. Приватні відповіді не слід кешувати на проксі.

| Операція | Шлях |
| --- | --- |
| Health | `GET /health` |
| Реєстрація, верифікація, вхід, вихід | `POST /auth/register`, `/auth/resend-verification`, `/auth/verify-email`, `/auth/login`, `/auth/logout` |
| Відновлення та зміна пароля | `POST /auth/forgot-password`, `/auth/reset-password`, `/auth/change-password` |
| Профіль | `GET/PATCH/DELETE /me`, `GET /me/export` (експорт даних акаунта) |
| Збережені конфігурації | `GET/POST /configurations`, `GET/PATCH/DELETE /configurations/:id` |
| Заявки | `GET/POST /requests`, `GET/DELETE /requests/:id` (видалення — лише власна заявка клієнта разом із діалогом) |
| Чат та сповіщення | `GET/POST /requests/:id/messages`, `PATCH /requests/:id/read`, `GET /notifications/unread-count`, `GET /notifications`, `PATCH /notifications/requests/:id/read`, `DELETE /notifications/:id`, `DELETE /notifications` (очистити все; лише власні сповіщення) |
| Адміністратор | `GET /admin/customers`, `GET /admin/customers/:id` (з заявками, конфігураціями й лічильниками), `DELETE /admin/customers/:id` (видалення акаунта адміністратором), `GET /admin/requests`, `PATCH /admin/requests/:id/status`, `POST /admin/requests/:id/reopen`, `GET /admin/email-notifications`, `POST /admin/email-notifications/:id/retry`, `GET /admin/overview` (метрики для дашборду), `GET /admin/diagnostics`, `GET /admin/audit` |
| Гостьові заявки | `POST /guest-requests` (публічний, ідемпотентний за `id`), `GET /admin/guest-requests`, `PATCH /admin/guest-requests/:id/status` (`new`/`in_progress`/`done`) |
| 2FA адміна | `GET /auth/2fa/status`, `POST /auth/2fa/setup` (потрібен пароль), `POST /auth/2fa/enable` (код TOTP), `POST /auth/2fa/disable` (пароль + код); у `POST /auth/login` поле `code` обов'язкове, коли 2FA увімкнено; кожен TOTP-код приймається лише один раз (для наступного входу потрібен код нового 30-секундного кроку), код відновлення теж одноразовий |

Коли `SELTIVO_REQUIRE_EMAIL_VERIFICATION=1`, акаунт існує одразу з `email_verified_at=null`, але доступ закритий: заявки й чат доступні лише після `POST /auth/verify-email` (шестизначний код або token). Якщо такий клієнт пробує увійти, сервер за відсутності чинного коду надсилає **новий код** (ліміт 5 разів на 15 хв) і повертає `403` із поясненням; після підтвердження вхід працює звично.

Пагінація: більшість спискових ендпоїнтів (`/configurations`, `/requests`, `/admin/customers`, `/admin/requests`, `/admin/guest-requests`, `/admin/email-notifications`) приймають `?offset=&limit=` (за замовчуванням `offset=0`, `limit=50`, максимум `100`) і повертають `items` та `nextOffset` (або `null`). Виняток — `/requests/:id/messages`: там курсор `?cursor=&limit=` (за замовчуванням `cursor=0`, `limit=50`, максимум `50`) і у відповіді `items` та `nextCursor` (або `null`). `/notifications` повертає останні 30 сповіщень без пагінації.

Адмінська сесія триває щонайбільше 12 год навіть з `rememberMe`. `SELTIVO_REQUIRE_ADMIN_2FA=1` забороняє вхід адміну без увімкненої 2FA — **спочатку** увімкніть 2FA на всіх адмінських акаунтах через `/admin/security`, і лише потім виставляйте прапорець (інакше адмін не зможе увійти, щоб налаштувати її). Секрети TOTP і хеші кодів відновлення зберігаються в таблиці `admin_two_factor` і потрапляють у логічні бекапи.

Створення заявки вимагає `clientSubmissionId` (UUID); повідомлення — `clientMessageId` (UUID). Повторіть той самий ID і ті самі дані після timeout: сервер поверне попередній результат. Для оновлення конфігурації та статусу потрібен `If-Match` із поточною версією. Чужі заявки й конфігурації повертають 404.

Конфігурація зберігається як JSON до 8 МБ; до 30 зображень PNG/JPEG/WebP можуть бути вкладені як data URL. Створена заявка отримує окремий знімок конфігурації, тому подальше редагування або приховування збереженого варіанта не змінює історію заявки. Діалог оновлюється запитами з інтервалом, WebSocket і вкладень у v1 немає. Повідомлення про відповідь адміністратора надсилається email; помилка доставки не видаляє повідомлення з діалогу.

`DELETE /configurations/:id` приховує збережений варіант, але не стирає знімок у вже створених заявках. `DELETE /me` видаляє клієнтський акаунт разом із заявками й чатом після перевірки пароля. У Worker окремий Durable Object зберігає журнал ID видалень (акаунтів і заявок, які клієнт видалив через `DELETE /requests/:id`) і повторно застосовує їх після PITR або відновлення з копії. Якщо журнал недоступний, видалення заявки повертає `503` і нічого не видаляє. Функція вимкнена за замовчуванням до пробного restore на staging; порядок увімкнення — у [Cloudflare operations](docs/cloudflare-operations.md). Строк даних у вже створених копіях — до 30 днів.

Worker підготовлено до щоденної логічної копії в R2 о 02:00 UTC та погодинного очищення копій, старших за 30 днів. Приватний bucket, 30-денне правило зберігання й пробне відновлення на окремому staging Worker перевірені; деталі та команди повторної перевірки — у [Cloudflare operations](docs/cloudflare-operations.md).

## Перевірки

```powershell
npm run typecheck
npm test
```

Next frontend підключено через `/api/v1` rewrite. Каталог `registry.ts + catalog.json` лишився без міграції; вихідний код Fashion 01 не змінювався. Для запуску обох процесів дивіться README у папці SELTIVO.
