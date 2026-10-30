/**
 * The account-deletion confirmation, sent once, right after DELETE
 * /api/user/delete-account succeeds.
 *
 * WHY. A business customer has to be able to show their own auditors that an
 * erasure happened. This is the written record: what was removed at once, and
 * the date by which purge_deleted_accounts() (migration 20261030130000)
 * erases the rest.
 *
 * TRANSACTIONAL. Sent straight through Resend from the route, never through
 * system_events / system-notify, so MUTED_EVENT_TYPES cannot switch it off,
 * and no lifecycle suppression applies (the person asked for this action).
 * createResend() keeps it inside EMAIL_RECIPIENT_ALLOWLIST off production.
 *
 * LOCALES. en, nb, de, es, fr, zh, the set the activation help emails use.
 * The dashboard sends its interface locale with the request; otherwise the
 * landing-page locale of the user's workspace is used, then en. German uses
 * formal Sie, French vous, Spanish tu, as the rest of the site does. Every
 * locale except en needs a native read.
 *
 * ENV.
 *   RESEND_API_KEY        required; without it nothing is sent (logged).
 *   ACCOUNT_EMAIL_FROM    optional sender. Default: the support sender, so a
 *                         reply reaches support.
 *
 * STYLE. Plain, short. No em dashes, no angle brackets in copy.
 */
import { createResend } from '@/lib/email/resend';
import { SUPPORT_FROM, SUPPORT_INBOX } from '@/lib/support/emails';

export const ACCOUNT_DELETED_LOCALES = ['en', 'nb', 'de', 'es', 'fr', 'zh'] as const;
export type AccountDeletedLocale = (typeof ACCOUNT_DELETED_LOCALES)[number];

/** Days after deletion by which the remaining records are erased. */
export const PURGE_AFTER_DAYS = 30;

/** Any stored locale (or junk, or `fr-CA`) to one with copy. */
export function accountDeletedLocale(value: unknown): AccountDeletedLocale | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  if (base === 'no' || base === 'nn') return 'nb';
  return (ACCOUNT_DELETED_LOCALES as readonly string[]).includes(base) ? (base as AccountDeletedLocale) : null;
}

const DATE_LOCALE: Record<AccountDeletedLocale, string> = {
  en: 'en-GB',
  nb: 'nb-NO',
  de: 'de-DE',
  es: 'es-ES',
  fr: 'fr-FR',
  zh: 'zh-CN',
};

interface Copy {
  subject: string;
  greeting: string;
  deleted: (email: string, date: string) => string;
  immediate: string;
  rest: (date: string) => string;
  payments: string;
  notYou: (support: string) => string;
  signoff: string;
}

