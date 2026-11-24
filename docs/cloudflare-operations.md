# Cloudflare Worker: дані та реагування

Production використовує SQLite-backed Durable Object `SeltivoData` з ім'ям `primary`. Локальні команди `npm run backup` і `backup:verify` стосуються тільки Node/SQLite і **не створюють копії production Worker**.

## Схема та реліз

- Код зберігає версію Worker БД у таблиці `schema_migrations`. `PRAGMA user_version` у Cloudflare Durable Object не підтримується. Міграції застосовуються послідовно в одній синхронній транзакції перед обробкою запитів. Невідома новіша версія або несумісна стара схема зупиняє об'єкт.
- Перед релізом, що змінює схему, зафіксуйте час, поточну версію коду, поточний [PITR bookmark](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api) і результат `GET /api/v1/admin/diagnostics` операторським акаунтом. Нову версію спочатку перевірте на окремому staging об'єкті (`--env staging`) зі знеособленими даними.
- **Міграція v11** (таблиця `rate_limit_hits`, колонка `admin_two_factor.last_totp_step`) застосовується автоматично під час першого запуску нового коду. Після неї код версій до v11 відмовиться відкрити БД, тож відкат можливий лише на код із v11 або через PITR на bookmark, знятий до релізу. Тому спершу розгорніть на staging.
- Щоденна копія автоматично повторюється (до 3 спроб із паузою 5 с), якщо під час експорту база змінилась; кількість спроб записується в поле `attempts` події `backup_completed`.
- Після релізу перевірте `GET /api/v1/health`, адміністраторську діагностику, вхід, заявку, діалог і повтор клієнтського запиту. Для відкату коду з версією схеми, новішою за код, потрібна сумісна версія Worker; старий код навмисно відмовиться відкрити БД.

## Смоук-тести та перевірки в CI

Обидва смоуки надсилають заголовок `Origin`, який має **точно** збігатися з `SELTIVO_PUBLIC_ORIGIN` цільового Worker (`https://seltivostudio.com` для production, `https://seltivo-staging.seltivostudio.workers.dev` для staging). Неспівпадіння дає 403 ще до бізнес-перевірок, тому всі процедури нижче припускають правильно заданий `SELTIVO_SMOKE_ORIGIN`. Коли `SELTIVO_SMOKE_URL` вказує не на локальний процес, цю змінну треба задати явно — інакше скрипт не стартує, щоб хибне значення за замовчуванням не маскувало реальний збій. Явно задане, але неправильне значення теж дасть 403: це ознака помилки налаштування, а не збою API.

| Скрипт | `SELTIVO_SMOKE_URL` (типова адреса) | `SELTIVO_SMOKE_ORIGIN` (типове значення) | Додаткові змінні |
| --- | --- | --- | --- |
| `scripts/cloudflare-smoke.mjs` | `http://127.0.0.1:8787` (локальний `wrangler dev`) | `https://seltivostudio.com` | Адміністративні перевірки (діагностика, недоставлені листи, історія статусів, а також мутації — повтор листа й PATCH статусу) вимагають **явного** `SELTIVO_SMOKE_ALLOW_ADMIN=1` разом із `SELTIVO_SMOKE_ADMIN_EMAIL` і `SELTIVO_SMOKE_ADMIN_PASSWORD`. Самі облікові дані недостатньо: без opt-in скрипт зупиниться з помилкою, щоб мутації не виконувалися випадково. |
| `scripts/cloudflare-deletion-smoke.mjs` | `http://127.0.0.1:8789` | `https://seltivo-staging.seltivostudio.workers.dev` | Цільовий Worker має мати `SELTIVO_ACCOUNT_DELETION_ENABLED=1`. Скрипт перевіряє `accountDeletionAvailable` через `GET /api/v1/me` і завершується зі зрозумілим повідомленням, якщо функцію вимкнено. Після видалення перевіряється 401 на `GET /api/v1/me`. Скрипт відмовляється запускатися, якщо `SELTIVO_SMOKE_ORIGIN` (або змінене значення за замовчуванням) вказує на production origin `https://seltivostudio.com`: руйнівний smoke — лише на staging. |

Приклад запуску проти staging (для локального `wrangler dev` явні змінні не потрібні):

