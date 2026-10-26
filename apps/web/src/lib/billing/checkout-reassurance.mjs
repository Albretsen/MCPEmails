/**
 * The reassurance line shown next to every button that starts a payment, and
 * at the top of the message above Stripe Checkout's own button.
 *
 * ONE PLACE FOR THE WORDING. The pricing cards, the home page pricing section,
 * the dashboard upgrade surfaces (CheckoutReassurance.jsx) and the hosted
 * Stripe page (checkout-core.ts) all read it from here, in every locale. It
 * lives in a module rather than in `messages/` because it is used by both the
 * marketing pages and the dashboard, and by server code that has no next-intl.
 *
 * EVERY FACT IS CHECKED AGAINST THE CODE AND THE TERMS:
 * - "Charged today": a new subscription's Checkout charges the first period at
 *   once. There is no trial anywhere. The one exception is a pass holder
 *   buying Personal, whose subscription is anchored to the pass end with
 *   `proration_behavior: 'none'` (lib/billing/pass.ts passSubscriptionStart):
 *   nothing is charged today, so that buyer gets the `deferred` line.
 * - "Cancel any time": self-serve from the dashboard billing card, or without
 *   signing in at /cancel (terms 5.4 and 9.3).
 * - "14-day refund": terms 5.4 (first charge of a new subscription) and 5.8
 *   (the 3-month pass). Never 30 days.
 *
 * NOT FOR an existing subscriber's in-place plan change. That swap charges a
 * proration and is not a first charge, so the 14-day promise does not cover
 * it. Callers only show the line where the click creates a new purchase.
 *
 * Kinds:
 * - `subscription`: a new subscription, charged today.
 * - `pass`: the 3-month Personal pass, one payment, nothing renews.
 * - `deferred`: a new subscription whose first charge is a later date.
 *
 * No em dashes, no angle brackets, no "30 days", no "trial".
 */

export const REASSURANCE_KINDS = /** @type {const} */ (['subscription', 'pass', 'deferred']);
export const REASSURANCE_LOCALES = /** @type {const} */ (['en', 'de', 'fr', 'es', 'nb', 'zh']);

const COPY = {
  en: {
    subscription: 'Charged today. Cancel any time. 14-day refund.',
    pass: 'Charged once today. Nothing to cancel. 14-day refund.',
    deferred: 'No charge today. Cancel any time. 14-day refund.',
  },
  de: {
    subscription: 'Heute abgebucht. Jederzeit kündbar. 14 Tage volle Erstattung.',
    pass: 'Einmalig heute abgebucht. Nichts zu kündigen. 14 Tage volle Erstattung.',
    deferred: 'Heute keine Abbuchung. Jederzeit kündbar. 14 Tage volle Erstattung.',
  },
  fr: {
    subscription: "Débité aujourd'hui. Résiliable à tout moment. Remboursable pendant 14 jours.",
    pass: "Débité une seule fois aujourd'hui. Rien à résilier. Remboursable pendant 14 jours.",
    deferred: "Rien n'est débité aujourd'hui. Résiliable à tout moment. Remboursable pendant 14 jours.",
  },
  es: {
    subscription: 'Se cobra hoy. Cancela cuando quieras. Reembolsable durante 14 días.',
    pass: 'Un único cobro hoy. Nada que cancelar. Reembolsable durante 14 días.',
    deferred: 'Hoy no se cobra nada. Cancela cuando quieras. Reembolsable durante 14 días.',
  },
  nb: {
    subscription: 'Trekkes i dag. Si opp når som helst. 14 dagers angrerett.',
    pass: 'Trekkes én gang i dag. Ingenting å si opp. 14 dagers angrerett.',
    deferred: 'Ingen trekk i dag. Si opp når som helst. 14 dagers angrerett.',
  },
  zh: {
    subscription: '今天扣款。随时可以取消。14 天内可全额退款。',
    pass: '今天一次性扣款。无需取消。14 天内可全额退款。',
    deferred: '今天不扣款。随时可以取消。14 天内可全额退款。',
  },
};

/** Normalise any locale tag ('nb-NO', 'zh-CN', 'de') to one we carry, else 'en'. */
export function reassuranceLocale(locale) {
  const base = typeof locale === 'string' ? locale.toLowerCase().split(/[-_]/)[0] : '';
  if (base === 'no' || base === 'nn') return 'nb';
  return REASSURANCE_LOCALES.includes(base) ? base : 'en';
}

/**
 * The line for `kind` in `locale`. An unknown kind falls back to
 * `subscription`, an unknown locale to English.
 *
 * @param {string | null | undefined} locale
 * @param {'subscription' | 'pass' | 'deferred'} [kind]
 * @returns {string}
 */
export function checkoutReassurance(locale, kind = 'subscription') {
  const k = REASSURANCE_KINDS.includes(kind) ? kind : 'subscription';
  return COPY[reassuranceLocale(locale)][k];
}
