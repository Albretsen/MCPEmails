/**
 * The dated Pro price notice, in every full locale.
 *
 * Shown only while proPriceNoticeVisible() says so (pro-price-change.ts): the
 * `announce` switch is on, the new price is not live yet, and the switch
 * instant has not passed. Read by the pricing page, the dashboard's Pro upgrade
 * surfaces and the announcement email, so the three can never quote different
 * numbers or dates.
 *
 * Deliberately not a next-intl namespace: every `messages/` namespace is
 * serialised into every marketing page, and personal-price-copy.test.ts rejects
 * any amount in `messages/` that the catalogue does not sell today ($19 is not
 * sold until the switch). Every amount and date below is computed from
 * PRO_PRICE_CHANGE, never typed, so moving a number there moves every sentence.
 *
 * zh is frozen and falls back to English, as the rest of the site does.
 *
 * Wording rules: no "was", no strike-through, no "% off", no countdown, no
 * "last chance". One fact (the date and the new price) and one promise (keep
 * the current price while the subscription stays active).
 */

import { PRO_PRICE_CHANGE } from './pro-price-change.ts';

const TIME_ZONE = 'Europe/Oslo';

/** How each locale writes a dollar amount on the pricing page today. */
const MONEY = {
  en: (n) => `$${n}`,
  de: (n) => `$${n}`,
  es: (n) => `$${n.replace('.', ',')}`,
  nb: (n) => `$${n.replace('.', ',')}`,
  fr: (n) => `${n.replace('.', ',')} $`,
};

/** BCP 47 tags for the date formatter: British English writes "8 December". */
const DATE_LOCALE = { en: 'en-GB', de: 'de-DE', es: 'es-ES', nb: 'nb-NO', fr: 'fr-FR' };

const COPY = {
  en: {
    pricing: ({ next, nextYear, cur, curYear, switchDate, lastDate }) =>
      `Pro goes to ${next} a month (${nextYear} a year) for new subscriptions on ${switchDate}. Subscribe by ${lastDate} and you keep ${cur} a month (${curYear} a year) for as long as your subscription stays active.`,
    app: ({ next, cur, switchDate, lastDate }) =>
      `From ${switchDate} new Pro subscriptions cost ${next} a month. Subscribe by ${lastDate} to keep ${cur} for as long as you stay subscribed.`,
    faqQ: () => 'Is the Pro price changing?',
    faqA: ({ next, nextYear, cur, curYear, switchDate }) =>
      `Yes. From ${switchDate}, new Pro subscriptions cost ${next} a month or ${nextYear} a year. If you subscribe to Pro before then, you keep ${cur} a month (or ${curYear} a year) for as long as your subscription stays active, including if you switch between monthly and yearly billing. If you cancel and the subscription ends, or move to another plan and later come back to Pro, the price at that time applies. Existing Pro subscribers do not need to do anything.`,
  },
  es: {
    pricing: ({ next, nextYear, cur, curYear, switchDate, lastDate }) =>
      `Pro pasa a costar ${next} al mes (${nextYear} al año) para las suscripciones nuevas a partir del ${switchDate}. Si te suscribes hasta el ${lastDate}, mantienes ${cur} al mes (${curYear} al año) mientras tu suscripción siga activa.`,
    app: ({ next, cur, switchDate, lastDate }) =>
      `Desde el ${switchDate}, las suscripciones nuevas a Pro cuestan ${next} al mes. Suscríbete hasta el ${lastDate} para mantener ${cur} mientras sigas suscrito.`,
    faqQ: () => '¿Va a cambiar el precio de Pro?',
    faqA: ({ next, nextYear, cur, curYear, switchDate }) =>
      `Sí. Desde el ${switchDate}, las suscripciones nuevas a Pro cuestan ${next} al mes o ${nextYear} al año. Si te suscribes a Pro antes, mantienes ${cur} al mes (o ${curYear} al año) mientras tu suscripción siga activa, también si cambias entre facturación mensual y anual. Si cancelas y la suscripción termina, o pasas a otro plan y más tarde vuelves a Pro, se aplica el precio de ese momento. Si ya tienes Pro, no tienes que hacer nada.`,
  },
  fr: {
    pricing: ({ next, nextYear, cur, curYear, switchDate, lastDate }) =>
      `Pro passe à ${next} par mois (${nextYear} par an) pour les nouveaux abonnements à partir du ${switchDate}. Abonnez-vous au plus tard le ${lastDate} et vous gardez ${cur} par mois (${curYear} par an) tant que votre abonnement reste actif.`,
    app: ({ next, cur, switchDate, lastDate }) =>
      `À partir du ${switchDate}, les nouveaux abonnements Pro coûtent ${next} par mois. Abonnez-vous au plus tard le ${lastDate} pour garder ${cur} tant que vous restez abonné.`,
    faqQ: () => 'Le prix de Pro va-t-il changer ?',
    faqA: ({ next, nextYear, cur, curYear, switchDate }) =>
      `Oui. À partir du ${switchDate}, les nouveaux abonnements Pro coûtent ${next} par mois ou ${nextYear} par an. Si vous vous abonnez à Pro avant cette date, vous gardez ${cur} par mois (ou ${curYear} par an) tant que votre abonnement reste actif, y compris si vous passez de la facturation mensuelle à annuelle ou inversement. Si vous résiliez et que l'abonnement prend fin, ou si vous passez à une autre formule puis revenez à Pro, le prix en vigueur à ce moment-là s'applique. Les abonnés Pro actuels n'ont rien à faire.`,
  },
  nb: {
    pricing: ({ next, nextYear, cur, curYear, switchDate, lastDate }) =>
      `Pro går opp til ${next} i måneden (${nextYear} i året) for nye abonnementer fra ${switchDate}. Abonnerer du senest ${lastDate}, beholder du ${cur} i måneden (${curYear} i året) så lenge abonnementet er aktivt.`,
    app: ({ next, cur, switchDate, lastDate }) =>
      `Fra ${switchDate} koster nye Pro-abonnementer ${next} i måneden. Abonner senest ${lastDate} for å beholde ${cur} så lenge du abonnerer.`,
    faqQ: () => 'Endres prisen på Pro?',
    faqA: ({ next, nextYear, cur, curYear, switchDate }) =>
      `Ja. Fra ${switchDate} koster nye Pro-abonnementer ${next} i måneden eller ${nextYear} i året. Abonnerer du på Pro før det, beholder du ${cur} i måneden (eller ${curYear} i året) så lenge abonnementet er aktivt, også om du bytter mellom månedlig og årlig betaling. Sier du opp og abonnementet avsluttes, eller bytter du til en annen plan og senere kommer tilbake til Pro, gjelder prisen på det tidspunktet. Har du Pro allerede, trenger du ikke gjøre noe.`,
  },
  de: {
    pricing: ({ next, nextYear, cur, curYear, switchDate, lastDate }) =>
      `Ab dem ${switchDate} kostet Pro für neue Abonnements ${next} pro Monat (${nextYear} pro Jahr). Wenn Sie bis zum ${lastDate} abonnieren, behalten Sie ${cur} pro Monat (${curYear} pro Jahr), solange Ihr Abonnement aktiv bleibt.`,
    app: ({ next, cur, switchDate, lastDate }) =>
      `Ab dem ${switchDate} kosten neue Pro-Abonnements ${next} pro Monat. Abonnieren Sie bis zum ${lastDate}, um ${cur} zu behalten, solange Ihr Abonnement läuft.`,
    faqQ: () => 'Ändert sich der Preis von Pro?',
    faqA: ({ next, nextYear, cur, curYear, switchDate }) =>
      `Ja. Ab dem ${switchDate} kosten neue Pro-Abonnements ${next} pro Monat oder ${nextYear} pro Jahr. Wenn Sie Pro vorher abonnieren, behalten Sie ${cur} pro Monat (oder ${curYear} pro Jahr), solange Ihr Abonnement aktiv bleibt, auch wenn Sie zwischen monatlicher und jährlicher Zahlung wechseln. Wenn Sie kündigen und das Abonnement endet, oder in einen anderen Tarif wechseln und später zu Pro zurückkehren, gilt der Preis zu diesem Zeitpunkt. Bestehende Pro-Abonnenten müssen nichts tun.`,
  },
};