```powershell
$env:SELTIVO_SMOKE_URL = 'https://seltivo-api-staging.seltivostudio.workers.dev'
$env:SELTIVO_SMOKE_ORIGIN = 'https://seltivo-staging.seltivostudio.workers.dev'
node scripts/cloudflare-smoke.mjs
node scripts/cloudflare-deletion-smoke.mjs
Remove-Item Env:SELTIVO_SMOKE_URL, Env:SELTIVO_SMOKE_ORIGIN
```

Смоук видалення виконуйте тільки на окремому staging Worker із увімкненим `SELTIVO_ACCOUNT_DELETION_ENABLED=1`: вмикати цей прапорець на production заради перевірки заборонено.

CI (`.github/workflows/ci.yml`) окрім typecheck/тестів/build виконує `npm audit --omit=dev --audit-level=high` (зупиняє збірку за відомими вразливостями runtime-залежностей рівня high/critical) та `npx wrangler deploy --dry-run` і `npx wrangler deploy --dry-run --env staging`. Dry-run перевіряє збірку й конфігурацію обох env без звернення до акаунта Cloudflare і без секретів; наявність справжніх секретів (`BREVO_API_KEY`, `SELTIVO_BACKUP_ENCRYPTION_KEY` тощо) він не перевіряє — їх треба задати окремо перед реальним deploy. Завдання має таймаут 15 хвилин, дозвіл `contents: read` і запуск уручну через `workflow_dispatch`.

## Відновлення й видалення

Узгоджений режим — щоденна копія з 30-денним зберіганням. Код Worker містить Cron Trigger на **02:00 UTC щодня** і логічний експорт у приватний R2 bucket `seltivo-backups`. Копія складається з частин таблиць та `manifest.json` з кількістю рядків і SHA-256 кожної частини. **З увімкненим `SELTIVO_BACKUP_ENCRYPTION_KEY` вміст частин — base64-шифротекст AES-GCM, а не сирий JSON** (IV теж base64 і лежить у маніфесті); маніфест містить лише метадані — кількості, хеші відкритого тексту й ознаку `encryption: aes-gcm-256`, а не відкриті дані. Маніфест записується останнім; якщо БД змінилася під час експорту або операція обірвалася, готової копії немає. Незавершені частини прибере R2 lifecycle. Схема звіряється зі списком таблиць; нова таблиця зупинить експорт, доки його явно не оновлять. Це логічна копія даних, а не SQLite-файл. Вона не включає внутрішній журнал `DeletionLedger`: після restore підтверджені видалення треба застосувати окремо.

Секрет `SELTIVO_BACKUP_ENCRYPTION_KEY` є **обов'язковим** для створення нових логічних копій Worker: без нього `/internal/backup` і cron повертають помилку, бо копії містять хеші паролів і TOTP-секрети адмінів. Задайте його окремо для кожного Worker: `npx wrangler secret put SELTIVO_BACKUP_ENCRYPTION_KEY` і `npx wrangler secret put SELTIVO_BACKUP_ENCRYPTION_KEY --env staging`. Використовуйте випадковий ключ із менеджера паролів і **ніколи** не додавайте його до `wrangler.jsonc`, `.env*` чи Git. Втрата ключа означає неможливість розшифрувати наявні копії, а обертання ключа плануйте разом із перешифруванням копій. Формат ключа й сумісність зі старими plaintext-копіями описані в [backup-recovery](backup-recovery.md).

Щогодини о **:10 UTC** Worker окремо видаляє об'єкти копій, яким уже виповнилося 30 днів, і записує `backup_retention_completed` з кількістю видалених об'єктів. `backup_retention_failed` вимагає негайної перевірки; R2 lifecycle залишається запасним механізмом. Через погодинний інтервал та можливі збої це не є математичною гарантією видалення рівно на 30-й день.

Bucket `seltivo-backups` створено 15 листопада 2026 року. Перевірено правило `seltivo-backups-30d` для префікса `seltivo-backups/v1/` з терміном 30 днів; публічний `r2.dev` URL вимкнений і власних доменів немає. **23 листопада 2026 року новий код Worker розгорнуто і на production, і на staging разом із секретом `SELTIVO_BACKUP_ENCRYPTION_KEY`.** Після першого cron-запусту о 02:00 UTC підтвердьте в логах Worker подію `backup_completed`, а в bucket — наявність `manifest.json` і всіх частин; якщо замість цього з'явилися `backup_failed` чи `backup_encryption_key_missing` — реагуйте за чеклистом нижче. Перевірити налаштування bucket і вміст копій повторно можна так:

