# SELTIVO backend: реалізація

> Уточнення: міграцію каталогу відкладено. Не змінювати `catalog.json` і поточне керування макетами під час створення акаунтів, заявок та чату.

Деталі контрактів, ризиків і меж: [plan.md](plan.md). Кожен пункт — окрема перевірювана зміна; код не створено.

## Фаза 1 — база та акаунти

- [ ] Створити Node/TypeScript backend package, конфіг, healthcheck і SQL migration runner. Перевірка: запуск/повторний запуск без зміни схеми; тести backend.
- [ ] Зберегти поточне джерело каталогу без змін. Перевірка: наявні картки й демо працюють як раніше.
- [ ] **Контрольна точка:** backend schema/healthcheck працюють, каталог не змінено.

## Фаза 2 — користувачі

- [ ] Додати users/sessions/auth_tokens, admin bootstrap, login/logout. Перевірка: 401/403, expiry, revoke, rate limit, два окремих admin.
- [ ] Додати register/verify/reset і пошту. Перевірка: одноразові TTL токени, нейтральна відповідь forgot, неможливість public admin signup.
- [ ] Додати профіль і клієнтські auth екрани. Перевірка: лише власні дані, session після reload, logout.
- [ ] **Контрольна точка:** реєстрація → підтвердження → вхід → профіль → вихід працює end-to-end; Next/backend checks зелені.

## Фаза 3 — конфігурація та заявки

- [ ] Додати configurations API з owner check, revision, size/type limits. Перевірка: два користувачі ізольовані, 409 на стару ревізію, локальна чернетка переноситься за явною дією.
- [ ] Додати requests + immutable snapshots + conversation creation у транзакції. Перевірка: один ID після retry, зміна чернетки не змінює заявку, без Studio доступна заявка без config.
- [ ] Замінити Telegram-only Studio submit. Перевірка: успіх тільки після commit; UI показує ID/посилання; таймаут не дублює запис.
- [ ] **Контрольна точка:** каталог → Studio → збереження → заявка і заявка без Studio проходять end-to-end.

## Фаза 4 — адмінка

- [ ] Додати admin customers/requests, status transitions, request_events/audit. Перевірка: допустимі переходи, 409 для конкурентного редагування, клієнт бачить лише свої події.
- [ ] Перевести редактор макетів на backend та персональний login. Перевірка: наявні картки цілі, старі cookie/пароль не працюють, rollback можливий.
- [ ] Інвентаризувати production assets та прибрати ZIP upload/jobs/builder без видалення чинних демо. Перевірка: старе демо доступне, ZIP API закритий.
- [ ] **Контрольна точка:** admin редагує картку та статус заявки; старий пароль/ZIP не працюють; rollback перевірено.

## Фаза 5 — чат та запуск

- [ ] Додати messages/read watermarks, ownership, idempotency. Перевірка: чужий діалог 404, два admin мають власний unread, повторний POST не дублює.
- [ ] Додати chat UI, polling, offline draft/retry, unread і email. Перевірка: фокус/відновлення мережі, pending стан, email fail не губить повідомлення.
- [ ] Backup/restore, retention/deletion runbook, інтеграційні та E2E перевірки. Перевірка: пробна restore, integrity check, Next/backend checks зелені.
- [ ] **Фінальна контрольна точка:** два клієнти, два admin, офлайн retry, відновлення БД і всі ключові E2E сценарії пройдено.