export const PRO_PRICE_NOTICE_LOCALES = Object.freeze(Object.keys(COPY));

function resolveLocale(locale) {
  return Object.hasOwn(COPY, locale) ? locale : 'en';
}

/** "182.40" for 18240, "19" for 1900: the number before locale formatting. */
function plainAmount(cents) {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

/** A calendar date ("2026-12-08") in the locale's long form, read in Oslo. */
function formatDay(locale, isoDate, withYear) {
  // Noon UTC, so the Oslo calendar day is the same day whatever the offset.
  const at = new Date(`${isoDate}T12:00:00Z`);
  return new Intl.DateTimeFormat(DATE_LOCALE[locale], {
    day: 'numeric',
    month: 'long',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: TIME_ZONE,
  }).format(at);
}

/** The values every sentence is filled from, formatted for `locale`. */
export function proPriceNoticeValues(locale, change = PRO_PRICE_CHANGE) {
  const l = resolveLocale(locale);
  const money = MONEY[l];
  return {
    next: money(plainAmount(change.next.monthlyCents)),
    nextYear: money(plainAmount(change.next.yearlyCents)),
    cur: money(plainAmount(change.current.monthlyCents)),
    curYear: money(plainAmount(change.current.yearlyCents)),
    switchDate: formatDay(l, change.switchDate, true),
    lastDate: formatDay(l, change.lastLockInDate, false),
  };
}

/**
 * Every sentence for one locale. Unknown locales (zh) read English.
 *
 * @returns {{ pricing: string, app: string, faq: { q: string, a: string } }}
 */
export function proPriceNoticeCopy(locale, change = PRO_PRICE_CHANGE) {
  const l = resolveLocale(locale);
  const values = proPriceNoticeValues(l, change);
  const c = COPY[l];
  return {
    pricing: c.pricing(values),
    app: c.app(values),
    faq: { q: c.faqQ(values), a: c.faqA(values) },
  };
}
