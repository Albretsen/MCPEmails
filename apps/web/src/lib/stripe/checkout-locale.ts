import type Stripe from 'stripe';

/**
 * The languages the hosted Stripe Checkout page is shown in.
 *
 * Keyed by the site's URL locale code, valued by the locale code Stripe
 * Checkout takes for it. They differ once: /pt is written in Brazilian
 * Portuguese (src/i18n/locale-policy.mjs LANGUAGE_TAGS), so it asks Stripe
 * for 'pt-BR', whose button and chrome are Brazilian too, not European 'pt'.
 *
 * German came first, for a legal reason: in subscription mode the button
 * label follows `locale` and nothing else, and under 'de' Stripe renders
 * "Zahlungspflichtig abonnieren", the wording §312j BGB asks for on the
 * button that commits a consumer to pay. French, Spanish, Portuguese,
 * Japanese and Norwegian followed on 2026-11-10: French and Spanish pricing
 * readers started checkout far less often than English ones, and every one of
 * their sessions, shown in English and USD, had expired. A page in the
 * buyer's language next to the price beats one voice across English product
 * names. Those names still live once, in English, on the Stripe Product, and
 * the copy in checkout-core.ts is written knowing that.
 *
 * zh is left out on purpose: it is a frozen locale (locale-policy.mjs), and
 * nobody has written its deck. Adding a locale here means writing both decks
 * (subscription and pass) in checkout-core.ts, confirming its /cancel and
 * /withdrawal pages exist, and extending the tests in checkout-core.test.ts.
 *
 * Pure on purpose: checkout-link.ts and tests that stub checkout-core at the
 * module seam import this without pulling in the Stripe client.
 */
export const CHECKOUT_LOCALES = {
  en: 'en',
  de: 'de',
  fr: 'fr',
  es: 'es',
  pt: 'pt-BR',
  ja: 'ja',
  nb: 'nb',
} as const satisfies Record<string, Stripe.Checkout.SessionCreateParams.Locale>;

/** A site locale the hosted page has copy for. */
export type CheckoutLocale = keyof typeof CHECKOUT_LOCALES;

/** The code Stripe is given for one of those. */
export type StripeCheckoutLocale = (typeof CHECKOUT_LOCALES)[CheckoutLocale];

/**
 * The buyer's language as it arrives from a request (a JSON body field, a
 * `lang` query parameter, a workspace's acquisition locale), allow-listed down
 * to a CheckoutLocale.
 *
 * Exact match only: 'de' is German and 'fr' is French, but 'DE', 'de-AT',
 * 'pt-BR', an array or a missing value are all English. The value is never
 * passed to Stripe as given, so a caller cannot reach a Stripe locale this
 * module has not written copy for.
 */
export function checkoutLocale(value: unknown): CheckoutLocale {
  return typeof value === 'string' && Object.hasOwn(CHECKOUT_LOCALES, value)
    ? (value as CheckoutLocale)
    : 'en';
}

/** The `locale` a Checkout session is created with for a site locale. */
export function stripeCheckoutLocale(locale: CheckoutLocale): StripeCheckoutLocale {
  return CHECKOUT_LOCALES[locale];
}

/**
 * The path prefix the site serves `locale` under: '' for English
 * (localePrefix 'as-needed' in src/i18n/routing.ts), '/de', '/fr', ... for
 * the rest. For building the /cancel and /withdrawal links in the hosted
 * page's text, which point at the page in the buyer's own language.
 */
export function checkoutLocalePrefix(locale: CheckoutLocale): string {
  return locale === 'en' ? '' : `/${locale}`;
}
