const PAID_PLANS = new Set(['personal', 'solo', 'pro']);
const BILLING_INTERVALS = new Set(['month', 'year']);

/** Return a checkout intent only when both URL values are explicitly allowed. */
export function parseUpgradeIntent(planId, interval) {
  return PAID_PLANS.has(planId) && BILLING_INTERVALS.has(interval)
    ? { planId, interval }
    : null;
}

/**
 * The dashboard destination for a selected paid plan.
 *
 * LEGACY, BUT LIVE. This is no longer where a buy button points: it renders the
 * whole dashboard before a client effect can start checkout, which is the two
 * to three second stall the direct route below exists to remove. It stays
 * because `?upgrade=` links are already out in the world (emails, shared URLs,
 * cached marketing HTML, the sidebar upsell) and BillingSection still honours
 * them. Do not delete it, and do not point new CTAs at it.
 */
export function upgradeDestination(planId, annual) {
  return `/dashboard/settings?upgrade=${planId}&interval=${annual ? 'year' : 'month'}`;
}

/**
 * The direct buy destination: one authenticated GET that redirects to Stripe.
 *
 * See app/api/stripe/checkout/start/route.ts. Must be rendered as a plain <a>,
 * never a next/link <Link>, so the router never prefetches it.
 */
export function checkoutStartHref(planId, annual) {
  return `/api/stripe/checkout/start?plan=${planId}&interval=${annual ? 'year' : 'month'}`;
}

/**
 * Preserve paid-plan intent through account creation for anonymous visitors.
 *
 * Signed in, the CTA goes straight at the checkout route. Signed out, it goes
 * through /signup carrying that same route as the post-signup destination, so
 * the first thing a new customer sees after authenticating is Stripe rather
 * than a dashboard they have to find the buy button on again.
 */
export function pricingUpgradeHref(planId, annual, signedIn) {
  const destination = checkoutStartHref(planId, annual);
  return signedIn ? destination : `/signup?redirect=${encodeURIComponent(destination)}`;
}
