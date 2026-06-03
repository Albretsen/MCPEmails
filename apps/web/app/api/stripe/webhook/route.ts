/**
 * POST /api/stripe/webhook
 *
 * Stripe webhook handler. Listens for billing events and syncs subscription
 * state to the USER's `user_billing` row, then projects the resulting plan onto
 * EVERY workspace that user owns (`workspaces.plan`).
 *
 * The subscription is tied to the USER (the owner), not a single workspace. The
 * owner is resolved from the Stripe customer (via metadata.user_id, or the
 * `user_billing.stripe_customer_id` mapping). See
 * supabase/migrations/20260606000000_user_level_billing.sql.
 *
 * Handled events:
 *   checkout.session.completed        : checkout finished; activate plan
 *   customer.subscription.created     : sub created (e.g. outside Checkout)
 *   customer.subscription.updated     : sub changed (upgrade/downgrade/renew/status)
 *   customer.subscription.deleted     : sub fully cancelled; revert to free
 *
 * Dunning grace period (Change 3):
 *   `past_due` and `unpaid` are treated as STILL ENTITLED — Stripe is retrying
 *   the card and we must not yank a paying customer. Downgrade to free only on
 *   `customer.subscription.deleted`, or when the status reaches a terminal
 *   cancelled state (`canceled` / `incomplete_expired`). The raw status is
 *   persisted so a "payment failed" banner can be shown later.
 *
 * Idempotency + out-of-order protection (Change 4):
 *   Every event id is recorded in `stripe_webhook_events`
 *   (INSERT ... ON CONFLICT DO NOTHING). A duplicate event is skipped. We also
 *   ignore an event whose Stripe `created` time predates the newest event we
 *   already processed for that customer, so a redelivered stale event can never
 *   clobber a newer correct state.
 *
 * Security:
 *   Every request is verified against STRIPE_WEBHOOK_SECRET using the raw body.
 *   This handler uses the service-role Supabase client (bypasses RLS).
 *
 * References:
 *   src/lib/stripe/plans.ts  (plan catalogue, getPlanByStripePriceId)
 *   src/lib/stripe/client.ts (stripe SDK instance)
 */

