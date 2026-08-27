const PAID_PLANS = new Set(['personal', 'solo', 'pro']);
const BILLING_INTERVALS = new Set(['month', 'year']);

/** Return a checkout intent only when both URL values are explicitly allowed. */
export function parseUpgradeIntent(planId, interval) {
  return PAID_PLANS.has(planId) && BILLING_INTERVALS.has(interval)
    ? { planId, interval }
    : null;
}

/** Build the dashboard destination for a selected paid plan. */
export function upgradeDestination(planId, annual) {
  return `/dashboard/settings?upgrade=${planId}&interval=${annual ? 'year' : 'month'}`;
}

/** Preserve paid-plan intent through account creation for anonymous visitors. */
export function pricingUpgradeHref(planId, annual, signedIn) {
  const destination = upgradeDestination(planId, annual);
  return signedIn ? destination : `/signup?redirect=${encodeURIComponent(destination)}`;
}
