/**
 * Switch Pro to Personal at the end of the current period. Pure: no I/O.
 *
 * MECHANICS (Documents/plans/pause-downgrade-20261024.md, section 12, D8).
 * NO subscription schedule: a schedule blocks our own cancel calls and the
 * one-click cancel (test T9). Instead, at confirm time:
 *
 *   subscriptions.update(sub, {
 *     items: [{ id: <plan item>, price: <Personal price, same interval> }],
 *     proration_behavior: 'none',      no charge and no credit now; the next
 *                                      renewal simply bills Personal
 *     metadata: mcpe_downgrade_from = 'solo',
 *               mcpe_downgrade_from_price = <the Pro price it was on>,
 *               mcpe_downgrade_effective_at = <current period end>,
 *   })
 *
 * The period already paid at Pro stays Pro: the webhook holds entitlement on
 * mcpe_downgrade_from until mcpe_downgrade_effective_at, then projects Personal
 * and parks inboxes above Personal's three. Undo swaps back to the exact price
 * it came from (a retained Pro price stays retained), proration none, and
 * clears the metadata. Cancel stays a normal cancel because nothing is
 * scheduled in Stripe.
 */

import {
  basePlanItem,
  getPlanByStripePriceId,
  PLANS,
  type BillingInterval,
  type PlanId,
} from '@/lib/stripe/plans';
import type { PausableSubscription } from '@/lib/billing/pause';

export const DOWNGRADE_FROM_KEY = 'mcpe_downgrade_from';
export const DOWNGRADE_FROM_PRICE_KEY = 'mcpe_downgrade_from_price';
export const DOWNGRADE_EFFECTIVE_AT_KEY = 'mcpe_downgrade_effective_at';

/** v1: Pro to Personal only, same interval, monthly or annual. */
export const DOWNGRADE_PATHS: Readonly<Partial<Record<PlanId, PlanId>>> = { solo: 'personal' };

export type DowngradeStateName = 'none' | 'pending' | 'effective';

export interface DowngradeState {
  state: DowngradeStateName;
  /** The plan entitlement stays on until effectiveAt. */
  fromPlan: PlanId | null;
  /** The plan the current price resolves to. */
  toPlan: PlanId | null;
  /** Unix seconds. */
  effectiveAt: number | null;
}

