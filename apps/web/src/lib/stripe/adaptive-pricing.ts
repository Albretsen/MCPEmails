/**
 * Stripe Adaptive Pricing for Checkout.
 *
 * Our prices are defined in USD. With Adaptive Pricing, Stripe shows a
 * buyer outside the US the price converted into their local currency and
 * charges them in it, so a card that would refuse or mark up a USD charge can
 * pay in EUR, CHF, NOK and so on. Stripe adds a 2-4% conversion fee to the
 * converted price; the buyer pays that, not us, and a buyer who switches
 * Checkout back to USD pays no fee.
 *
 * WHAT STAYS IN USD. Stripe keeps every object we read in our integration
 * currency: the Checkout Session's `amount_total`/`currency`, the
 * Subscription's `currency` and price `unit_amount`, Invoice amounts, and the
 * Charge/PaymentIntent `amount`/`currency`. The local amount rides alongside
 * in a separate `presentment_details` hash. So MRR, cash and dunning numbers
 * keep summing USD with no conversion of our own.
 *
 * SUBSCRIPTIONS. Supported for new cross-border subscriptions (card, Link,
 * Apple Pay, Google Pay). The presentment currency is locked until the
 * subscription is cancelled; each renewal is converted at that billing date's
 * rate, and prorations and refunds reuse the rate of the original payment.
 * Existing subscriptions are untouched.
 *
 * AFTER THE EUR LAUNCH (planned 2026-12-07). Each sold price also carries a
 * `currency_options[eur]` amount. Stripe then charges EU buyers that EUR
 * amount natively (euro-area buyers by its own localization, the six non-euro
 * EU countries because checkout-core forces `currency: 'eur'`, see
 * currency.ts), and Adaptive Pricing only converts for everyone else. For
 * those EUR sessions the paragraph above no longer holds: the session,
 * subscription and invoice amounts are in EUR, and every reader of amounts has
 * to keep each currency apart rather than sum it as USD.
 *
 * WHY THE PARAMETER IS ALWAYS SENT. Without it Stripe falls back to the
 * account's Dashboard setting, which this repo cannot see or review. Sending
 * `enabled` explicitly, true or false, keeps the behaviour in code.
 *
 * Kill switch: set STRIPE_ADAPTIVE_PRICING=false (or off / 0) and redeploy to
 * go back to USD-only Checkout. Anything else, including unset, leaves it on.
 *
 * Docs:
 *   https://docs.stripe.com/payments/currencies/localize-prices/adaptive-pricing
 *   https://support.stripe.com/questions/adaptive-pricing-for-subscriptions
 *   https://docs.stripe.com/api/checkout/sessions/create#create_checkout_session-adaptive_pricing
 */

const OFF_VALUES = new Set(['false', 'off', '0', 'no']);

/** True unless STRIPE_ADAPTIVE_PRICING explicitly turns it off. */
export function adaptivePricingEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.STRIPE_ADAPTIVE_PRICING;
  if (raw == null) return true;
  return !OFF_VALUES.has(raw.trim().toLowerCase());
}

/** The `adaptive_pricing` parameter for `stripe.checkout.sessions.create`. */
export function adaptivePricingParam(
  env: Record<string, string | undefined> = process.env,
): { enabled: boolean } {
  return { enabled: adaptivePricingEnabled(env) };
}
