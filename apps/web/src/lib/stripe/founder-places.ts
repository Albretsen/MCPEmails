/**
 * The webhook half of the Business founder price: when a subscription whose
 * plan item is on a founder price is paid, it takes a place in
 * public.business_founder_places and carries `metadata.founder_offer = founder2026`.
 *
 * Called from customer.subscription.created / .updated, which covers both
 * ways in: a new Checkout subscription (created, then updated to active once
 * paid) and an in-place upgrade (updated when Stripe applies the paid pending
 * update). Idempotent end to end: the insert conflicts on the subscription id
 * and the metadata write is skipped once the tag is there, so Stripe retries
 * and the update this function makes itself cost nothing.
 *
 * Overflow is honoured: a checkout started while a place was open that
 * completes after the 20th still writes its row (the counter then reads 0).
 *
 * Never throws. A failure is logged; the plan write that ran before it stands.
 */

import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { basePlanItem, founderPriceInterval, isFounderPriceId } from '@/lib/stripe/plans';
import {
  invoiceLinePriceId,
  invoiceLinePriceIds,
  invoiceSubscriptionId,
} from '@/lib/billing/invoice-shape';
import { FOUNDER_METADATA_KEY, FOUNDER_OFFER_TAG } from '@/lib/stripe/founder-offer';

/** Statuses that mean the founder subscription has been paid for. */
const PAID_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set(['active', 'trialing']);

export type FounderPlaceResult =
  | { status: 'skipped'; reason: 'not_founder' | 'not_paid' | 'no_owner' | 'test_mode_event' }
  | { status: 'recorded'; inserted: boolean }
  | { status: 'failed' };

/** A test-mode event must never write a row where the live key is in use. */
function liveKeyInUse(): boolean {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  return key.startsWith('sk_live_') || key.startsWith('rk_live_');
}

export async function recordFounderPlace(args: {
  db: SupabaseClient<Database>;
  subscription: Stripe.Subscription;
  ownerId: string | null;
  /** Writes the cohort tag. Injected so a test can see the call. */
  tagSubscription: (subscriptionId: string, metadata: Record<string, string>) => Promise<unknown>;
}): Promise<FounderPlaceResult> {
  const { db, subscription, ownerId, tagSubscription } = args;

  const interval = founderPriceInterval(basePlanItem(subscription.items?.data)?.price?.id ?? null);
  if (!interval) return { status: 'skipped', reason: 'not_founder' };
  if (!PAID_STATUSES.has(subscription.status)) return { status: 'skipped', reason: 'not_paid' };
  if (subscription.livemode === false && liveKeyInUse()) {
    return { status: 'skipped', reason: 'test_mode_event' };
  }
  if (!ownerId) return { status: 'skipped', reason: 'no_owner' };

  try {
    const { data: inserted, error } = await db.rpc('record_business_founder_place', {
      p_subscription_id: subscription.id,
      p_owner_id: ownerId,
      p_interval: interval,
    });
    if (error) {
      console.error('[founder-places] insert failed', { subscription: subscription.id, error: error.message });
      return { status: 'failed' };
    }

    if (subscription.metadata?.[FOUNDER_METADATA_KEY] !== FOUNDER_OFFER_TAG) {
      // Stripe merges metadata keys, so user_id and anything else stay.
      await tagSubscription(subscription.id, { [FOUNDER_METADATA_KEY]: FOUNDER_OFFER_TAG });
    }
    return { status: 'recorded', inserted: inserted === true };
  } catch (err) {
    console.error('[founder-places] failed', {
      subscription: subscription.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: 'failed' };
  }
}

/**
 * The retry: a paid invoice that touches a founder price records the place
 * again (a no-op when the row exists). It recovers a place whose first
 * insert, in `after()` on the subscription event, failed: the next payment
 * writes it. Reads the subscription from Stripe so the status, owner and tag
 * are the live ones, and the decision is the subscription's own base item
 * (recordFounderPlace), not the invoice line: an upgrade invoice also carries
 * a credit line on the old plan's price. Never throws.
 */
export async function recordFounderPlaceFromInvoice(args: {
  db: SupabaseClient<Database>;
  invoice: Stripe.Invoice;
  retrieveSubscription: (id: string) => Promise<Stripe.Subscription>;
  resolveOwner: (subscription: Stripe.Subscription) => Promise<string | null>;
  tagSubscription: (subscriptionId: string, metadata: Record<string, string>) => Promise<unknown>;
}): Promise<FounderPlaceResult> {
  // The charged plan line, or any line on a founder price: cheap, and it
  // keeps the Stripe read off every invoice that has nothing to do with it.
  if (
    !isFounderPriceId(invoiceLinePriceId(args.invoice)) &&
    !invoiceLinePriceIds(args.invoice).some((id) => isFounderPriceId(id))
  ) {
    return { status: 'skipped', reason: 'not_founder' };
  }
  const subscriptionId = invoiceSubscriptionId(args.invoice);
  if (!subscriptionId) return { status: 'skipped', reason: 'not_founder' };
  try {
    const subscription = await args.retrieveSubscription(subscriptionId);
    const ownerId = await args.resolveOwner(subscription);
    return await recordFounderPlace({
      db: args.db,
      subscription,
      ownerId,
      tagSubscription: args.tagSubscription,
    });
  } catch (err) {
    console.error('[founder-places] invoice retry failed', {
      subscription: subscriptionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: 'failed' };
  }
}
