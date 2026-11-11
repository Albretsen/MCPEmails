/**
 * "Keep my plan": the rules for removing a scheduled stop. Pure; the route is
 * app/api/billing/keep/route.ts.
 *
 * A stop is scheduled in one of two shapes (see scheduledToStop): the portal
 * sets `cancel_at` to the period end and leaves the boolean false; the API's
 * cancel at period end sets `cancel_at_period_end`. Clearing `cancel_at` with
 * '' clears both (Stripe test T12 in src/lib/billing/pause.ts); Stripe refuses
 * the two parameters in one call, so the boolean is only sent when it is the
 * one that is set.
 */
import { scheduledToStop } from '@/lib/analytics/revenue-math';
import { currentPeriod, pauseState, type PausableSubscription } from '@/lib/billing/pause';

export type KeepRefusal = 'not_scheduled' | 'not_active' | 'paused' | 'already_ended';

export interface KeepQuote {
  cancelScheduled: boolean;
  /** Unix seconds the plan stops, or null when nothing is scheduled. */
  endsAt: number | null;
  canKeep: boolean;
  refusal: KeepRefusal | null;
}

export type KeepUpdate = { cancel_at: '' } | { cancel_at_period_end: false };

export function keepPlanQuote(subscription: PausableSubscription, now: Date = new Date()): KeepQuote {
  const cancelScheduled = scheduledToStop({
    cancel_at: subscription.cancel_at ?? null,
    cancel_at_period_end: subscription.cancel_at_period_end ?? null,
  });
  const endsAt = cancelScheduled ? subscription.cancel_at ?? currentPeriod(subscription).end : null;
  const refusal = keepRefusal(subscription, cancelScheduled, endsAt, now);
  return { cancelScheduled, endsAt, canKeep: refusal === null, refusal };
}

function keepRefusal(
  subscription: PausableSubscription,
  cancelScheduled: boolean,
  endsAt: number | null,
  now: Date,
): KeepRefusal | null {
  if (!cancelScheduled) return 'not_scheduled';
  if (subscription.status !== 'active' && subscription.status !== 'trialing') return 'not_active';
  if (pauseState(subscription, now).state !== 'none') return 'paused';
  if (endsAt != null && endsAt * 1000 <= now.getTime()) return 'already_ended';
  return null;
}

/** The subscriptions.update parameters, or null when there is nothing to keep. */
export function keepPlanUpdate(subscription: PausableSubscription, now: Date = new Date()): KeepUpdate | null {
  if (!keepPlanQuote(subscription, now).canKeep) return null;
  return subscription.cancel_at != null ? { cancel_at: '' } : { cancel_at_period_end: false };
}
