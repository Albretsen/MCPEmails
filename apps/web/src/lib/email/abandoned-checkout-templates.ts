/**
 * Copy for the one abandoned-checkout reminder, in every app locale.
 *
 * LIFECYCLE, NOT TRANSACTIONAL. A reminder about a purchase the reader did not
 * make is direct marketing (markedsføringsloven § 15, ePrivacy art. 13), so it
 * goes only to people who ticked the signup opt-in, it is suppressible under
 * the 'lifecycle' category, and it carries a one-click List-Unsubscribe header,
 * a visible opt-out link built from the reader's own token, and the legal
 * entity and postal line. Composition returns null without a token.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. No discount, no countdown, no "your cart
 * is about to expire", no price. The price is left out because it differs by
 * cohort (the Personal reprice) and by currency (Adaptive Pricing), and the
 * checkout page the link opens shows the right one. The 14-day refund sentence
 * matches the pricing FAQ in each language.
 *
 * LOCALES. en, nb, es, fr, de. zh is frozen (src/i18n/locale-policy.mjs) and
 * renders English, as a missing zh message key would. German uses formal Sie,
 * like the German checkout text.
 *
 * STYLE. Plain, short, first person from Asgeir, matching the paywall
 * follow-up. No em dashes, no fake "Re:", no urgency.
 */

import { PLANS } from '@/lib/stripe/plans';
import { unsubscribeUrl } from '@/lib/email/lifecycle';
import { POSTAL_ADDRESS_LINE } from '@/lib/email/legal';

export const ABANDONED_CHECKOUT_CATEGORY = 'lifecycle' as const;

export const REMINDER_LOCALES = ['en', 'nb', 'es', 'fr', 'de'] as const;
export type ReminderLocale = (typeof REMINDER_LOCALES)[number];

/** Any app locale (or junk) to a locale this email has copy for. */
export function reminderLocale(value: unknown): ReminderLocale {
  return typeof value === 'string' && (REMINDER_LOCALES as readonly string[]).includes(value)
    ? (value as ReminderLocale)
    : 'en';
}

export type ReminderPlanId = 'personal' | 'solo' | 'pro';
export type ReminderInterval = 'month' | 'year';

interface Copy {
  lang: string;
  greeting: string;
  subject: (plan: string) => string;
  title: (plan: string) => string;
  intro: (plan: string, interval: ReminderInterval) => string;
  help: string;
  refund: string;
  cta: string;
  footerNote: string;
  unsubscribeReason: string;
  unsubscribeLink: string;
  notAffected: string;
  textUnsubscribe: string;
}