import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { stripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { getPlanByStripePriceId, type PlanId } from '@/lib/stripe/plans';

// ---------------------------------------------------------------------------
// Route config
// ---------------------------------------------------------------------------

/** Give Stripe webhook processing up to 30 seconds before Vercel times out. */
export const maxDuration = 30;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

/** Subscription statuses that should keep the user ENTITLED to their paid plan. */
const ENTITLED_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set([
  'active',
  'trialing',
  'past_due', // dunning: Stripe is retrying the card — keep access.
  'unpaid',   // dunning: still within Stripe's retry window — keep access.
]);

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Verify webhook signature ───────────────────────────────────────────
  if (!WEBHOOK_SECRET) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set.');
    return NextResponse.json(
      { error: 'Webhook secret not configured.' },
      { status: 500 },
    );
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json(
      { error: 'Missing stripe-signature header.' },
      { status: 400 },
    );
  }

  let rawBody: Buffer;
  try {
    const buffer = await request.arrayBuffer();
    rawBody = Buffer.from(buffer);
  } catch {
    return NextResponse.json(
      { error: 'Failed to read request body.' },
      { status: 400 },
    );
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[stripe-webhook] Signature verification failed:', message);
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${message}` },
      { status: 400 },
    );
  }

  // ── 2. Idempotency: skip events we have already processed ──────────────────
  const supabase = createServiceRoleClient();
  const customerIdForEvent = extractCustomerId(event);

  const { data: ledgerRow, error: ledgerError } = await supabase
    .from('stripe_webhook_events')
    .insert({
      event_id: event.id,
      event_type: event.type,
      event_created: new Date(event.created * 1000).toISOString(),
      stripe_customer_id: customerIdForEvent,
    })
    .select('event_id')
    .maybeSingle();

  if (ledgerError) {
    // 23505 = unique_violation → duplicate event id → already processed. Ack.
    if ((ledgerError as { code?: string }).code === '23505') {
      console.log(`[stripe-webhook] duplicate event ${event.id} skipped.`);
      return NextResponse.json({ received: true, duplicate: true }, { status: 200 });
    }
    console.error('[stripe-webhook] ledger insert failed:', ledgerError.message);
    // Return 500 so Stripe retries; we'd rather retry than silently drop.
    return NextResponse.json({ error: 'Ledger write failed.' }, { status: 500 });
  }

  if (!ledgerRow) {
    // No row returned despite no error → treat as already-processed. Ack.
    console.log(`[stripe-webhook] event ${event.id} already in ledger; skipped.`);
    return NextResponse.json({ received: true, duplicate: true }, { status: 200 });
  }

  // ── 3. Out-of-order guard ──────────────────────────────────────────────────
  // Ignore this event if a NEWER event for the same customer was already
  // processed (Stripe redelivery of a stale event must not clobber newer state).
  if (customerIdForEvent) {
    const { data: newer } = await supabase
      .from('stripe_webhook_events')
      .select('event_id')
      .eq('stripe_customer_id', customerIdForEvent)
      .neq('event_id', event.id)
      .gt('event_created', new Date(event.created * 1000).toISOString())
      .limit(1)
      .maybeSingle();

    if (newer) {
      console.log(
        `[stripe-webhook] event ${event.id} is stale for customer ${customerIdForEvent}; skipping plan change.`,
      );
      return NextResponse.json({ received: true, stale: true }, { status: 200 });
    }
  }

  // ── 4. Route to event handler ─────────────────────────────────────────────
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(
          event.data.object as Stripe.Checkout.Session,
        );
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpserted(
          event.data.object as Stripe.Subscription,
        );
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(
          event.data.object as Stripe.Subscription,
        );
        break;

      default:
        // Unhandled event types are acknowledged but not processed.
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[stripe-webhook] Error handling event ${event.type}:`, message);
    // The event is already in the ledger; deleting it would let Stripe's retry
    // re-process. Remove the ledger row so the retry is not skipped as a dup.
    await supabase.from('stripe_webhook_events').delete().eq('event_id', event.id);
    return NextResponse.json(
      { error: 'Internal server error processing webhook.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ received: true }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * checkout.session.completed
 *
 * Fired after a customer completes Stripe Checkout. Metadata carries `user_id`
 * and `plan_id` (set in /api/stripe/checkout). We activate the plan immediately
 * (rather than waiting for subscription.created) to avoid a redirect race.
 */
async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  if (session.mode !== 'subscription') return;

  const userId = session.metadata?.user_id ?? null;
  const planId = session.metadata?.plan_id as PlanId | undefined;

  if (!planId || (planId !== 'solo' && planId !== 'pro')) {
    console.error(
      `[stripe-webhook] checkout.session.completed bad/missing plan_id "${planId}" (session ${session.id})`,
    );
    return;
  }

  const customerId =
    typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id ?? null;

  const subscriptionId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id ?? null;

  await applyUserPlan({
    userId,
    customerId,
    subscriptionId,
    newPlan: planId,
    subscriptionStatus: 'active',
    source: 'checkout.session.completed',
  });
}

/**
 * customer.subscription.created / customer.subscription.updated
 *
 * Resolve the plan from the first line item's price ID. Apply the dunning grace
 * period: entitled statuses keep the paid plan; terminal cancelled states
 * downgrade to free.
 */
async function handleSubscriptionUpserted(
  subscription: Stripe.Subscription,
): Promise<void> {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer.id;

  const userId = subscription.metadata?.user_id ?? null;
  const status = subscription.status;

  // Persist status always (so a banner can read it), even when downgrading.
  if (!ENTITLED_STATUSES.has(status)) {
    // Not entitled (canceled / incomplete / incomplete_expired / paused):
    // downgrade to free but keep the raw status for visibility.
    await applyUserPlan({
      userId,
      customerId,
      subscriptionId: subscription.id,
      newPlan: 'free',
      subscriptionStatus: status,
      source: `customer.subscription.updated (status=${status})`,
    });
    return;
  }

  // Entitled — resolve which paid plan from the price ID.
  const priceId = subscription.items.data[0]?.price?.id;
  if (!priceId) {
    console.error(
      '[stripe-webhook] subscription has no price ID on first item:',
      subscription.id,
    );
    return;
  }

  const resolved = getPlanByStripePriceId(priceId);
  if (!resolved) {
    console.error(
      `[stripe-webhook] price ID "${priceId}" does not map to a known plan (sub ${subscription.id})`,
    );
    return;
  }

  await applyUserPlan({
    userId,
    customerId,
    subscriptionId: subscription.id,
    newPlan: resolved.plan.id,
    subscriptionStatus: status,
    currentPeriodEnd: subscription.items.data[0]?.current_period_end ?? null,
    source: 'customer.subscription.upserted',
  });
}

/**
 * customer.subscription.deleted
 *
 * The subscription is fully cancelled. Downgrade ALL of the user's workspaces
 * to free.
 */
async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
): Promise<void> {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer.id;

  const userId = subscription.metadata?.user_id ?? null;

  await applyUserPlan({
    userId,
    customerId,
    subscriptionId: subscription.id,
    newPlan: 'free',
    subscriptionStatus: 'canceled',
    source: 'customer.subscription.deleted',
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Best-effort extraction of the Stripe customer id from any event object. */
function extractCustomerId(event: Stripe.Event): string | null {
  const obj = event.data.object as { customer?: string | { id: string } | null };
  const c = obj?.customer;
  if (!c) return null;
  return typeof c === 'string' ? c : c.id ?? null;
}

interface ApplyUserPlanOptions {
  /** The owner user id, when known from event metadata. */
  userId: string | null;
  /** The Stripe customer id (fallback for resolving the owner). */
  customerId: string | null;
  /** The Stripe subscription id, if any. */
  subscriptionId?: string | null;
  /** Plan to grant the user: 'free' | 'solo' | 'pro'. */
  newPlan: PlanId | 'free';
  /** Raw Stripe subscription status to persist (for dunning banners). */
  subscriptionStatus?: string | null;
  /** Unix seconds of current period end, if known. */
  currentPeriodEnd?: number | null;
  /** Human-readable label for log messages. */
  source: string;
}

/**
 * Single source of truth update:
 *   1. Resolve the owner (user_id from metadata, else user_billing by customer).
 *   2. Upsert `user_billing` (plan + status + customer + subscription).
 *   3. Project the plan onto EVERY non-deleted workspace owned by that user.
 */
async function applyUserPlan(options: ApplyUserPlanOptions): Promise<void> {
  const {
    userId,
    customerId,
    subscriptionId,
    newPlan,
    subscriptionStatus,
    currentPeriodEnd,
    source,
  } = options;

  const supabase = createServiceRoleClient();

  // ── Resolve owner ──────────────────────────────────────────────────────────
  let resolvedUserId: string | null = userId;

  if (!resolvedUserId && customerId) {
    const { data, error } = await supabase
      .from('user_billing')
      .select('user_id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle();
    if (error) {
      throw new Error(
        `[stripe-webhook] ${source}: failed to resolve user for customer ${customerId}: ${error.message}`,
      );
    }
    resolvedUserId = data?.user_id ?? null;
  }

  if (!resolvedUserId) {
    console.error(
      `[stripe-webhook] ${source}: could not resolve owner. customerId=${customerId ?? 'none'}`,
    );
    return;
  }

  // ── Upsert user_billing (single source of truth) ──────────────────────────
  const billingUpdate: {
    user_id: string;
    plan: string;
    updated_at: string;
    stripe_customer_id?: string;
    stripe_subscription_id?: string | null;
    subscription_status?: string | null;
    current_period_end?: string;
  } = {
    user_id: resolvedUserId,
    plan: newPlan,
    updated_at: new Date().toISOString(),
  };
  if (customerId) billingUpdate.stripe_customer_id = customerId;
  if (subscriptionId !== undefined) billingUpdate.stripe_subscription_id = subscriptionId;
  if (subscriptionStatus !== undefined) billingUpdate.subscription_status = subscriptionStatus;
  if (currentPeriodEnd != null) {
    billingUpdate.current_period_end = new Date(currentPeriodEnd * 1000).toISOString();
  }

  const { error: billingError } = await supabase
    .from('user_billing')
    .upsert(billingUpdate, { onConflict: 'user_id' });

  if (billingError) {
    throw new Error(
      `[stripe-webhook] ${source}: failed to upsert user_billing for ${resolvedUserId}: ${billingError.message}`,
    );
  }

  // ── Project plan onto ALL workspaces the user owns ────────────────────────
  const { error: wsError } = await supabase
    .from('workspaces')
    .update({
      plan: newPlan,
      stripe_customer_id: customerId ?? undefined,
      updated_at: new Date().toISOString(),
    })
    .eq('owner_id', resolvedUserId)
    .is('deleted_at', null);

  if (wsError) {
    throw new Error(
      `[stripe-webhook] ${source}: failed to project plan "${newPlan}" onto workspaces of ${resolvedUserId}: ${wsError.message}`,
    );
  }

  console.log(
    `[stripe-webhook] ${source}: user ${resolvedUserId} → plan "${newPlan}" (status=${subscriptionStatus ?? 'n/a'}); propagated to all owned workspaces`,
  );
}
