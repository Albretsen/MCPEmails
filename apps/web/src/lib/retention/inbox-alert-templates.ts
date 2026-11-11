/**
 * Copy for the broken-inbox alert (src/lib/retention/inbox-alert.ts).
 *
 * SERVICE, NOT MARKETING. It is about a mailbox the reader connected and that
 * stopped working: no offer, no price, no plan name, no upgrade link. Sent
 * from the transactional sender (BILLING_EMAIL_FROM, MCPEmails
 * hello@mcpemails.com) with replies to support@, and not suppressible by the
 * lifecycle opt-out, like the payment-failure notices.
 *
 * WHAT IT PRINTS. The inbox address (the reader's own mailbox, sent to the
 * workspace owner only), the provider's public name (or the mail host when we
 * do not know the provider), the date the sign-in broke, the dashboard link
 * and, when one exists, the provider's connect guide. Never an error string
 * from the provider and never a credential.
 *
 * LOCALES. en, nb, de, pt, ja, es, fr, zh, chosen from
 * workspaces.acquisition_locale with en as the fallback, the same set and the
 * same resolver as the activation help emails. Every locale except en needs a
 * native read before the first live send.
 *
 * STYLE. Plain and short. No em dashes, no urgency, no angle brackets in the
 * strings.
 */

import { helpLocale, type HelpLocale } from '@/lib/email/activation-help-templates';
import { POSTAL_ADDRESS_LINE } from '@/lib/email/legal';
import { guideUrl } from '@/lib/retention/inbox-alert';

export type AlertLocale = HelpLocale;
export const alertLocale = helpLocale;

interface Copy {
  subject1: (address: string) => string;
  subject2: (address: string) => string;
  hi: string;
  lead1: (address: string, provider: string, since: string) => string;
  lead2: (address: string, provider: string, since: string) => string;
  why: string;
  action: string;
  button: string;
  guide: (provider: string) => string;
  help: string;
  signoff: string;
}

