/**
 * Транзакційні листи SELTIVO.
 *
 * Верстка навмисно table-based з inline-стилями: Gmail, Outlook і Apple Mail
 * вирізають частину CSS, flex/grid і сучасні селектори. Кожен лист має
 * text-версію — вона лишається єдиним джерелом коду для логів і тестів.
 */

export type EmailLocale = 'uk' | 'en';
export type EmailKind = 'verification' | 'reset-password' | 'chat-message';

export type EmailParams = {
  origin?: string;
  code?: string;
  url?: string;
  requestId?: string;
  customerReply?: boolean;
};

export type RenderedEmail = { subject: string; text: string; html: string };

const ASSET_ORIGIN = 'https://seltivostudio.com';
const INK = '#111111';
const MUTED = '#6B6B6B';
const SOFT = '#F4F4F4';
const LINE = '#E9E9E9';
const FONT = 'Arial, Helvetica, sans-serif';

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char] ?? char));

const safeUrl = (value: string): string => escapeHtml(value.replace(/["'\s]/g, ''));

const formatCode = (code: string): string => escapeHtml(code).replace(/(\d{3})(?=\d)/g, '$1&nbsp;');

/** UUID у листі замінюємо на короткий читаємий номер; повний ID лишається тільки в посиланні. */
const shortId = (value: string): string => escapeHtml((value.split('-')[0] ?? '').toUpperCase());

const localeOf = (value?: string | null): EmailLocale => value === 'en' ? 'en' : 'uk';

type Copy = {
  subject: string;
  preheader: string;
  title: string;
  subtitle: string;
  note: string;
  ignore: string;
  cta: string;
  fallback: string;
};

const COPY: Record<EmailKind, Record<EmailLocale, Copy>> = {
  verification: {
    uk: {
      subject: 'Код підтвердження SELTIVO',
      preheader: 'Ваш код підтвердження для SELTIVO',
      title: 'Підтвердіть пошту',
      subtitle: 'Введіть цей код, щоб завершити підтвердження акаунта',
      note: 'Код дійсний 10 хвилин.',
      ignore: 'Якщо ви не створювали акаунт, просто проігноруйте цей лист.',
      cta: 'Відкрити SELTIVO',
      fallback: 'Не працює посилання? Скопіюйте код вище.',
    },
    en: {
      subject: 'SELTIVO verification code',
      preheader: 'Your SELTIVO verification code',
      title: 'Verify your email',
      subtitle: 'Enter this code to finish verifying your account',
      note: 'The code is valid for 10 minutes.',
      ignore: 'If you didn’t create an account, just ignore this email.',
      cta: 'Open SELTIVO',
      fallback: 'Link not working? Copy the code above.',
    },
  },
  'reset-password': {
    uk: {
      subject: 'Відновлення пароля SELTIVO',
      preheader: 'Посилання для скидання пароля SELTIVO',
      title: 'Скидання пароля',
      subtitle: 'Ми отримали запит на відновлення пароля вашого акаунта',
      note: 'Посилання дійсне 30 хвилин. Після переходу задайте новий пароль.',
      ignore: 'Якщо запит не ваш, просто проігноруйте цей лист — пароль не зміниться.',
      cta: 'Скинути пароль',
      fallback: 'Не працює кнопка? Скопіюйте посилання в браузер:',
    },
    en: {
      subject: 'SELTIVO password reset',
      preheader: 'Reset your SELTIVO password',
      title: 'Reset your password',
      subtitle: 'We received a request to reset your account password',
      note: 'The link is valid for 30 minutes. Choose a new password after opening it.',
      ignore: 'If you didn’t request this, ignore this email — your password stays unchanged.',
      cta: 'Reset password',
      fallback: 'Button not working? Paste this link into your browser:',
    },
  },
  'chat-message': {
    uk: {
      subject: 'Нове повідомлення SELTIVO',
      preheader: 'У вашій заявці нове повідомлення',
      title: 'Нове повідомлення',
      subtitle: 'У листуванні зі студією з’явилася нова відповідь',
      note: 'Відкрийте кабінет, щоб прочитати повідомлення й відповісти.',
      ignore: 'Цей лист надіслано автоматично — не відповідайте на нього.',
      cta: 'Відкрити листування',
      fallback: 'Не працює кнопка? Скопіюйте посилання в браузер:',
    },
    en: {
      subject: 'New SELTIVO message',
      preheader: 'You have a new message in your request',
      title: 'New message',
      subtitle: 'There’s a new reply in your conversation with the studio',
      note: 'Open your dashboard to read the message and reply.',
      ignore: 'This email was sent automatically — please don’t reply to it.',
      cta: 'Open conversation',
      fallback: 'Button not working? Paste this link into your browser:',
    },
  },
};

/** Заголовок, маскот і підвал — спільні для всіх листів. */
function layout(locale: EmailLocale, copy: Copy, content: string, origin: string): string {
  const year = new Date().getFullYear();
  const lang = locale === 'uk' ? 'uk' : 'en';
  const siteLabel = lang === 'uk' ? 'Сайт SELTIVO' : 'SELTIVO website';
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(copy.subject)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
  html,body{margin:0;padding:0;width:100%;}
  body{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  table{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;}
  img{border:0;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}
  a{text-decoration:none;}
  @media only screen and (max-width:620px){
    .wrap{padding:12px 10px !important;}
    .card{border-radius:16px !important;}
    .h1{font-size:27px !important;line-height:1.15 !important;}
    .sub{font-size:15px !important;}
    .code{font-size:32px !important;letter-spacing:4px !important;}
    .logo{width:128px !important;}
    .mascot{width:104px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#F5F5F5;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#F5F5F5;">${escapeHtml(copy.preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F5F5;">
<tr><td class="wrap" align="center" style="padding:32px 16px;">
  <table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#FFFFFF;border:1px solid ${LINE};border-radius:24px;border-collapse:separate;border-spacing:0;">
    <tr><td align="center" style="padding:38px 24px 0;">
      <img class="logo" src="${ASSET_ORIGIN}/logo-text-only.webp" width="152" alt="SELTIVO" style="display:block;width:152px;height:auto;border:0;">
    </td></tr>
    <tr><td align="center" style="padding:14px 0 0;">
      <img class="mascot" src="${ASSET_ORIGIN}/selti.webp" width="126" alt="" style="display:block;width:126px;height:auto;border:0;">
    </td></tr>
    ${content}
    <tr><td align="center" style="padding:26px 32px 32px;border-top:1px solid ${LINE};font-family:${FONT};font-size:12px;line-height:1.7;color:#9A9A9A;">
      © SELTIVO ${year}<br>
      ${escapeHtml(copy.ignore)}<br>
      <a href="${safeUrl(origin)}" style="color:${MUTED};text-decoration:underline;">${siteLabel}</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

function heading(copy: Copy): string {
  return `<tr><td class="h1" align="center" style="padding:18px 32px 0;font-family:${FONT};font-size:32px;line-height:1.1;font-weight:800;letter-spacing:-1px;color:${INK};">${escapeHtml(copy.title)}</td></tr>
<tr><td class="sub" align="center" style="padding:12px 40px 0;font-family:${FONT};font-size:16px;line-height:1.5;color:${MUTED};">${escapeHtml(copy.subtitle)}</td></tr>`;
}

function button(url: string, label: string): string {
  return `<tr><td align="center" style="padding:28px 32px 0;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:separate;border-spacing:0;">
  <tr><td align="center" bgcolor="${INK}" style="border-radius:12px;background:${INK};">
    <a href="${safeUrl(url)}" style="display:inline-block;padding:15px 30px;font-family:${FONT};font-size:15px;line-height:1.2;font-weight:700;color:#FFFFFF;border-radius:12px;">${escapeHtml(label)}</a>
  </td></tr>
  </table>
</td></tr>`;
}

function fallback(url: string, copy: Copy): string {
  return `<tr><td align="center" style="padding:18px 40px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:#9A9A9A;">
  ${escapeHtml(copy.fallback)}<br>
  <a href="${safeUrl(url)}" style="color:${MUTED};text-decoration:underline;word-break:break-all;">${escapeHtml(url)}</a>
</td></tr>`;
}

function verificationContent(code: string, copy: Copy, origin: string): string {
  return `${heading(copy)}
<tr><td align="center" style="padding:28px 24px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:20px;border-collapse:separate;border-spacing:0;">
  <tr><td align="center" style="padding:22px 20px 24px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
    <tr>
      <td style="width:46px;border-top:2px solid #D9D9D9;font-size:0;line-height:0;">&nbsp;</td>
      <td align="center" style="padding:0 12px;font-family:${FONT};font-size:22px;line-height:1;color:${INK};">&#9993;</td>
      <td style="width:46px;border-top:2px solid #D9D9D9;font-size:0;line-height:0;">&nbsp;</td>
    </tr>
    </table>
    <div class="code" style="margin-top:16px;background:${SOFT};border-radius:14px;padding:18px 8px;font-family:${FONT};font-size:40px;line-height:1.1;font-weight:800;letter-spacing:6px;color:${INK};font-variant-numeric:tabular-nums;">${formatCode(code)}</div>
  </td></tr>
  </table>
</td></tr>
<tr><td align="center" style="padding:14px 40px 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED};">${escapeHtml(copy.note)}</td></tr>
${button(`${origin}/verify-email`, copy.cta)}`;
}

function linkContent(url: string, copy: Copy, extra?: string): string {
  return `${heading(copy)}
${extra ?? ''}
<tr><td align="center" style="padding:16px 40px 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED};">${escapeHtml(copy.note)}</td></tr>
${button(url, copy.cta)}
${fallback(url, copy)}`;
}

/** Рендерить готовий лист (subject + text + html) для подальшої передачі в SMTP/Brevo. */
export function renderEmail(kind: EmailKind, params: EmailParams = {}, locale?: string | null): RenderedEmail {
  const lang = localeOf(locale);
  const copy = kind === 'chat-message' && params.customerReply
    ? {
        ...COPY[kind][lang],
        subject: lang === 'uk' ? 'Нова відповідь SELTIVO' : 'New SELTIVO reply',
        title: lang === 'uk' ? 'Нова відповідь' : 'New reply',
        subtitle: lang === 'uk' ? 'Менеджер студії відповів у вашій заявці' : 'A studio manager replied to your request',
      }
    : COPY[kind][lang];
  const origin = (params.origin || ASSET_ORIGIN).replace(/\/$/, '');
  const code = (params.code ?? '').replace(/\D/g, '').slice(0, 6);

  if (kind === 'verification') {
    const text = lang === 'uk'
      ? `Ваш код підтвердження SELTIVO: ${code}\n\n${copy.note} ${copy.ignore}`
      : `Your SELTIVO verification code: ${code}\n\n${copy.note} ${copy.ignore}`;
    return { subject: copy.subject, text, html: layout(lang, copy, verificationContent(code, copy, origin), origin) };
  }

  const url = params.url || `${origin}/`;
  if (kind === 'reset-password') {
    // Посилання останнім рядком: клієнтські тести й логи дістають його split(': ').pop().
    const text = lang === 'uk'
      ? `Відновлення пароля SELTIVO\n${copy.note} ${copy.ignore}\nПосилання: ${url}`
      : `SELTIVO password reset\n${copy.note} ${copy.ignore}\nLink: ${url}`;
    return { subject: copy.subject, text, html: layout(lang, copy, linkContent(url, copy), origin) };
  }

  const requestId = params.requestId ? shortId(params.requestId) : '';
  const extra = requestId
    ? `<tr><td align="center" style="padding:18px 32px 0;font-family:${FONT};font-size:14px;line-height:1.5;color:${MUTED};">${lang === 'uk' ? 'Заявка' : 'Request'} № ${requestId}</td></tr>`
    : undefined;
  const text = `${lang === 'uk' ? 'Нове повідомлення SELTIVO' : 'New SELTIVO message'}${requestId ? `: ${requestId}` : ''}\n${url}\n\n${copy.note}`;
  return { subject: copy.subject, text, html: layout(lang, copy, linkContent(url, copy, extra), origin) };
}