const COPY: Record<AccountDeletedLocale, Copy> = {
  en: {
    subject: 'Your MCPEmails account is deleted',
    greeting: 'Hi,',
    deleted: (email, date) => `Your MCPEmails account (${email}) was deleted on ${date}.`,
    immediate:
      'We have already deleted the stored passwords and tokens of your connected inboxes, revoked your API keys and AI app connections, cancelled queued scheduled emails, cancelled any subscription, and asked Google to end our access to your Gmail inboxes.',
    rest: (date) =>
      `The rest of your account data, including workspace and inbox settings, the activity log and your send history, will be erased by ${date}. After that it cannot be restored.`,
    payments: 'Invoices and payment records are kept by our payment processor, Stripe, as accounting law requires.',
    notYou: (support) => `If you did not ask for this, reply to this email or write to ${support}.`,
    signoff: 'MCPEmails',
  },
  nb: {
    subject: 'MCPEmails-kontoen din er slettet',
    greeting: 'Hei,',
    deleted: (email, date) => `MCPEmails-kontoen din (${email}) ble slettet ${date}.`,
    immediate:
      'Vi har allerede slettet de lagrede passordene og tokenene for innboksene dine, trukket tilbake API-nøklene og tilkoblingene til AI-apper, kansellert planlagte e-poster som ventet, avsluttet eventuelle abonnementer og bedt Google om å fjerne tilgangen vår til Gmail-innboksene dine.',
    rest: (date) =>
      `Resten av kontodataene dine, blant annet innstillinger for arbeidsområder og innbokser, aktivitetsloggen og sendehistorikken, blir slettet innen ${date}. Etter det kan de ikke gjenopprettes.`,
    payments: 'Fakturaer og betalingsopplysninger oppbevares av betalingsleverandøren vår, Stripe, slik regnskapsreglene krever.',
    notYou: (support) => `Hvis det ikke var du som ba om dette, svar på denne e-posten eller skriv til ${support}.`,
    signoff: 'MCPEmails',
  },
  de: {
    subject: 'Ihr MCPEmails-Konto wurde gelöscht',
    greeting: 'Hallo,',
    deleted: (email, date) => `Ihr MCPEmails-Konto (${email}) wurde am ${date} gelöscht.`,
    immediate:
      'Wir haben bereits die gespeicherten Passwörter und Tokens Ihrer verbundenen Postfächer gelöscht, Ihre API-Schlüssel und Verbindungen zu KI-Apps widerrufen, wartende geplante E-Mails storniert, ein bestehendes Abonnement gekündigt und Google gebeten, unseren Zugriff auf Ihre Gmail-Postfächer zu beenden.',
    rest: (date) =>
      `Die übrigen Kontodaten, darunter Workspace- und Postfacheinstellungen, das Aktivitätsprotokoll und Ihr Versandverlauf, werden bis zum ${date} gelöscht. Danach lassen sie sich nicht wiederherstellen.`,
    payments: 'Rechnungen und Zahlungsbelege bewahrt unser Zahlungsdienstleister Stripe auf, wie es das Buchhaltungsrecht verlangt.',
    notYou: (support) => `Falls Sie das nicht veranlasst haben, antworten Sie auf diese E-Mail oder schreiben Sie an ${support}.`,
    signoff: 'MCPEmails',
  },
  es: {
    subject: 'Tu cuenta de MCPEmails se ha eliminado',
    greeting: 'Hola:',
    deleted: (email, date) => `Tu cuenta de MCPEmails (${email}) se eliminó el ${date}.`,
    immediate:
      'Ya hemos borrado las contraseñas y los tokens guardados de tus bandejas conectadas, revocado tus claves de API y las conexiones con apps de IA, cancelado los correos programados pendientes, cancelado cualquier suscripción y pedido a Google que retire nuestro acceso a tus bandejas de Gmail.',
    rest: (date) =>
      `El resto de los datos de tu cuenta, como los ajustes de espacios de trabajo y bandejas, el registro de actividad y tu historial de envíos, se borrará antes del ${date}. Después no se podrá recuperar.`,
    payments: 'Las facturas y los registros de pago los conserva nuestro procesador de pagos, Stripe, como exige la normativa contable.',
    notYou: (support) => `Si no lo has pedido tú, responde a este correo o escribe a ${support}.`,
    signoff: 'MCPEmails',
  },
  fr: {
    subject: 'Votre compte MCPEmails est supprimé',
    greeting: 'Bonjour,',
    deleted: (email, date) => `Votre compte MCPEmails (${email}) a été supprimé le ${date}.`,
    immediate:
      'Nous avons déjà supprimé les mots de passe et jetons enregistrés de vos boîtes connectées, révoqué vos clés API et les connexions aux apps d’IA, annulé les e-mails programmés en attente, résilié tout abonnement et demandé à Google de retirer notre accès à vos boîtes Gmail.',
    rest: (date) =>
      `Le reste des données de votre compte, dont les réglages des espaces de travail et des boîtes, le journal d’activité et votre historique d’envoi, sera effacé d’ici le ${date}. Il ne pourra plus être restauré ensuite.`,
    payments: 'Les factures et les justificatifs de paiement sont conservés par notre prestataire de paiement, Stripe, comme l’exige le droit comptable.',
    notYou: (support) => `Si vous n’êtes pas à l’origine de cette demande, répondez à cet e-mail ou écrivez à ${support}.`,
    signoff: 'MCPEmails',
  },
  zh: {
    subject: '你的 MCPEmails 账户已删除',
    greeting: '你好，',
    deleted: (email, date) => `你的 MCPEmails 账户（${email}）已于 ${date} 删除。`,
    immediate:
      '我们已删除你所连接收件箱的已存储密码和令牌，撤销了你的 API 密钥和 AI 应用连接，取消了排队中的定时邮件和任何订阅，并已请求 Google 终止我们对你 Gmail 收件箱的访问。',
    rest: (date) => `其余账户数据，包括工作区和收件箱设置、活动日志以及发送记录，将在 ${date} 之前清除，之后无法恢复。`,
    payments: '发票和付款记录由我们的支付服务商 Stripe 按会计法规要求保存。',
    notYou: (support) => `如果这不是你本人的操作，请回复此邮件或写信至 ${support}。`,
    signoff: 'MCPEmails',
  },
};

/** Exported for the tests, which check every locale. */
export function accountDeletedCopy(locale: AccountDeletedLocale): Copy {
  return COPY[locale];
}

function formatDate(at: Date, locale: AccountDeletedLocale): string {
  return at.toLocaleDateString(DATE_LOCALE[locale], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Oslo',
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export interface AccountDeletedEmail {
  subject: string;
  text: string;
  html: string;
}

export function buildAccountDeletedEmail(params: {
  email: string;
  deletedAt: Date;
  locale: AccountDeletedLocale;
  support?: string;
}): AccountDeletedEmail {
  const c = COPY[params.locale];
  const support = params.support ?? SUPPORT_INBOX;
  const purgeBy = new Date(params.deletedAt.getTime() + PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const paragraphs = [
    c.deleted(params.email, formatDate(params.deletedAt, params.locale)),
    c.immediate,
    c.rest(formatDate(purgeBy, params.locale)),
    c.payments,
    c.notYou(support),
  ];
  const text = [c.greeting, '', ...paragraphs.flatMap((p) => [p, '']), c.signoff].join('\n');
  const html = `<!DOCTYPE html>
<html lang="${params.locale}">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:32px 16px;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">${escapeHtml(c.greeting)}</p>
${paragraphs.map((p) => `    <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">${escapeHtml(p)}</p>`).join('\n')}
    <p style="margin:0;font-size:15px;line-height:1.5;">${escapeHtml(c.signoff)}</p>
  </div>
</body>
</html>`;
  return { subject: c.subject, text, html };
}

/** Sends the confirmation. Never throws: a failure is logged, the deletion stands. */
export async function sendAccountDeletedEmail(params: {
  to: string;
  deletedAt: Date;
  locale: AccountDeletedLocale;
}): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('[account-deleted-email] RESEND_API_KEY is not set; confirmation not sent');
    return;
  }
  try {
    const email = buildAccountDeletedEmail({ email: params.to, deletedAt: params.deletedAt, locale: params.locale });
    const { error } = await createResend(key).emails.send({
      from: process.env.ACCOUNT_EMAIL_FROM || SUPPORT_FROM,
      to: params.to,
      replyTo: SUPPORT_INBOX,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    if (error) console.error('[account-deleted-email] Resend refused the confirmation:', error.message);
  } catch (err) {
    console.error('[account-deleted-email] send failed:', (err as Error).message);
  }
}