function secondsOf(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function toInt(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function asPlanId(value: string | null | undefined): PlanId | null {
  return value && value in PLANS ? (value as PlanId) : null;
}

/**
 * none | pending (booked, entitlement still on the from-plan) | effective
 * (the date has passed; the current price's plan applies).
 *
 * The metadata only counts while the subscription is on a DIFFERENT plan's
 * price than the one it came from: after an undo, or any later move back up,
 * leftover metadata means nothing.
 */
export function downgradeState(subscription: PausableSubscription, now: Date = new Date()): DowngradeState {
  const meta = subscription.metadata ?? {};
  const fromPlan = asPlanId(meta[DOWNGRADE_FROM_KEY]);
  const effectiveAt = toInt(meta[DOWNGRADE_EFFECTIVE_AT_KEY]);
  const item = basePlanItem(subscription.items.data);
  const toPlan = item ? getPlanByStripePriceId(item.price.id)?.plan.id ?? null : null;
  if (!fromPlan || effectiveAt == null || !toPlan || toPlan === fromPlan) {
    return { state: 'none', fromPlan: null, toPlan, effectiveAt: null };
  }
  return {
    state: secondsOf(now) < effectiveAt ? 'pending' : 'effective',
    fromPlan,
    toPlan,
    effectiveAt,
  };
}

export type DowngradeRefusal =
  | 'plan_not_eligible'
  | 'not_active'
  | 'past_due'
  | 'multiple_items'
  | 'paused'
  | 'already_pending'
  | 'cancel_scheduled'
  | 'price_not_configured'
  | 'no_period';

export interface DowngradeQuote {
  fromPlan: PlanId;
  toPlan: PlanId;
  interval: BillingInterval;
  /** The Personal price that bills from effectiveAt. */
  priceId: string;
  amountCents: number;
  currency: string;
  /** Unix seconds: the current period end. */
  effectiveAt: number;
  /** Inboxes the target plan includes per workspace. */
  inboxCap: number;
}

export type DowngradeEligibility =
  | { eligible: true; quote: DowngradeQuote }
  | { eligible: false; reason: DowngradeRefusal };

export function downgradeEligibility(
  subscription: PausableSubscription,
  now: Date = new Date(),
): DowngradeEligibility {
  const item = basePlanItem(subscription.items.data);
  const resolved = item ? getPlanByStripePriceId(item.price.id) : null;
  const toPlan = resolved ? DOWNGRADE_PATHS[resolved.plan.id] : undefined;
  if (!item || !resolved || !toPlan) return { eligible: false, reason: 'plan_not_eligible' };
  if (subscription.status === 'past_due' || subscription.status === 'unpaid') {
    return { eligible: false, reason: 'past_due' };
  }
  if (subscription.status !== 'active') return { eligible: false, reason: 'not_active' };
  if (subscription.items.data.length !== 1) return { eligible: false, reason: 'multiple_items' };
  if (subscription.pause_collection?.behavior) return { eligible: false, reason: 'paused' };
  if (downgradeState(subscription, now).state === 'pending') return { eligible: false, reason: 'already_pending' };
  if (subscription.cancel_at_period_end === true || subscription.cancel_at != null) {
    return { eligible: false, reason: 'cancel_scheduled' };
  }
  const effectiveAt = item.current_period_end ?? null;
  if (effectiveAt == null) return { eligible: false, reason: 'no_period' };

  const target = PLANS[toPlan];
  const interval = resolved.interval;
  const priceId = interval === 'year' ? target.stripePriceIdYearly : target.stripePriceIdMonthly;
  const amountCents = interval === 'year' ? target.yearlyPriceCents : target.monthlyPriceCents;
  if (!priceId || amountCents == null) return { eligible: false, reason: 'price_not_configured' };

  return {
    eligible: true,
    quote: {
      fromPlan: resolved.plan.id,
      toPlan,
      interval,
      priceId,
      amountCents,
      currency: subscription.currency ?? 'usd',
      effectiveAt,
      inboxCap: target.limits.maxInboxes,
    },
  };
}

export interface DowngradeUpdate {
  items: Array<{ id: string; price: string }>;
  proration_behavior: 'none';
  metadata: Record<string, string>;
}

/** The swap for a quote. Throws when the subscription is no longer eligible. */
export function downgradeUpdate(subscription: PausableSubscription, now: Date = new Date()): {
  params: DowngradeUpdate;
  quote: DowngradeQuote;
} {
  const verdict = downgradeEligibility(subscription, now);
  if (!verdict.eligible) throw new Error(`downgrade refused: ${verdict.reason}`);
  const item = basePlanItem(subscription.items.data)!;
  const { quote } = verdict;
  return {
    quote,
    params: {
      items: [{ id: item.id, price: quote.priceId }],
      proration_behavior: 'none',
      metadata: {
        [DOWNGRADE_FROM_KEY]: quote.fromPlan,
        [DOWNGRADE_FROM_PRICE_KEY]: item.price.id,
        [DOWNGRADE_EFFECTIVE_AT_KEY]: String(quote.effectiveAt),
      },
    },
  };
}

/**
 * Undo a pending downgrade: back to the exact price it came from. Throws
 * when nothing is pending or the original price is unknown.
 */
export function undoDowngradeUpdate(subscription: PausableSubscription, now: Date = new Date()): {
  params: DowngradeUpdate;
  fromPlan: PlanId;
} {
  const state = downgradeState(subscription, now);
  if (state.state !== 'pending' || !state.fromPlan) throw new Error('undo refused: not_pending');
  const item = basePlanItem(subscription.items.data)!;
  const meta = subscription.metadata ?? {};
  const fromPrice = meta[DOWNGRADE_FROM_PRICE_KEY];
  const resolvedFrom = fromPrice ? getPlanByStripePriceId(fromPrice) : null;
  if (!fromPrice || resolvedFrom?.plan.id !== state.fromPlan) throw new Error('undo refused: unknown_price');
  return {
    fromPlan: state.fromPlan,
    params: {
      items: [{ id: item.id, price: fromPrice }],
      proration_behavior: 'none',
      metadata: {
        [DOWNGRADE_FROM_KEY]: '',
        [DOWNGRADE_FROM_PRICE_KEY]: '',
        [DOWNGRADE_EFFECTIVE_AT_KEY]: '',
      },
    },
  };
}

/** True when the subscription is on its way out (portal or our own cancel). */
export function cancelScheduled(subscription: Pick<PausableSubscription, 'cancel_at' | 'cancel_at_period_end'>): boolean {
  return subscription.cancel_at_period_end === true || subscription.cancel_at != null;
}

export type SwitchFreeRefusal = 'not_active' | 'cancel_scheduled' | 'paused' | 'plan_not_eligible';

/**
 * "Switch to Free" is a cancel at period end: the same field the portal sets,
 * so cancellationAction() and the existing cancel queue see it. Allowed for
 * any self-service paid subscription that is not already stopping or paused.
 */
export function switchFreeEligibility(subscription: PausableSubscription): { eligible: boolean; reason: SwitchFreeRefusal | null } {
  const item = basePlanItem(subscription.items.data);
  const resolved = item ? getPlanByStripePriceId(item.price.id) : null;
  if (!resolved) return { eligible: false, reason: 'plan_not_eligible' };
  if (!['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status)) {
    return { eligible: false, reason: 'not_active' };
  }
  if (cancelScheduled(subscription)) return { eligible: false, reason: 'cancel_scheduled' };
  if (subscription.pause_collection?.behavior) return { eligible: false, reason: 'paused' };
  return { eligible: true, reason: null };
}
