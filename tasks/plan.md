# План бекенду SELTIVO, v1

> Уточнення від власника проєкту: міграцію каталогу зараз **не виконувати**. `registry.ts` + `catalog.json` лишаються джерелом макетів. Нижче старі пункти про перенесення каталогу й редактора макетів до БД слід вважати відкладеними; поточна реалізація бекенду охоплює акаунти, конфігурації, заявки та чат.

## 1. Рішення і відкриті питання

### Вихідний стан

- Next.js 16.4.6, React 19, Zod 4, `cacheComponents: true`, self-hosted Node. Каталог — три вбудовані картки плюс overlay `SELTIVO_DATA_DIR/catalog.json`; локально overlay v1 містить дві картки (`fashion-01`, `interior-01`). Ідентифікатори і slug уже незмінні після створення.
- `/admin` має один спільний пароль і 8-годинний HMAC cookie. Заявка `/api/studio/submit` надсилається тільки в Telegram, не має ID/статусу/історії; за відсутності секретів повертає 503. Studio тримає чернетку в IndexedDB, зображення в конфігурації — data URL. ZIP імпорт і Docker-збірка макетів будуть прибрані.
- Папка `Seltivo backend` порожня. Новий серверний код розмістити лише тут; frontend і маршрути залишаються в `SELTIVO`. Код Fashion 01 і його дизайн не змінювати.

### Архітектура

1. Один Node.js/TypeScript HTTP API у `Seltivo backend` (Fastify + Zod + `better-sqlite3`), одна SQLite БД у WAL на постійному локальному томі, SQL-міграції без ORM. Next — UI/SSR. На production reverse proxy віддає `/api/v1/*` бекенду під тим самим origin; браузер не звертається на інший домен. Внутрішній Next SSR fetch передає тільки потрібний session cookie. Це один бекенд, без Worker, WebSocket, Redis, черг та окремого сервісу сповіщень. SQLite відповідає теперішньому одному інстансу; PostgreSQL обирати тільки після потреби в багатьох інстансах/одночасних записах, яку підтвердять виміри.
2. Для публічного каталогу Next читає API на сервері. На першому етапі читання без кешу для правильності відразу після редагування; після вимірювання можна додати короткий `use cache` та керовану інвалідацію. Приватні сторінки та API — `no-store`, auth на кожній операції. За правилами локальної документації Next 16 session read у `cacheComponents` має бути за `Suspense` або сторінка з `instant = false`; не кешувати дані різних користувачів спільно.
3. Реєстрація клієнта: email + пароль, підтвердження email перед створенням заявки чи повідомленням. Перегляд каталогу і локальна чернетка доступні без входу. Адміністратор створюється одноразовою CLI-командою через секрет середовища; спільний пароль не переноситься як обліковий запис. Паролі — scrypt з індивідуальною сіллю і параметрами, сесії — випадковий 256-бітний токен, у БД тільки його SHA-256, ротація після входу, TTL, logout/revoke. Cookie: HttpOnly, Secure в production, SameSite=Lax, Path=/; Origin/CSRF перевірка для мутацій, rate limit для auth і повідомлень. Email verification та password reset — одноразові хешовані токени з TTL. Якщо немає поштового провайдера, реєстрацію не вмикати публічно.
4. `Request` є заявкою, не оплачуваним замовленням: ціну/оплату у v1 не моделювати. Один `Conversation` створюється в тій самій транзакції на кожну заявку. Історія = повідомлення + події зміни статусу; окремої таблиці «взаємодій» не потрібно. Статуси: `submitted → reviewing → needs_info|in_progress|cancelled`, `needs_info → reviewing|in_progress|cancelled`, `in_progress → completed|needs_info|cancelled`; `completed` і `cancelled` завершальні, повторне відкриття — окрема явна адмін-операція з причиною й audit event. Клієнт бачить статус, але не міняє його.
5. Чат v1: текст до 4000 символів, UTC-час від сервера, курсорна пагінація, стан прочитання по кожному учаснику. У клієнта «прочитано командою» означає, що повідомлення прочитав хоча б один адміністратор; у кожного адміністратора власний лічильник непрочитаних. Оновлення вручну, при поверненні фокусу та кожні 20–30 секунд лише при відкритому діалозі. Нові відповіді — unread badge у кабінеті та email одержувачу (для відповіді клієнта — на узгоджену пошту команди); збій email не відміняє збережене повідомлення, фіксується в логах/моніторингу. Вкладень чату і push-сповіщень у v1 немає.
6. Після втрати мережі текст і `clientMessageId` лишаються в `sessionStorage` вкладки як чернетка/очікуване повідомлення. Повторна відправка з тим самим UUID повертає вже створене повідомлення. При неоднозначному timeout клієнт спершу звіряє список, потім повторює той самий запит. Заявка аналогічно має `clientSubmissionId`; статус успіху показувати тільки після підтвердження БД. Без автоматичного нескінченного retry.
7. Зображення Studio у v1 лишаються всередині приватного JSON конфігурації; сервер перевіряє структуру, тип data URL (PNG/JPEG/WebP), декодований розмір, загальний ліміт 8 МБ і кількість. Це дає одну транзакційну копію з БД. Якщо реальні конфігурації регулярно перевищуватимуть ліміт або база ростиме надто швидко — винести assets у приватне сховище окремим етапом. ZIP файли макетів і вкладення чату не зберігати. Наявні статичні демо/файли не видаляти до інвентаризації production.

