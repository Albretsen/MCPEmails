/**
 * Whether the billing page may show the Black Week "switch to annual" card.
 *
 * The card is for an OWNER whose live subscription is on the CURRENT monthly
 * price of Personal or Pro, during the window, who has never had a
 * subscription tagged with the offer. Everyone else sees nothing: annual
 * subscribers, Business, legacy Team, the retired Personal $5 price, comped
 * accounts, and anyone who already redeemed it.
 *
 * These are the same conditions checkout-core applies when it prices the swap
 * (the `fromCurrentMonthly` test and hasRedeemedSeasonalOffer), so the card
 * only appears for someone whose quote will actually carry the first-year
 * price. The server still decides at checkout; this only decides what to show.
 *
 * WHY HERE AND NOT IN THE BROWSER. `user_billing` stores a plan and no
 * interval: the only place the current interval is written down is the price
 * on the Stripe subscription. So this reads Stripe, once, and only when there
 * is an offer at all and the account is on a plan that could take it.
 *
 * Never throws. Any failure, and a Stripe call slower than `timeoutMs`, means
 * no card: the page then renders exactly what it rendered before.
 */

import { PLANS, basePlanItem, getPlanByStripePriceId } from '@/lib/stripe/plans';
import {
  BLACK_WEEK_2026,
  SEASONAL_OFFER_METADATA_KEY,
  isSeasonalPlanId,
  type SeasonalOffer,
  type SeasonalOffers,
} from '@/lib/stripe/seasonal-offer';

/** The parts of a Stripe subscription this reads. */
export interface SwitchSubscriptionFacts {
  id: string;
  status: string;
  metadata?: Record<string, string> | null;
  items: { data: Array<{ price?: { id?: string | null } | null }> };
}

export interface SeasonalSwitchInput {
  offers: SeasonalOffers;
  /** The workspace's effective plan id. */
  plan: string | null | undefined;
  isOwner: boolean;
  compedScale: boolean;
  stripeCustomerId: string | null | undefined;
  stripeSubscriptionId: string | null | undefined;
}

export interface SeasonalSwitchDeps {
  /** Every subscription of the customer, any status. */
  listSubscriptions: (customerId: string) => Promise<SwitchSubscriptionFacts[]>;
  timeoutMs?: number;
}

const LIVE_STATUSES = ['active', 'trialing', 'past_due'];

/**
 * Cheap pre-check, no Stripe call and no billing row: could this account take
 * the card at all? Lets the dashboard skip both reads for nearly everyone.
 */
export function mayOfferSeasonalSwitch(
  input: Pick<SeasonalSwitchInput, 'offers' | 'plan' | 'isOwner' | 'compedScale'>,
): boolean {
  return (
    input.isOwner === true &&
    input.compedScale !== true &&
    isSeasonalPlanId(input.plan) &&
    Boolean(input.offers[input.plan])
  );
}

function hasIds(input: SeasonalSwitchInput): boolean {
  return (
    typeof input.stripeCustomerId === 'string' &&
    input.stripeCustomerId.length > 0 &&
    typeof input.stripeSubscriptionId === 'string' &&
    input.stripeSubscriptionId.length > 0
  );
}

/**
 * The offer to show on the switch card, or null.
 *
 * Pure over the subscriptions it is handed, so the rule is testable without
 * Stripe.
 */
export function seasonalSwitchFromSubscriptions(
  input: SeasonalSwitchInput,
  subscriptions: SwitchSubscriptionFacts[],
): SeasonalOffer | null {
  if (!mayOfferSeasonalSwitch(input) || !hasIds(input)) return null;
  // One redemption per person, on any subscription they ever had.
  if (subscriptions.some((s) => s.metadata?.[SEASONAL_OFFER_METADATA_KEY] === BLACK_WEEK_2026.id)) {
    return null;
  }
  const current = subscriptions.find((s) => s.id === input.stripeSubscriptionId);
  if (!current || !LIVE_STATUSES.includes(current.status)) return null;
  const item = basePlanItem(current.items.data);
  const priceId = item?.price?.id ?? null;
  const resolved = getPlanByStripePriceId(priceId);
  if (!resolved || resolved.interval !== 'month') return null;
  const planId = resolved.plan.id;
  if (!isSeasonalPlanId(planId)) return null;
  // The CURRENT monthly price only: a retired price is never re-priced from a
  // promotion, and checkout-core would not apply the coupon to it.
  if (priceId !== PLANS[planId].stripePriceIdMonthly) return null;
  return input.offers[planId] ?? null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export async function resolveSeasonalSwitch(
  input: SeasonalSwitchInput,
  deps: SeasonalSwitchDeps,
): Promise<SeasonalOffer | null> {
  if (!mayOfferSeasonalSwitch(input) || !hasIds(input)) return null;
  try {
    const subscriptions = await withTimeout(
      deps.listSubscriptions(input.stripeCustomerId as string),
      deps.timeoutMs ?? 2500,
    );
    return seasonalSwitchFromSubscriptions(input, subscriptions);
  } catch (err) {
    console.error(
      '[seasonal-switch] could not read subscriptions, no switch card:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** The real thing, wired to Stripe. Server only. */
export async function getSeasonalSwitchOffer(input: SeasonalSwitchInput): Promise<SeasonalOffer | null> {
  return resolveSeasonalSwitch(input, {
    listSubscriptions: async (customerId) => {
      const { stripe } = await import('@/lib/stripe/client');
      const list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
      return list.data as unknown as SwitchSubscriptionFacts[];
    },
  });
}