const COPY: Record<ReminderLocale, Copy> = {
  en: {
    lang: 'en',
    greeting: 'Hi,',
    subject: (plan) => `Your MCPEmails ${plan} checkout`,
    title: (plan) => `Your ${plan} checkout`,
    intro: (plan, interval) =>
      `You started checking out MCPEmails ${plan}, billed ${interval === 'year' ? 'yearly' : 'monthly'}, and did not finish. If you still want it, the button below opens a new checkout for the same plan.`,
    help: 'If something got in the way, such as a question about the plan or a payment that did not go through, reply and tell me. I read every reply.',
    refund: 'If the first charge is not what you expected, contact us within 14 days and we refund it in full.',
    cta: 'Continue to checkout',
    footerNote: 'Replies come straight to me, not a ticket queue.',
    unsubscribeReason: 'You are getting this because you asked for product tips and offers when you signed up.',
    unsubscribeLink: 'Unsubscribe from these',
    notAffected: 'Billing and account notices are not affected.',
    textUnsubscribe: 'Unsubscribe',
  },
  nb: {
    lang: 'nb',
    greeting: 'Hei,',
    subject: (plan) => `Bestillingen din av MCPEmails ${plan}`,
    title: (plan) => `Bestillingen din av ${plan}`,
    intro: (plan, interval) =>
      `Du begynte å bestille MCPEmails ${plan} med ${interval === 'year' ? 'årlig' : 'månedlig'} betaling, men fullførte ikke. Hvis du fortsatt vil ha det, åpner knappen nedenfor en ny bestilling av samme plan.`,
    help: 'Hvis noe kom i veien, for eksempel et spørsmål om planen eller en betaling som ikke gikk gjennom, kan du svare på denne e-posten og fortelle meg det. Jeg leser alle svar.',
    refund: 'Hvis den første belastningen ikke er som du forventet, kontakt oss innen 14 dager, så refunderer vi den i sin helhet.',
    cta: 'Fortsett til betaling',
    footerNote: 'Svar kommer rett til meg, ikke til en sakskø.',
    unsubscribeReason: 'Du får denne fordi du ba om produkttips og tilbud da du registrerte deg.',
    unsubscribeLink: 'Meld deg av disse',
    notAffected: 'Fakturerings- og kontovarsler påvirkes ikke.',
    textUnsubscribe: 'Meld deg av',
  },
  es: {
    lang: 'es',
    greeting: 'Hola:',
    subject: (plan) => `Tu compra de MCPEmails ${plan}`,
    title: (plan) => `Tu compra de ${plan}`,
    intro: (plan, interval) =>
      `Empezaste a contratar MCPEmails ${plan} con facturación ${interval === 'year' ? 'anual' : 'mensual'}, pero no terminaste. Si todavía lo quieres, el botón de abajo abre un nuevo pago para el mismo plan.`,
    help: 'Si algo te lo impidió, como una duda sobre el plan o un pago que no se completó, responde a este correo y cuéntamelo. Leo todas las respuestas.',
    refund: 'Si el primer cargo no es lo que esperabas, escríbenos en un plazo de 14 días y te lo reembolsamos íntegramente.',
    cta: 'Continuar con el pago',
    footerNote: 'Las respuestas me llegan directamente a mí, no a una cola de tickets.',
    unsubscribeReason: 'Recibes este correo porque pediste consejos y ofertas del producto al registrarte.',
    unsubscribeLink: 'Darte de baja de estos correos',
    notAffected: 'Los avisos de facturación y de la cuenta no se ven afectados.',
    textUnsubscribe: 'Darte de baja',
  },
  fr: {
    lang: 'fr',
    greeting: 'Bonjour,',
    subject: (plan) => `Votre commande MCPEmails ${plan}`,
    title: (plan) => `Votre commande ${plan}`,
    intro: (plan, interval) =>
      `Vous avez commencé à souscrire à MCPEmails ${plan}, avec une facturation ${interval === 'year' ? 'annuelle' : 'mensuelle'}, sans aller jusqu'au bout. Si vous le souhaitez toujours, le bouton ci-dessous ouvre un nouveau paiement pour la même offre.`,
    help: "Si quelque chose vous a arrêté, par exemple une question sur l'offre ou un paiement qui n'est pas passé, répondez à cet e-mail pour me le dire. Je lis toutes les réponses.",
    refund: 'Si le premier prélèvement ne correspond pas à ce que vous attendiez, contactez-nous dans les 14 jours et nous le remboursons intégralement.',
    cta: 'Reprendre le paiement',
    footerNote: "Les réponses m'arrivent directement, pas dans une file de tickets.",
    unsubscribeReason: 'Vous recevez cet e-mail parce que vous avez demandé des conseils et des offres lors de votre inscription.',
    unsubscribeLink: 'Se désabonner de ces e-mails',
    notAffected: 'Les avis de facturation et de compte ne sont pas concernés.',
    textUnsubscribe: 'Se désabonner',
  },
  de: {
    lang: 'de',
    greeting: 'Hallo,',
    subject: (plan) => `Ihre Bestellung von MCPEmails ${plan}`,
    title: (plan) => `Ihre Bestellung von ${plan}`,
    intro: (plan, interval) =>
      `Sie haben begonnen, MCPEmails ${plan} mit ${interval === 'year' ? 'jährlicher' : 'monatlicher'} Abrechnung zu abonnieren, den Kauf aber nicht abgeschlossen. Falls Sie es weiterhin möchten, öffnet die Schaltfläche unten einen neuen Bezahlvorgang für denselben Tarif.`,
    help: 'Falls etwas dazwischengekommen ist, etwa eine Frage zum Tarif oder eine Zahlung, die nicht funktioniert hat, antworten Sie einfach auf diese E-Mail. Ich lese jede Antwort.',
    refund: 'Wenn die erste Abbuchung nicht Ihren Erwartungen entspricht, melden Sie sich innerhalb von 14 Tagen, und wir erstatten sie vollständig.',
    cta: 'Zum Bezahlvorgang',
    footerNote: 'Antworten landen direkt bei mir, nicht in einem Ticketsystem.',
    unsubscribeReason: 'Sie erhalten diese E-Mail, weil Sie bei der Registrierung Produkttipps und Angebote angefordert haben.',
    unsubscribeLink: 'Von diesen E-Mails abmelden',
    notAffected: 'Rechnungs- und Kontohinweise sind davon nicht betroffen.',
    textUnsubscribe: 'Abmelden',
  },
};