### Шлях користувача та екрани

Гість: `/templates` → картка → демо/Studio → локальна чернетка → вхід/реєстрація (повернення до Studio) → «Зберегти конфігурацію» → «Створити заявку». Якщо конфігуратора немає, дозволити заявку на макет без `configurationId` із побажаннями; не показувати фальшивий Studio. Створення заявки атомарно фіксує snapshot конфігурації, контактів і макета, призначає ID і відкриває один діалог. Клієнт у `/account/requests/[id]` бачить статус, таймлайн, чат. Адміністратор у `/admin/requests/[id]` відповідає і змінює статус; після `completed/cancelled` діалог лише для читання, доки адміністратор явно не відкриє заявку знову.

Екрани клієнта: `/register`, `/login`, `/verify-email`, `/forgot-password`, `/reset-password`, `/account` (огляд/непрочитані), `/account/profile`, `/account/configurations`, `/account/configurations/[id]`, `/account/requests`, `/account/requests/[id]` (деталі, таймлайн, чат). Адмін: `/admin` (огляд), `/admin/customers` + `[id]`, `/admin/requests` + `[id]`, `/admin/templates` + `[id]`, `/admin/audit`. Оновлення дизайну Fashion 01 не входить у ці екрани.

### Питання до запуску

- Домен/reverse proxy і production том для SQLite; один інстанс підтверджений?
- SMTP-провайдер, адреса відправника, політика доставки/помилок; чи сповіщати клієнта email про кожну відповідь і зміну статусу?
- Строки зберігання заявок, листування, audit і резервних копій, а також процес законного видалення після завершення роботи.
- Чи треба переносити старі заявки з Telegram вручну? У поточному застосунку немає локальних записів або стабільних ID для автоматичного зв’язування з користувачами.

## 2. Схема даних

Усі ID зовнішніх сутностей — UUID, час — UTC ISO 8601; SQLite `TEXT` + `CHECK`, `FOREIGN KEY` увімкнено, JSON валідується Zod перед записом і `json_valid` у БД. Обмеження унікальності — у БД, не лише в API.

| Таблиця | Поля (головні) | Обмеження та індекси |
| --- | --- | --- |
| `users` | `id`, `email_normalized`, `password_hash`, `role` (`customer/admin`), `name`, `phone`, `telegram`, `preferred_contact`, `email_verified_at`, `disabled_at`, `created_at`, `updated_at` | `UNIQUE(email_normalized)`, `INDEX(role, created_at)`; admin email теж унікальний |
| `sessions` | `token_hash`, `user_id`, `created_at`, `expires_at`, `revoked_at` | PK `token_hash`, FK user; `INDEX(user_id, expires_at)`, `INDEX(expires_at)` |
| `auth_tokens` | `token_hash`, `user_id`, `purpose` (`verify/reset`), `expires_at`, `used_at` | PK `token_hash`, `INDEX(user_id, purpose, expires_at)` |
| `templates` | `id` (поточний сталий ID), `slug`, `name`, `category`, `status`, `description`, `short_description`, `thumbnail`, `preview_image`, `preview_url`, `editor_config_json`, `price`, `currency`, `featured`, `preview_variant`, `demo_build_id`, `features_json`, `customization_json`, `created_at`, `updated_at` | PK `id`, `UNIQUE(slug)`, `INDEX(status, category, featured)`; `id/slug` immutable |
| `configurations` | `id`, `owner_id`, `template_id`, `name`, `schema_version`, `data_json`, `revision`, `created_at`, `updated_at`, `deleted_at` | FK owner/template, `INDEX(owner_id, updated_at DESC)`; не змінювати `template_id` при редагуванні |
| `requests` | `id`, `customer_id`, `template_id`, `configuration_id NULL`, `client_submission_id`, `status`, `status_version`, `template_snapshot_json`, `config_snapshot_json NULL`, `contact_snapshot_json`, `note`, `features_json`, `created_at`, `updated_at`, `completed_at NULL` | FK customer/template/config; `UNIQUE(customer_id, client_submission_id)`, `INDEX(customer_id, created_at DESC)`, `INDEX(status, updated_at DESC)`; snapshot незмінний |
| `conversations` | `id`, `request_id`, `created_at` | `UNIQUE(request_id)` і FK request |
| `messages` | `id INTEGER PRIMARY KEY AUTOINCREMENT`, `conversation_id`, `sender_id`, `client_message_id`, `body`, `created_at` | FK conversation/sender, `UNIQUE(sender_id, client_message_id)`, `INDEX(conversation_id, id)`; текст не редагувати/видаляти у v1 |
| `conversation_reads` | `conversation_id`, `user_id`, `last_read_message_id`, `read_at` | PK `(conversation_id,user_id)`, FK; `INDEX(user_id, conversation_id)`; watermark можна рухати тільки вперед і до реально отриманого повідомлення цього діалогу |
| `request_events` | `id`, `request_id`, `actor_id`, `old_status`, `new_status`, `reason`, `created_at` | FK, `INDEX(request_id, created_at)`; append-only, клієнт бачить статус і публічну причину |
| `audit_log` | `id`, `actor_id`, `action`, `entity_type`, `entity_id`, `metadata_json`, `created_at` | `INDEX(actor_id, created_at)`, `INDEX(entity_type, entity_id, created_at)`; без паролів, токенів, тексту повідомлень і повного PII |

