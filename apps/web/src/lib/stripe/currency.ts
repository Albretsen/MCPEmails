/**
 * Which currency a new Checkout session is forced into, if any.
 *
 * HOW CURRENCY WORKS AFTER THE EUR LAUNCH. Every sold price keeps USD as its
 * main currency and gains a `currency_options[eur]` entry (VAT-inclusive, see
 * tax-switch.ts). Stripe then localizes by itself: a buyer Stripe places in a
 * euro-area country is shown and charged the EUR amount with no code of ours
 * involved, and a buyer anywhere else falls through to Adaptive Pricing (see
 * adaptive-pricing.ts), which converts the USD price at a fee the buyer pays.
 *
 * THE GAP THIS FILE CLOSES. Stripe only picks a currency option for a buyer
 * whose own country uses that currency. A Swede, Pole, Czech, Dane, Hungarian
 * or Romanian is an EU consumer, owes VAT at their own rate either way, but
 * would get the converted USD price with Adaptive Pricing's markup instead of
 * the clean 9 EUR the rest of the EU sees. Passing `currency: 'eur'` for exactly
 * those six countries gives them the EUR price. Everyone else gets no
 * `currency` parameter at all, so Stripe's own localization stays in charge.
 *
 * WHERE THE COUNTRY COMES FROM. `x-vercel-ip-country` on the checkout request,
 * via countryFromHeaders in src/lib/acquisition-country.mjs. It is a hint for
 * which currency to SHOW, never what the tax is computed from: Stripe Tax uses
 * the billing address the buyer enters on the hosted page.
 *
 * THE SWITCH. STRIPE_EUR_PRICES, default OFF (same parsing as tax-switch.ts).
 * It must only be turned on AFTER the EUR currency options exist on every sold
 * price: Stripe refuses a session whose `currency` none of its prices carry, so
 * flipping it early would break checkout for these six countries.
 *
 * ROLLBACK. Turning the switch off only stops the forcing; Stripe keeps
 * localizing euro-area buyers for as long as the currency options exist. The
 * real rollback is STRIPE_FORCE_USD below.
 */
import { switchOn } from '@/lib/stripe/tax-switch';

type Env = Record<string, string | undefined>;

/** The 27 EU member states, as ISO 3166-1 alpha-2 (Greece is GR here, not EL). */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
]);

/**
 * The EU member states that use the euro. Bulgaria adopted it on 2026-01-01, so
 * it is here and not in the non-euro list. Non-EU users of the euro (Montenegro,
 * Kosovo, Andorra and the like) are left out on purpose: they are not EU VAT
 * territory, and Stripe localizes them on its own if it chooses to.
 */
export const EURO_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT',
  'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK',
]);

/**
 * STRIPE_FORCE_USD: the rollback switch, default OFF.
 *
 * A currency option cannot be removed from a Stripe price once added (checked
 * in test mode 2026-10-24, see docs/RUNBOOK-eur-launch.md), and Stripe keeps
 * localizing euro-area buyers into EUR for as long as the option exists. So
 * turning STRIPE_EUR_PRICES off is NOT a rollback. This is: every new session
 * is pinned to `currency: 'usd'`, and the EUR and Stripe Tax additions are
 * dropped with it (checkout-core.ts), which is the checkout from before the
 * EUR launch.
 */
export function forceUsdEnabled(env: Env = process.env): boolean {
  return switchOn(env.STRIPE_FORCE_USD);
}

/**
 * Whether a session for this buyer will be shown in EUR, so the confirmation
 * panel back on the dashboard can say so. True for the six forced countries
 * and for euro-area buyers, whom Stripe localizes itself once the EUR options
 * exist (the switch being on is the promise that they do). Never under
 * STRIPE_FORCE_USD.
 */
export function checkoutPresentsEur(
  country: string | null | undefined,
  env: Env = process.env,
): boolean {
  if (forceUsdEnabled(env) || !eurPricesEnabled(env) || !country) return false;
  return EU_COUNTRIES.has(country.toUpperCase());
}

/** STRIPE_EUR_PRICES: force EUR for EU countries outside the euro area. */
export function eurPricesEnabled(env: Env = process.env): boolean {
  return switchOn(env.STRIPE_EUR_PRICES);
}

/**
 * The `currency` to pass to `stripe.checkout.sessions.create`, or undefined to
 * pass none. `country` is an already-sanitized two-letter code or null.
 * STRIPE_FORCE_USD wins over everything and answers 'usd' for every buyer.
 */
export function checkoutCurrencyFor(
  country: string | null | undefined,
  env: Env = process.env,
): 'eur' | 'usd' | undefined {
  if (forceUsdEnabled(env)) return 'usd';
  if (!eurPricesEnabled(env) || !country) return undefined;
  const code = country.toUpperCase();
  if (EU_COUNTRIES.has(code) && !EURO_COUNTRIES.has(code)) return 'eur';
  return undefined;
}