const COPY: Record<AlertLocale, Copy> = {
  en: {
    subject1: (a) => `Your inbox ${a} needs to be reconnected`,
    subject2: (a) => `Reminder: ${a} is still disconnected`,
    hi: 'Hi,',
    lead1: (a, p, d) =>
      `MCPEmails can no longer sign in to ${a} (${p}). Since ${d} the sign-in has been refused, so your AI app cannot read, draft or send from this inbox.`,
    lead2: (a, p, d) =>
      `${a} (${p}) is still not connected to MCPEmails. Your AI app has not been able to use it since ${d}.`,
    why: 'This usually happens when the mailbox password was changed, an app password was revoked, or the sign-in token expired.',
    action: 'Reconnect it from your dashboard. It takes about a minute:',
    button: 'Reconnect the inbox',
    guide: (p) => `Step-by-step guide for ${p}:`,
    help: 'If reconnecting does not work, reply to this email and we will help.',
    signoff: 'MCPEmails',
  },
  nb: {
    subject1: (a) => `Innboksen ${a} må kobles til på nytt`,
    subject2: (a) => `Påminnelse: ${a} er fortsatt frakoblet`,
    hi: 'Hei,',
    lead1: (a, p, d) =>
      `MCPEmails får ikke lenger logget inn på ${a} (${p}). Siden ${d} har innloggingen blitt avvist, så AI-appen din kan ikke lese, skrive utkast eller sende fra denne innboksen.`,
    lead2: (a, p, d) =>
      `${a} (${p}) er fortsatt ikke koblet til MCPEmails. AI-appen din har ikke kunnet bruke den siden ${d}.`,
    why: 'Dette skjer vanligvis når passordet til e-postkontoen er endret, et app-passord er trukket tilbake eller innloggingen har utløpt.',
    action: 'Koble den til på nytt fra dashbordet. Det tar omtrent ett minutt:',
    button: 'Koble til innboksen på nytt',
    guide: (p) => `Steg-for-steg-veiledning for ${p}:`,
    help: 'Hvis det ikke fungerer, svar på denne e-posten, så hjelper vi deg.',
    signoff: 'MCPEmails',
  },
  de: {
    subject1: (a) => `Ihr Postfach ${a} muss neu verbunden werden`,
    subject2: (a) => `Erinnerung: ${a} ist weiterhin getrennt`,
    hi: 'Hallo,',
    lead1: (a, p, d) =>
      `MCPEmails kann sich nicht mehr bei ${a} (${p}) anmelden. Seit dem ${d} wird die Anmeldung abgelehnt, daher kann Ihre KI-App in diesem Postfach nichts lesen, entwerfen oder senden.`,
    lead2: (a, p, d) =>
      `${a} (${p}) ist weiterhin nicht mit MCPEmails verbunden. Ihre KI-App kann es seit dem ${d} nicht nutzen.`,
    why: 'Das passiert meist, wenn das Passwort des Postfachs geändert, ein App-Passwort widerrufen wurde oder die Anmeldung abgelaufen ist.',
    action: 'Verbinden Sie es im Dashboard neu. Das dauert etwa eine Minute:',
    button: 'Postfach neu verbinden',
    guide: (p) => `Schritt-für-Schritt-Anleitung für ${p}:`,
    help: 'Wenn das nicht klappt, antworten Sie auf diese E-Mail, und wir helfen Ihnen.',
    signoff: 'MCPEmails',
  },
  pt: {
    subject1: (a) => `Sua caixa de entrada ${a} precisa ser reconectada`,
    subject2: (a) => `Lembrete: ${a} continua desconectada`,
    hi: 'Olá,',
    lead1: (a, p, d) =>
      `O MCPEmails não consegue mais entrar em ${a} (${p}). Desde ${d} o login é recusado, então seu app de IA não consegue ler, criar rascunhos nem enviar por esta caixa de entrada.`,
    lead2: (a, p, d) =>
      `${a} (${p}) continua desconectada do MCPEmails. Seu app de IA não consegue usá-la desde ${d}.`,
    why: 'Isso costuma acontecer quando a senha da conta de e-mail foi alterada, uma senha de app foi revogada ou o login expirou.',
    action: 'Reconecte pelo painel. Leva cerca de um minuto:',
    button: 'Reconectar a caixa de entrada',
    guide: (p) => `Guia passo a passo para ${p}:`,
    help: 'Se não funcionar, responda a este e-mail e nós ajudamos.',
    signoff: 'MCPEmails',
  },
  ja: {
    subject1: (a) => `受信トレイ ${a} の再接続が必要です`,
    subject2: (a) => `リマインダー: ${a} はまだ切断されたままです`,
    hi: 'こんにちは。',
    lead1: (a, p, d) =>
      `MCPEmails は ${a} (${p}) にサインインできなくなりました。${d} 以降サインインが拒否されているため、AI アプリはこの受信トレイでメールの閲覧、下書き、送信ができません。`,
    lead2: (a, p, d) =>
      `${a} (${p}) はまだ MCPEmails に接続されていません。${d} 以降、AI アプリはこの受信トレイを使えていません。`,
    why: 'これは通常、メールアカウントのパスワードが変更された、アプリパスワードが取り消された、またはサインインの有効期限が切れた場合に起こります。',
    action: 'ダッシュボードから再接続してください。1 分ほどで終わります:',
    button: '受信トレイを再接続',
    guide: (p) => `${p} の手順ガイド:`,
    help: '再接続できない場合は、このメールに返信してください。サポートします。',
    signoff: 'MCPEmails',
  },
  es: {
    subject1: (a) => `Tu bandeja de entrada ${a} necesita volver a conectarse`,
    subject2: (a) => `Recordatorio: ${a} sigue desconectada`,
    hi: 'Hola,',
    lead1: (a, p, d) =>
      `MCPEmails ya no puede iniciar sesión en ${a} (${p}). Desde el ${d} se rechaza el inicio de sesión, así que tu app de IA no puede leer, redactar borradores ni enviar desde esta bandeja.`,
    lead2: (a, p, d) =>
      `${a} (${p}) sigue sin estar conectada a MCPEmails. Tu app de IA no ha podido usarla desde el ${d}.`,
    why: 'Suele pasar cuando se cambió la contraseña del buzón, se revocó una contraseña de aplicación o caducó el inicio de sesión.',
    action: 'Vuelve a conectarla desde el panel. Tarda alrededor de un minuto:',
    button: 'Volver a conectar la bandeja',
    guide: (p) => `Guía paso a paso para ${p}:`,
    help: 'Si no funciona, responde a este correo y te ayudamos.',
    signoff: 'MCPEmails',
  },
  fr: {
    subject1: (a) => `Votre boîte ${a} doit être reconnectée`,
    subject2: (a) => `Rappel : ${a} est toujours déconnectée`,
    hi: 'Bonjour,',
    lead1: (a, p, d) =>
      `MCPEmails ne parvient plus à se connecter à ${a} (${p}). Depuis le ${d}, la connexion est refusée : votre application d'IA ne peut plus lire, rédiger ni envoyer depuis cette boîte.`,
    lead2: (a, p, d) =>
      `${a} (${p}) n'est toujours pas connectée à MCPEmails. Votre application d'IA ne peut plus l'utiliser depuis le ${d}.`,
    why: "Cela arrive en général quand le mot de passe de la boîte a changé, qu'un mot de passe d'application a été révoqué ou que la connexion a expiré.",
    action: 'Reconnectez-la depuis votre tableau de bord. Cela prend environ une minute :',
    button: 'Reconnecter la boîte',
    guide: (p) => `Guide pas à pas pour ${p} :`,
    help: "Si la reconnexion ne fonctionne pas, répondez à cet e-mail et nous vous aiderons.",
    signoff: 'MCPEmails',
  },
  zh: {
    subject1: (a) => `您的收件箱 ${a} 需要重新连接`,
    subject2: (a) => `提醒：${a} 仍未连接`,
    hi: '您好，',
    lead1: (a, p, d) =>
      `MCPEmails 已无法登录 ${a}（${p}）。自 ${d} 起登录一直被拒绝，因此您的 AI 应用无法在此收件箱中读取、起草或发送邮件。`,
    lead2: (a, p, d) => `${a}（${p}）仍未连接到 MCPEmails。自 ${d} 起，您的 AI 应用一直无法使用它。`,
    why: '这通常是因为邮箱密码已更改、应用专用密码已被撤销，或登录凭证已过期。',
    action: '请在控制台中重新连接，大约需要一分钟：',
    button: '重新连接收件箱',
    guide: (p) => `${p} 分步指南：`,
    help: '如果重新连接不成功，请直接回复此邮件，我们会帮助您。',
    signoff: 'MCPEmails',
  },
};