Зв’язки: `User 1→N Configuration`, `User 1→N Request`, `Template 1→N Configuration/Request`, `Configuration 0→N Request` (кожна заявка має власний незмінний snapshot), `Request 1→1 Conversation`, `Conversation 1→N Message`, `User 1→N Message`, `Conversation N↔N User` через `conversation_reads`. Усі перевірки власника виконуються через `requests.customer_id` / `configurations.owner_id`, а не через надісланий клієнтом ID власника. Admin переглядає всі заявки; роль чітко перевіряється сервером.

## 3. Матриця доступу

| Операція | Гість | Клієнт (своє) | Адміністратор |
| --- | --- | --- | --- |
| Публічний каталог/демо | читати | читати | читати |
| Реєстрація, вхід, відновлення | так, з rate limit | власний акаунт | власний акаунт; admin не може зареєструвати себе через public API |
| Профіль/контакти | ні | читати/міняти свої | читати профілі клієнтів, не змінювати їхні паролі/контакти у v1 |
| Конфігурації | локальна чернетка | CRUD свої, optimistic revision | читати тільки snapshot у відповідній заявці; не редагувати клієнтську чернетку |
| Заявки | ні | створити, читати свої | читати всі, фільтрувати, змінювати статус за допустимим переходом |
| Діалог | ні | читати/писати лише у своїй активній заявці | читати/писати у будь-якій активній заявці |
| Прочитання | ні | змінити тільки свій watermark | змінити тільки свій watermark |
| Картки макетів | читати | читати | створювати/редагувати, без ZIP і фізичного видалення у v1 |
| Audit | ні | бачить лише публічні статусні події своєї заявки | читати audit і статусні події |

Для чужого `configuration/request/conversation` API повертає 404, для неавторизованого 401; відмова за роллю 403. Не покладатися на приховані кнопки або Next `proxy` як на захист даних.

## 4. API-контракти та етапи

Префікс `/api/v1`, JSON, серверний UTC, `Cache-Control: private, no-store` для auth/приватних відповідей; `201` для створення, `204` для logout/read, `400/422` формат/валідація, `401/403/404`, `409` конфлікт ревізії/статусу, `413` розмір, `429` rate limit. Пагінація `limit ≤ 50`, `cursor`; у відповідях `nextCursor` або `null`.