```powershell
npx wrangler r2 bucket lifecycle list seltivo-backups
npx wrangler r2 bucket dev-url get seltivo-backups
npx wrangler r2 bucket domain list seltivo-backups
```

Wrangler 4.162 **не має** команди `r2 object list`. Список об'єктів дивіться в Dashboard (R2 → bucket → Objects) або через API з токеном, що має доступ до R2 (токен не зберігайте в репозиторії):

```powershell
$token = $env:CLOUDFLARE_API_TOKEN
$account = '642a1378267910de72f484b86dd6eb73'
$bucket = 'seltivo-backups'
$base = "https://api.cloudflare.com/client/v4/accounts/$account/r2/buckets/$bucket/objects"
$r = Invoke-RestMethod -Uri "$base`?per_page=1000" -Headers @{ Authorization = "Bearer $token" }
$r.result | Select-Object key, size, last_modified
# Перевірка шифрування останнього маніфесту:
$manifest = @($r.result) | Where-Object key -like '*/manifest.json' | Sort-Object last_modified -Descending | Select-Object -First 1
$obj = Invoke-RestMethod -Uri "$base/$([uri]::EscapeDataString($manifest.key))" -Headers @{ Authorization = "Bearer $token" }
"encryption=$($obj.encryption) schemaVersion=$($obj.schemaVersion)"
```

Очікуване значення `encryption` для нових копій — `aes-gcm-256`. Відсутність поля означає застарілу plaintext-копію.

**23 листопада 2026 року під час повторного аудиту виявлено 20 plaintext-маніфестів (8 у `seltivo-backups`, 12 у `seltivo-staging-backups`), створених 15–23 листопада до деплою нових кодів.** Вони містять хеші паролів і таблицю `admin_two_factor` у відкритому вигляді. Видаляйте їх **тільки після** того, як з'явиться й успішно відновиться принаймні одна копія з `encryption: aes-gcm-256` (найближчий cron — 02:00 UTC). До того часу вони лишаються єдиним доступним джерелом відновлення. Документуйте факт і дату видалення в журналі операцій.

Після deploy вручну запустіть Cron у staging, перевірте `backup_completed`, наявність маніфесту та всіх частин у R2, а потім виконайте restore в окрему порожню staging БД. `restoreLogicalBackup` перевіряє версію схеми, SHA-256, кількість рядків і зовнішні ключі; передайте їй актуальні ID з `DeletionLedger`, інакше стара копія може повернути видалені акаунти. Якщо restore обірвався, відкиньте всю staging БД і почніть із нової: частково відновлена БД не придатна для API. Не підключайте production API до staging копії з персональними даними. Фактичну тривалість копії беріть із події `backup_completed`; перевищення 15 хв, пропущений день або `backup_failed` вимагають реакції. R2 lifecycle видаляє об'єкти асинхронно й може затриматися після 30-го дня; це слід перевіряти окремо, якщо строк є жорсткою межею.

R2 bucket у тому самому Cloudflare акаунті є окремим сховищем від Durable Object, але не захищає від втрати доступу до всього акаунта. Для захисту від цього потрібна ще одна копія поза акаунтом. Cloudflare також надає [PITR за останні 30 днів](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api), але його bookmark не є файлом копії. API `onNextSessionRestoreBookmark` відновлює **цей самий Durable Object** після рестарту; локальний `wrangler dev` не підтримує PITR. Не застосовуйте пробне відновлення до production.

15 листопада 2026 року на окремому staging Worker виконано логічний backup у `seltivo-staging-backups` і restore в новий тимчасовий Durable Object: **46 рядків**, `quick_check=ok`, без помилок зовнішніх ключів. Перевірено вхід двох клієнтів і двох адміністраторів, недоступність чужих заявок, заявку, чат, відповідь та історію статусів. Тимчасовий об'єкт видалено після тесту; якщо перевірка обірветься, alarm видалить його через годину. Окремий браузерний тест через staging Next-проксі обірвав відповідь після створення заявки: повтор із тим самим ID повернув одну заявку. Durable Object відхиляє `PRAGMA integrity_check` з `SQLITE_AUTH`, тому повну перевірку SQLite-файлу в цьому середовищі виконати не можна; `quick_check` і `foreign_key_check` — доступні перевірки. Тривалість майбутніх restore фіксуйте від запуску до цих перевірок і сценаріїв API.

Для повторного drill тимчасово задайте staging-only секрет `SELTIVO_STAGING_TEST_KEY`, виконайте `node scripts/staging-restore-smoke.mjs`, а потім видаліть секрет через `npx wrangler secret delete SELTIVO_STAGING_TEST_KEY --env staging`. Секрет відкриває лише staging-операції з тестовими адміністраторами та відновленням; production Worker додатково відхиляє їх за значенням origin. Не залишайте ключ увімкненим між перевірками.

Узгоджено видаляти клієнтський акаунт разом із конфігураціями, заявками й чатом з активної БД; дані у вже створених копіях можуть залишатися до завершення їхнього 30-денного строку. Окремий Durable Object `DeletionLedger` у тому самому Worker зберігає ID підтверджених видалень і час. З міграцією v11 журнал також зберігає ID заявок, які клієнт видалив сам (`request:<id>`); видалення заявки спершу пише в журнал і без нього повертає `503`. Після PITR відновлюйте **лише** основний об'єкт `SeltivoData`; його запуск повторно видалить ці акаунти й заявки за журналом, а staging restore передає обидва списки в `restoreLogicalBackup`. Видалення в API вимагає поточного пароля й очищує сесію. Журнал не містить email або текстів, але ID поки зберігаються без строку автоматичного видалення, щоб старе відновлення не повернуло дані.

Функція **вимкнена за замовчуванням**. Вмикайте `SELTIVO_ACCOUNT_DELETION_ENABLED=1` лише після перевірки restore на окремому staging Durable Object і підтвердження незалежних копій. Окремий Durable Object захищає від PITR відкату основного об'єкта, але не замінює незалежну копію чи захист від втрати всього Cloudflare акаунта. `DELETE /configurations/:id` лише приховує збережений варіант і не стирає знімок у заявці. Смоук видалення перевіряє цю функцію через `accountDeletionAvailable`; для перевірки production-процедури вмикайте прапорець **тільки на окремому staging Worker**, не на production.

## Пошта

У Worker налаштуйте `BREVO_API_KEY` і `BREVO_SENDER_EMAIL` через Wrangler secrets. Повідомлення чату зберігається перед викликом Brevo. Кожен лист чату має запис у `email_notifications` зі станом `pending`, `sending`, `sent` або `failed`; помилка не стирає повідомлення. Погодинний cron (`10 * * * *`) автоматично повторює недоставлені листи: не частіше ніж раз на 10 хв для кожного, щонайбільше 6 спроб, лише листи молодші за 3 дні; підсумок пишеться в подію `email_retry_completed`. Вичерпані листи лишаються для ручного повтору: адміністратор бачить їх на `/admin/email-notifications` і може повторити відправлення. Повтор використовує наявний `message_id`; сам лист може бути доставлений двічі, якщо провайдер прийняв попередню спробу, а відповідь загубилась. Секрети й текст листа не записуються в журнал помилок.

Для листа відновлення пароля зберігається лише хеш токена; невдалу доставку цього листа не можна безпечно повторити з адмінки. Користувач може запросити нове посилання. Команда має перевірити реальну доставку після налаштування Brevo.

## Метрики й короткі дії при збої

У `wrangler.jsonc` увімкнені Workers Logs. Кожен запит Worker записує `event=api_request`, `requestId`, метод, HTTP статус, тривалість у мс і розмір SQLite у байтах. Невдача листа записує `event=email_delivery_failed` і код без адреси, токена чи тексту. [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) та [Workers metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/) доступні в Cloudflare dashboard. Пороги нижче — початкові; уточніть їх після тижня фактичних вимірів.

| Сигнал | Початковий поріг | Дія |
| --- | --- | --- |
| HTTP 5xx | понад 1% за 10 хв при щонайменше 100 запитах | Зіставити `requestId` з логом, перевірити останній реліз, `/health` і `/admin/diagnostics`; зупинити реліз при рості помилок. |
| Час API | p95 понад 2 с за 15 хв | Перевірити, які операції йдуть із затримкою, стан Brevo та розмір БД; не змінювати індекси без `EXPLAIN QUERY PLAN`. |
| Пошта | хоча б один `failed` понад 15 хв | Відкрити адмінку пошти, перевірити Brevo/секрети й повторити відправлення після усунення причини. |
| Розмір БД | понад 70% ліміту тарифу або ріст понад 20% за тиждень | Перевірити розмір JSON конфігурацій/заявок і план зберігання; не видаляти дані без процедури. |
| Копії/restore | немає `backup_completed` за 26 год, є `backup_failed` чи `backup_retention_failed`, копія триває понад 15 хв або staging restore невдалий | Перевірити Cron, R2 binding, маніфест і кількість частин. Не оголошувати P0 готовим до успішного staging restore. |

У Cloudflare dashboard ще треба налаштувати сповіщення за цими порогами та призначити чергового. Самі пороги в документі не створюють автоматичних alerts.

### Чеклист сповіщень за подіями

**Налаштовано 23 листопада 2026 року:** монітор `SELTIVO critical Worker events` (ID `0aaf033566da44a7bcf5ecbc64beb765`, розділ Observability → Monitors). Він виконує SQL за даними `logs.workersLogs` щохвилини й реагує на появу будь-якого з рядків `backup_failed`, `backup_retention_failed`, `deletion_replay_failed`, `deletion_replay_ledger_failed`, `backup_encryption_key_missing`, `staging_restore_failed`, `staging_restore_check_failed`, `email_delivery_failed` (чутливість 0.1σ, мінімум 1 подія, повтор не частіше 1 год). Одержувач — `seltivostudio@gmail.com`. Перевірте монітор після першого cron-запуску: у логах має бути `backup_completed`, а не `backup_failed`. **Після релізу міграції v11** додайте до SQL монітора події `email_retry_failed` і `request_deletion_ledger_failed`.


Налаштуйте Cloudflare notifications / log-based alerts (або еквівалентний зовнішній моніторинг) на появу цих `event` у Workers Logs. Позначка **негайно** означає: підняти чергового поза робочим часом, не відкладати до ранку.

| Подія | Що означає | Дія | Термін |
| --- | --- | --- | --- |
| `backup_failed` | Щоденна копія не завершилася | Перевірити Cron, R2 binding, наявність ключа й причину в лозі; день не вважати покритим, доки копія не успішна | **Негайно** |
| `backup_retention_failed` | Не спрацювало видалення копій, старших за 30 днів | Перевірити R2 API й lifecycle як запасний механізм; це строк зберігання PII, не косметика | **Негайно** |
| `deletion_replay_failed` | Повтор підтверджених видалень після restore не виконався | Перевірити `DeletionLedger`, журнал і стан основного об'єкта: можливе повернення видалених акаунтів | **Негайно** |
| `backup_encryption_key_missing` | Секрет `SELTIVO_BACKUP_ENCRYPTION_KEY` відсутній, нові копії не створюються | Задати секрет для відповідного Worker (`npx wrangler secret put SELTIVO_BACKUP_ENCRYPTION_KEY`, для staging — із `--env staging`), потім перевірити копію вручну | **Негайно** |
| `email_retry_failed` | Погодинний автоповтор листів не виконався | Перевірити основний Durable Object і Brevo; листи можна повторити вручну з адмінки | Протягом зміни |
| `request_deletion_ledger_failed` | `DeletionLedger` недоступний, клієнт отримав `503` при видаленні заявки | Перевірити стан `DeletionLedger`; дані не видалено, клієнт може повторити | Протягом зміни |
| `email_delivery_failed` | Збій доставки листа; у лозі є код, але немає адреси чи тексту | Перевірити Brevo/секрети, відкрити `/admin/email-notifications`, повторити після усунення причини | Протягом зміни |

Сповіщення мають іти черговому, а не лише в загальний канал; після налаштування перевірте їх доставку тестовим спрацюванням.