/** Exported for the tests, which check every locale for banned wording. */
export function reminderCopy(locale: ReminderLocale): Copy {
  return COPY[locale];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function p(text: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">${escapeHtml(text)}</p>`;
}

/** Same markup and colours as the shell in paywall-followup-templates.ts. */
function shell(o: {
  lang: string;
  title: string;
  html: string;
  ctaUrl: string;
  ctaLabel: string;
  footerNote: string;
  unsubscribeUrl: string;
  unsubscribeReason: string;
  unsubscribeLink: string;
  notAffected: string;
}): string {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(o.lang)}">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escapeHtml(o.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
          <tr>
            <td style="background:#0f172a;padding:28px 40px;">
              <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">MCPEmails</span>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px 8px;">
              <p style="margin:0 0 18px;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">
                ${escapeHtml(o.title)}
              </p>
              ${o.html}
              <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr>
                  <td style="background:#0f172a;border-radius:8px;">
                    <a href="${escapeHtml(o.ctaUrl)}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">
                      ${escapeHtml(o.ctaLabel)}
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">${escapeHtml(o.footerNote)}</p>
              <p style="margin:12px 0 0;font-size:12px;color:#94a3b8;line-height:1.6;">
                ${escapeHtml(o.unsubscribeReason)}
                <a href="${escapeHtml(o.unsubscribeUrl)}" style="color:#94a3b8;text-decoration:underline;">${escapeHtml(o.unsubscribeLink)}</a>.
                ${escapeHtml(o.notAffected)}
              </p>
              <p style="margin:14px 0 0;font-size:11px;color:#94a3b8;line-height:1.6;">${escapeHtml(POSTAL_ADDRESS_LINE)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export interface AbandonedCheckoutInput {
  planId: ReminderPlanId;
  interval: ReminderInterval;
  locale: ReminderLocale;
  /** Where the button goes: a fresh checkout for the same plan and interval. */
  resumeUrl: string;
  /** The recipient's own users.unsubscribe_token. Required; null = no email. */
  unsubscribeToken: string | null | undefined;
}

export interface ComposedAbandonedCheckout {
  subject: string;
  text: string;
  html: string;
  unsubscribeUrl: string;
  headers: Record<string, string>;
}

export function composeAbandonedCheckout(input: AbandonedCheckoutInput): ComposedAbandonedCheckout | null {
  const token = typeof input.unsubscribeToken === 'string' ? input.unsubscribeToken.trim() : '';
  if (!token) return null;
  const plan = PLANS[input.planId];
  if (!plan) return null;

  const c = COPY[input.locale] ?? COPY.en;
  const unsub = unsubscribeUrl(token, ABANDONED_CHECKOUT_CATEGORY);
  const paragraphs = [c.intro(plan.name, input.interval), c.help, c.refund];

  const text = [
    c.greeting,
    '',
    ...paragraphs.flatMap((para) => [para, '']),
    `${c.cta}: ${input.resumeUrl}`,
    '',
    'Asgeir',
    'MCPEmails',
    '',
    `${c.unsubscribeReason} ${c.textUnsubscribe}: ${unsub}`,
    c.notAffected,
    '',
    POSTAL_ADDRESS_LINE,
  ].join('\n');

  const html = shell({
    lang: c.lang,
    title: c.title(plan.name),
    html: p(c.greeting) + paragraphs.map((para) => p(para)).join('') + p('Asgeir'),
    ctaUrl: input.resumeUrl,
    ctaLabel: c.cta,
    footerNote: c.footerNote,
    unsubscribeUrl: unsub,
    unsubscribeReason: c.unsubscribeReason,
    unsubscribeLink: c.unsubscribeLink,
    notAffected: c.notAffected,
  });

  return {
    subject: c.subject(plan.name),
    text,
    html,
    unsubscribeUrl: unsub,
    headers: {
      'List-Unsubscribe': `<${unsub}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