| Метод і шлях | Вхід → вихід | Доступ |
| --- | --- | --- |
| `POST /auth/register`, `/auth/verify-email`, `/auth/login`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password` | email/name/password або одноразовий token; session cookie; reset/forgot не розкриває існування email | public для перших/відновлення, logout — session |
| `GET/PATCH /me` | `{id,email,name,phone,telegram,preferredContact,emailVerified}`; PATCH лише дозволені контактні поля | власник |
| `GET /templates`, `GET /templates/:slug` | тільки публічні поля Template | усі |
| `POST /admin/templates`, `PATCH /admin/templates/:id` | поточна схема картки без ZIP; ID/slug immutable; `previewUrl`, `demoBuildId` та `editorConfig` не редагуються через форму; `status=available` лише за реального демо | admin |
| `GET/POST /configurations`, `GET/PATCH/DELETE /configurations/:id` | `{templateId,name,data}` → `{id,revision,...}`; PATCH `If-Match: <revision>`; DELETE позначає чернетку видаленою | власник, verified для запису |
| `POST /requests` | `{templateId,configurationId?,contact,note,features,clientSubmissionId}` → `{id,status,conversationId}`; snapshot + conversation в одній транзакції | verified customer |
| `GET /requests`, `GET /requests/:id` | список своїх; деталі включають snapshot, статусні події, conversation ID/unread | власник |
| `GET /requests/:id/messages`, `POST /requests/:id/messages`, `PATCH /requests/:id/read` | `?cursor=<messageId>&limit=50`; `{body,clientMessageId}`; `{lastSeenMessageId}`; віддає `id,author,body,createdAt,readState` | власник або admin; запис тільки активний request |
| `GET /notifications/unread-count` | `{total,byRequest:[...]}` з `conversation_reads`, без окремої таблиці | session |
| `GET /admin/customers`, `GET /admin/customers/:id`, `GET /admin/requests`, `GET /admin/requests/:id`, `PATCH /admin/requests/:id/status`, `POST /admin/requests/:id/reopen`, `GET /admin/audit` | списки з фільтром/курсором; status PATCH `{status,reason}` + `If-Match: <statusVersion>` → новий статус і версія | admin |

Для status update, нового message і request creation спочатку DB commit, потім email/Telegram best-effort. Telegram може лишитися як опціональний admin alert без передачі повного конфіга; він не є джерелом істини. Після fail email API все одно повертає успіх запису; лог/метрика сповіщень показують проблему.

### Фази і критерії готовності

1. **Фундамент та міграція каталогу.** У `Seltivo backend` створити package/scripts, конфіг, SQLite migrations, healthcheck, інтеграційні тести API; dry-run імпорту об’єднаного `registry.ts + catalog.json` із пріоритетом overlay. Зробити backup, перевірити count/IDs/slugs/preview/editorConfig/price/features, імпорт і повторний запуск без дублікатів. Перемкнути Next читання каталогу; звірити три локальні картки та production кількість; rollback — повернути файлове читання. **Готово:** каталог в UI і БД збігається, існуючі демо посилання працюють, `fashion-01` не змінено.
2. **Auth і профіль.** Admin bootstrap, клієнтська реєстрація/verify/login/reset, sessions, CSRF/rate limits, профіль, екрани. Зробити нового admin і перевірити, що старий спільний пароль більше не дає доступу після cutover; старі cookie інвалідовані. **Готово:** перевірені 401/403, invalid/expired tokens, logout/revoke, доступ до свого профілю, email працездатний.
3. **Конфігурації і заявки.** Прив’язати Studio до auth, перенести поточну локальну чернетку за явною дією користувача, збереження/оновлення з ревізією, immutable snapshot та idempotent створення заявки; для макета без Studio — заявка без config. Замінити Telegram-only submit, не показувати success до DB commit. **Готово:** збереження/повтор після timeout дає одну заявку, змінена після submit чернетка не змінює snapshot, чужий ID не відкривається.
4. **Адмінка заявок і каталог.** Списки клієнтів/заявок, фільтри, деталі, status transitions/events/audit; перевести на персональний admin login; перенести редактор карток, прибрати ZIP UI/API/jobs/builder тільки після інвентаризації production статичних демо. **Готово:** всі наявні картки редагуються, status events і audit є, legacy ZIP не доступний, старі демо файли не втрачені.
5. **Чат і сповіщення.** Повідомлення, per-user read watermark, 20–30 с polling, unread badge, email, sessionStorage retry. **Готово:** один діалог на заявку; два admin мають власний unread; повтор з тим самим UUID не дублює повідомлення; offline/delayed response відновлюється; чужий діалог 404.
6. **Експлуатація.** Backup/restore runbook, перевірка БД (`integrity_check`), аудит retention/deletion, rate/size limits, E2E ключових потоків, staging restore, моніторинг 5xx, email fail, DB size/latency. **Готово:** відновлення з копії на тестовому середовищі пройдено; no-PII logs; `npm run typecheck`, `lint`, `build` для Next і тести бекенду зелені.

## 5. Ризики і перевірки

| Ризик | Перевірка/захист |
| --- | --- |
| Втрата каталогу при міграції | dry-run, backup JSON/DB, транзакційний і повторюваний import, порівняння кожного поля і кількості, rollback читання; не видаляти `catalog.json` одразу |
| Зображення роздувають БД/заявку | ліміти 8 МБ на config, MIME/сигнатура, облік DB size; UI пояснює перевищення; assets storage тільки після вимірів |
| Чужі заявки/діалоги | owner check в SQL, role check на кожній операції, тести IDOR для GET/POST/read/status, no-store і мінімальні DTO |
| Дублікати після timeout | `UNIQUE(customer_id, client_submission_id)` і `UNIQUE(sender_id, client_message_id)`, транзакційна відповідь з оригінальним ID, ручна/автоматична звірка |
| Ненадійна доставка пошти/Telegram | DB є джерелом істини; unread у UI; лог і сигнал про email fail; не обіцяти email як гарантовану доставку без окремого механізму retry |
| SQLite на OneDrive/мережевому томі | production DB лише на локальному persistent volume одного хоста; окрема резервна копія; при multi-instance переходити на PostgreSQL |
| Витік через кеш Next 16 | приватні fetch/відповіді `no-store`, session read у Suspense/`instant=false`, тести двох акаунтів і admin після logout |
| Видалення даних vs історія заявок | затвердити retention; видаляти сесії й чернетки одразу, заявки/листування за погодженим строком або псевдонімізувати за вимогою; backup expiry окремо; audit без тексту/PII |

Backup: щоденна консистентна SQLite online backup з шифруванням і зберіганням поза live томом, щотижнева пробна restore, цільові RPO 24 год / RTO 4 год до підтвердження бізнесом. Не копіювати лише `.db` під час роботи WAL. Файли `catalog.json` та поточні production `sites` зберігати в backup, поки міграцію не прийнято. Audit append-only: входи адміністратора, зміни карток, статусів, повторне відкриття, видалення/експорт даних; не зберігати IP довше обраної політики. Процедура видалення має стерти або знеособити PII з активної БД та дочекатися циклу expiry копій; конкретні строки — відкрите бізнес-рішення.

## 6. Поточні файли для зміни

| Файли SELTIVO | Дія |
| --- | --- |
| `src/templates/catalog.ts`, `src/templates/registry.ts`, `src/templates/types.ts` | імпорт seed/overlay, нове серверне джерело каталогу, збереження поточного контракту карток |
| `src/app/admin/page.tsx`, `src/admin/AdminDashboard.tsx`, `src/app/admin/admin.css`, `src/admin/auth.ts`, `src/app/admin/api/{login,logout,templates}/route.ts` | персональний auth, нові екрани/розділи, каталог через backend |
| `src/app/admin/api/upload/route.ts`, `src/app/admin/api/jobs/[id]/route.ts`, `src/admin/importer.ts`, `src/admin/builder.ts`, `src/app/preview-assets/[slug]/[[...path]]/route.ts`, `src/app/demo/[slug]/page.tsx`, `src/app/uploaded-demo/[slug]/page.tsx` | прибрати імпорт/Jobs після інвентаризації; демо-serving зберегти, якщо є production build assets |
| `src/app/api/studio/submit/route.ts`, `src/studio/configurator/SubmissionModal.tsx`, `src/studio/lib/configDraft.ts` | замінити Telegram-only submit на запис заявки, save/load конфігурацій і явний перенос локальної чернетки |
| `src/studio/lib/configArchive.ts`, `package.json`, `package-lock.json` | прибрати ZIP-експорт, якщо вимога стосується всіх ZIP; якщо тільки адмін-імпорту — лишити експорт клієнта як окремий продуктово погоджений пункт |
| `src/app/(platform)/templates/page.tsx`, `src/app/(platform)/templates/[slug]/page.tsx`, `src/app/studio/[slug]/page.tsx`, `src/app/sitemap.ts`, `src/components/layout/Header.tsx` | дані з API, auth entrypoints, правильна поведінка нових/неінтегрованих макетів |
| `next.config.ts`, `README.md`, `docs/ARCHITECTURE.md`, `.env.example` (додати) | конфігурація backend URL/proxy/deploy, документація/змінні/backup; точні Next API перед реалізацією знову звірити з локальними `node_modules/next/dist/docs/` |
| Нові `src/app/{account,login,register,...}`, `src/app/admin/{customers,requests,templates,...}` | UI без змін коду/дизайну Fashion 01 |

Нові backend файли — тільки під `C:\Users\sasas\OneDrive\Desktop\Seltivo backend`: `package.json`, `src/server.ts`, `src/db/*`, `src/routes/*`, `src/auth/*`, `src/notifications/*`, `migrations/*.sql`, `tests/*`, `scripts/import-catalog.*`, `.env.example`, `README.md`. Цей документ і `tasks/todo.md` — лише план; реалізація ще не почата.
