// ---------------------------------------------------------------------------
// What a screen needs to SHOW a seasonal first-year offer (Black Week 2026).
//
// The offer itself (window, coupon, amounts, the legal guard that the live
// yearly price still equals the normal price) is decided on the server in
// src/lib/stripe/seasonal-offer.ts and seasonal-offer-server.ts. This module
// only turns a SeasonalOffer object into the strings a sentence needs, and
// decides when a cached copy of one must stop being shown. Nothing here reads
// `process.env` or knows a price: every amount comes from the offer object, so
// a screen cannot print a number the checkout will not charge.
//
// Client-safe, no imports, so both realms (marketing /pricing and the
// dashboard) and their DOM tests can use it.
// ---------------------------------------------------------------------------

/** The plans a seasonal offer can exist for. Business and monthly never. */
export const SEASONAL_PLAN_IDS = ['personal', 'solo'];

/**
 * The offer to show right now, or null.
 *
 * The server already returns null outside the window. This is the second,
 * client-side half of the same rule: a response cached by the CDN or held in
 * memory by a tab left open must not keep showing the line after `endsAt`.
 *
 * @param {unknown} offer A SeasonalOffer from the server, or anything else.
 * @param {number} [nowMs]
 */
export function liveSeasonalOffer(offer, nowMs = Date.now()) {
  if (!offer || typeof offer !== 'object') return null;
  const { firstYearCents, normalYearlyCents, savingCents, endsAt, interval, planId } = offer;
  if (interval !== 'year' || !SEASONAL_PLAN_IDS.includes(planId)) return null;
  for (const cents of [firstYearCents, normalYearlyCents, savingCents]) {
    if (typeof cents !== 'number' || !Number.isFinite(cents) || cents <= 0) return null;
  }
  // A first-year price that is not below the renewal is no offer at all.
  if (firstYearCents >= normalYearlyCents) return null;
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end) || nowMs > end) return null;
  return offer;
}

/** The offer for one plan out of a SeasonalOffers map, or null. */
export function seasonalOfferForPlan(offers, planId, nowMs = Date.now()) {
  if (!offers || typeof offers !== 'object') return null;
  const offer = liveSeasonalOffer(offers[planId], nowMs);
  // Keyed by plan AND naming that plan: an entry filed under the wrong key
  // must not put Personal's price on another card.
  return offer && offer.planId === planId ? offer : null;
}

/**
 * The live price map with each plan's seasonal offer attached as
 * `seasonalOffer`, so every surface that already receives `stripePrices` can
 * read it without new props. Plans without an offer are passed through
 * unchanged (same object), and so is the map when there is nothing to attach.
 */
export function withSeasonalOffers(stripePrices, offers) {
  if (!stripePrices || !offers || typeof offers !== 'object') return stripePrices;
  let changed = false;
  const out = { ...stripePrices };
  for (const planId of SEASONAL_PLAN_IDS) {
    const offer = offers[planId];
    if (offer && offer.planId === planId && out[planId]) {
      out[planId] = { ...out[planId], seasonalOffer: offer };
      changed = true;
    }
  }
  return changed ? out : stripePrices;
}

/** Bare amount, no currency sign: the message writes its own "$". */
function amount(cents, locale) {
  const whole = cents % 100 === 0;
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
      useGrouping: false,
    }).format(cents / 100);
  } catch {
    return whole ? String(cents / 100) : (cents / 100).toFixed(2);
  }
}

// English reads "1 December 2026", the form the offer terms use, rather than
// en-US "December 1, 2026". Other locales use their own order.
const DATE_LOCALE = { en: 'en-GB', nb: 'nb-NO', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', zh: 'en-GB' };

/**
 * The end date and time as the offer states them: in Oslo time, because that
 * is the time the window is defined in, whatever the reader's own zone.
 */
export function seasonalEndParts(endsAt, locale = 'en') {
  const end = new Date(endsAt);
  if (!Number.isFinite(end.getTime())) return null;
  const tag = DATE_LOCALE[locale] ?? 'en-GB';
  try {
    const date = new Intl.DateTimeFormat(tag, {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Oslo',
    }).format(end);
    const time = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Oslo',
    }).format(end);
    return { date, time };
  } catch {
    return null;
  }
}

/**
 * Every value the offer sentences take, formatted for `locale`.
 *
 * `firstYear`, `renewal` and `saving` are bare amounts (the messages carry the
 * currency sign in the position each language puts it). Null when the offer
 * is not live, so a caller renders nothing.
 *
 * @param {unknown} offer
 * @param {string} [locale]
 * @param {number} [nowMs]
 */
export function seasonalOfferValues(offer, locale = 'en', nowMs = Date.now()) {
  const live = liveSeasonalOffer(offer, nowMs);
  if (!live) return null;
  const end = seasonalEndParts(live.endsAt, locale);
  if (!end) return null;
  return {
    firstYear: amount(live.firstYearCents, locale),
    renewal: amount(live.normalYearlyCents, locale),
    saving: amount(live.savingCents, locale),
    date: end.date,
    time: end.time,
  };
}

/**
 * Whether /pricing should ask the server for offers at all.
 *
 * The page is prerendered and CDN cached, so the offer is fetched after mount
 * from /api/seasonal-offer. Outside a margin around the window there is
 * nothing to ask for, so no request is made (the server would answer {}
 * anyway). The margin covers a visitor's clock being somewhat wrong; the
 * server's clock is the one that decides. In development it always asks, so
 * SEASONAL_OFFER_PREVIEW_NOW can be checked on a real page.
 *
 * @param {{ startsAt: string, endsAt: string } | null | undefined} window
 * @param {number} [nowMs]
 * @param {string | undefined} [nodeEnv]
 */
export function shouldFetchSeasonalOffers(window, nowMs = Date.now(), nodeEnv = undefined) {
  if (nodeEnv === 'development') return true;
  if (!window) return false;
  const start = Date.parse(window.startsAt);
  const end = Date.parse(window.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const MARGIN = 12 * 60 * 60 * 1000;
  return nowMs >= start - MARGIN && nowMs <= end + MARGIN;
}