/** Exported for the tests, which check every locale for banned wording. */
export function alertCopy(locale: AlertLocale): Copy {
  return COPY[locale];
}

const DATE_LOCALES: Record<AlertLocale, string> = {
  en: 'en-GB', nb: 'nb-NO', de: 'de-DE', pt: 'pt-BR', ja: 'ja-JP', es: 'es-ES', fr: 'fr-FR', zh: 'zh-CN',
};

/** The break date, day precision, in UTC (we do not know the reader's zone). */
export function formatAlertDate(iso: string, locale: AlertLocale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(DATE_LOCALES[locale], { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface ComposeInput {
  phase: 1 | 2;
  locale: string | null;
  inboxAddress: string;
  providerName: string;
  guideSlug: string | null;
  brokenSince: string;
  baseUrl: string;
}

export interface ComposedAlert {
  locale: AlertLocale;
  subject: string;
  text: string;
  html: string;
  reconnectUrl: string;
  guideUrl: string | null;
}

export function composeInboxAlert(input: ComposeInput): ComposedAlert {
  const locale = alertLocale(input.locale);
  const c = COPY[locale];
  const base = input.baseUrl.replace(/\/+$/, '');
  const reconnectUrl = `${base}/dashboard/inboxes`;
  const guide = guideUrl(input.guideSlug, locale, base);
  const since = formatAlertDate(input.brokenSince, locale);
  const subject = input.phase === 1 ? c.subject1(input.inboxAddress) : c.subject2(input.inboxAddress);
  const lead = input.phase === 1
    ? c.lead1(input.inboxAddress, input.providerName, since)
    : c.lead2(input.inboxAddress, input.providerName, since);

  const text = [
    c.hi,
    '',
    lead,
    '',
    c.why,
    '',
    c.action,
    reconnectUrl,
    ...(guide ? ['', c.guide(input.providerName), guide] : []),
    '',
    c.help,
    '',
    c.signoff,
    '',
    POSTAL_ADDRESS_LINE,
  ].join('\n');

  const p = (s: string) => `<p style="margin:0 0 14px">${escapeHtml(s)}</p>`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">
${p(c.hi)}
${p(lead)}
${p(c.why)}
${p(c.action)}
<p style="margin:0 0 14px"><a href="${escapeHtml(reconnectUrl)}" style="display:inline-block;background:#1f2328;color:#ffffff;text-decoration:none;padding:9px 16px;border-radius:6px">${escapeHtml(c.button)}</a></p>
${guide ? `<p style="margin:0 0 14px">${escapeHtml(c.guide(input.providerName))} <a href="${escapeHtml(guide)}">${escapeHtml(guide)}</a></p>` : ''}
${p(c.help)}
${p(c.signoff)}
<p style="margin:18px 0 0;font-size:11px;color:#8c959f">${escapeHtml(POSTAL_ADDRESS_LINE)}</p>
</div>`;

  return { locale, subject, text, html, reconnectUrl, guideUrl: guide };
}
