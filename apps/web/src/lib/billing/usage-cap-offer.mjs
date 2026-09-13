import { checkoutStartHref, pricingCompareHref } from './upgrade-intent.mjs';

/**
 * Which plan an action-cap block should sell, and the copy keys that sell it.
 *
 * The sibling of inbox-cap-offer.mjs, for the other cap a Free workspace can
 * meet: 150 email actions a month (docs/PLAN-free-action-cap-150.md). Same
 * rule, the cheapest plan that clears the cap that was just hit. Free is the
 * only tier with a public action cap, so the answer is always Personal ($5):
 * it removes the monthly cap, and sending someone to $15 Pro to keep reading
 * their mail prices the upgrade far above the problem.
 *
 * Every surface that mentions the cap (the Usage page banner, the refusal text
 * the edge function sends an agent, the 80% and 100% emails) has to quote the
 * same plan at the same price. This module is where the dashboard gets its
 * answer; the two hrefs below wrap `checkoutStartHref` and `pricingCompareHref`
 * from upgrade-intent.mjs, so the offer survives the jump to /pricing (commit
 * ea7c1ae) exactly as the inbox offer does.
 *
 * The feature keys name the Billing card bullets rather than a second set of
 * strings, so the banner and the plan card cannot describe Personal
 * differently.
 *
 * @param {{ reached?: boolean }} [state] `reached` once used >= cap; the
 *   title and body then say the allowance is gone rather than nearly gone.
 * @returns {{plan: string, titleKey: string, bodyKey: string, ctaKey: string, featureKeys: string[]}}
 */
export function usageCapOffer({ reached = false } = {}) {
  return {
    plan: 'personal',
    titleKey: reached ? 'usage.capTitleReached' : 'usage.capTitleNear',
    bodyKey: reached ? 'usage.capBodyReached' : 'usage.capBodyNear',
    ctaKey: 'usage.capCta',
    featureKeys: [
      'billing.plans.personalFeatureActions',
      'billing.plans.personalFeature1',
      'billing.plans.personalFeature2',
      'billing.plans.personalFeature4',
    ],
  };
}

/**
 * The name this surface goes by in the URL, matching the `offer=usage_cap`
 * the 80% and 100% emails carry (src/lib/email/billing-lifecycle.ts). Nothing
 * reads it yet; it exists so a click from the banner and a click from the mail
 * are distinguishable in the funnel without a second parameter vocabulary.
 */
export const USAGE_CAP_OFFER = 'usage_cap';

/**
 * The banner's buy link: straight at the checkout route, plus the offer name.
 *
 * NOT the email's URL. The emails send a reader to
 * /dashboard/settings?upgrade=personal&interval=month&offer=usage_cap because
 * they arrive from outside, often signed out, and BillingSection is what can
 * pick an intent back up after a login. From inside the dashboard that same
 * link would server-render the whole dashboard a second time before a client
 * effect could start checkout, the two-to-three second stall
 * app/api/stripe/checkout/start/route.ts exists to remove, so the in-product
 * banner uses the direct route the inbox-cap notice uses. Both carry plan,
 * interval and offer, which is what any consumer of either URL reads.
 *
 * Must be rendered as a plain <a>, never a next/link <Link>: the router would
 * prefetch it and manufacture Stripe sessions.
 */
export function usageCapCheckoutHref(planId, annual) {
  return `${checkoutStartHref(planId, annual)}&offer=${USAGE_CAP_OFFER}`;
}

/**
 * The banner's "compare all plans" link, carrying the same offer name.
 *
 * pricingCompareHref degrades to a bare '/pricing' for a plan it will not
 * sell, so the separator is chosen from the result rather than assumed.
 */
export function usageCapCompareHref(planId, annual) {
  const href = pricingCompareHref(planId, annual);
  return `${href}${href.includes('?') ? '&' : '?'}offer=${USAGE_CAP_OFFER}`;
}
