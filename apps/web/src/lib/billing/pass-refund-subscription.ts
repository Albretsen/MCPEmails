/**
 * A refunded 3-month pass and the Personal subscription that was waiting for
 * it to end.
 *
 * A Personal subscription bought during a pass starts billing at the pass's
 * end (passSubscriptionStart in pass.ts): `billing_cycle_anchor` at that date
 * with no proration, or `trial_end` there when Stripe will not take the
 * anchor. Those free days were paid for by the pass. When the pass is refunded
 * in full, the days are no longer paid for, so the first charge moves:
 *
 *   another live pass still covers time   to that cover's end (trial_end, no proration)
 *   nothing else covers                   to now (trial_end 'now', or
 *                                         billing_cycle_anchor 'now' + no proration)
 *
 * Only for a subscription whose first charge is still ahead and falls at or
 * after the refunded pass's end, so an ordinary subscription (already
 * charging) or one tied to a different date is never touched. Idempotent: once
 * moved, the first charge is no longer ahead of the old end, and a second run
 * finds nothing to do.
 *
 * Never throws: it runs after the refund is recorded, and a failure must not
 * cost the webhook its ledger row. A failure is logged loudly for the owner,
 * whose withdrawal to-do (contract-request.ts) says to check Stripe.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';

import type { Database } from '@/types/database.types';
import { basePlanItem, getPlanByStripePriceId } from '@/lib/stripe/plans';
import { getActivePass, hasEntitledSubscription, type BillingSnapshot } from '@/lib/billing/pass';

type Db = SupabaseClient<Database>;

const HOUR_MS = 60 * 60 * 1000;

export interface RefundSubscriptionStripe {
  subscriptions: {
    retrieve(id: string): Promise<Stripe.Subscription>;
    update(id: string, params: Stripe.SubscriptionUpdateParams): Promise<Stripe.Subscription>;
  };
}

type SubscriptionShape = Pick<Stripe.Subscription, 'status' | 'trial_end' | 'billing_cycle_anchor'>;

/** When the subscription first charges, if that is still ahead of `now`; else null. */
export function pendingFirstCharge(subscription: SubscriptionShape, now: Date): Date | null {
  const at =
    subscription.status === 'trialing' && subscription.trial_end
      ? subscription.trial_end * 1000
      : subscription.status === 'active' && subscription.billing_cycle_anchor
        ? subscription.billing_cycle_anchor * 1000
        : null;
  return at !== null && at > now.getTime() ? new Date(at) : null;
}

/**
 * Pure: the Stripe update that ends (or shortens) the free start, or null when
 * there is nothing to change.
 */
export function freeStartAdjustment(input: {
  subscription: SubscriptionShape;
  refundedEndsAt: Date;
  /** The end of what still covers now after the refund, or null. */
  remainingCover: Date | null;
  now: Date;
}): Stripe.SubscriptionUpdateParams | null {
  const { subscription, refundedEndsAt, remainingCover, now } = input;
  const firstCharge = pendingFirstCharge(subscription, now);
  if (!firstCharge) return null;
  // Not started by this pass (its first charge comes before the pass's end).
  if (firstCharge.getTime() < refundedEndsAt.getTime() - HOUR_MS) return null;

  if (remainingCover && remainingCover.getTime() > now.getTime() + HOUR_MS) {
    // Still paid for up to the first charge: nothing to move.
    if (remainingCover.getTime() >= firstCharge.getTime() - HOUR_MS) return null;
    return { trial_end: Math.floor(remainingCover.getTime() / 1000), proration_behavior: 'none' };
  }
  if (subscription.status === 'trialing') return { trial_end: 'now' };
  // On this API version (2026-09-30) the update takes the anchor as an object.
  return { billing_cycle_anchor: { type: 'now' }, proration_behavior: 'none' };
}

export type FreeStartResult =
  | { kind: 'none' }
  | { kind: 'moved'; subscriptionId: string; params: Stripe.SubscriptionUpdateParams }
  | { kind: 'failed'; error: string };

/**
 * After a full pass refund: move the first charge of the user's entitled
 * Personal subscription, when the refunded pass was what made it free.
 * Never throws.
 */
export async function endPassFreeStart(
  db: Db,
  stripe: RefundSubscriptionStripe,
  input: { userId: string; refundedEndsAt: string; source: string; now?: Date },
): Promise<FreeStartResult> {
  const now = input.now ?? new Date();
  try {
    const { data: billing, error } = await db
      .from('user_billing')
      .select('plan, subscription_status, stripe_subscription_id')
      .eq('user_id', input.userId)
      .maybeSingle();
    if (error) throw new Error(`user_billing read failed: ${error.message}`);
    if (!billing?.stripe_subscription_id) return { kind: 'none' };
    if (billing.plan !== 'personal' || !hasEntitledSubscription(billing as BillingSnapshot)) return { kind: 'none' };

    const subscription = await stripe.subscriptions.retrieve(billing.stripe_subscription_id);
    const resolved = getPlanByStripePriceId(basePlanItem(subscription.items?.data)?.price?.id ?? null);
    if (resolved && resolved.plan.id !== 'personal') return { kind: 'none' };

    const active = await getActivePass(db, input.userId, { now, strict: true });
    const params = freeStartAdjustment({
      subscription,
      refundedEndsAt: new Date(input.refundedEndsAt),
      remainingCover: active?.coveredUntil ?? null,
      now,
    });
    if (!params) return { kind: 'none' };

    await stripe.subscriptions.update(subscription.id, params);
    console.log(
      `[pass-refund] ${input.source}: subscription ${subscription.id} of ${input.userId} no longer starts free at the refunded pass end: ${JSON.stringify(params)}.`,
    );
    return { kind: 'moved', subscriptionId: subscription.id, params };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[pass-refund] ${input.source}: COULD NOT move the first charge of ${input.userId}'s Personal subscription after a pass refund; check it in Stripe by hand: ${message}`,
    );
    return { kind: 'failed', error: message };
  }
}
