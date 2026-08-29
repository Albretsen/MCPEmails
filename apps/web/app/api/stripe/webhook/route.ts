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
 * Purchase confirmation email:
 *   `checkout.session.completed` also triggers a one-time confirmation email to
 *   the purchaser, sent through Resend (see
 *   src/lib/email/purchase-confirmation.ts). It is scheduled with `after()` so
 *   it runs post-response, is idempotent per Checkout session, and can never
 *   fail the webhook. No other event sends mail: see the long comment at the
 *   end of handleCheckoutSessionCompleted for why.
 *
 * Security:
 *   Every request is verified against STRIPE_WEBHOOK_SECRET using the raw body.
 *   This handler uses the service-role Supabase client (bypasses RLS).
 *
 * References:
 *   src/lib/stripe/plans.ts  (plan catalogue, getPlanByStripePriceId)
 *   src/lib/stripe/client.ts (stripe SDK instance)
 *   src/lib/email/purchase-confirmation.ts (confirmation email composer + sender)
 */

import { NextRequest, NextResponse, after } from 'next/server';
import type Stripe from 'stripe';
import { stripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/service';
import {
  getPlanByStripePriceId,
  PLANS,
  type BillingInterval,
  type PlanId,
} from '@/lib/stripe/plans';
import { sendPurchaseConfirmationEmail } from '@/lib/email/purchase-confirmation';
import {
  billingTarget,
  primaryWorkspaceId,
  recordCheckoutCompleted,
} from '@/lib/analytics/billing-funnel';

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
 *
 * The subscription status is derived from the actual subscription (retrieved
 * from Stripe) rather than hardcoded to 'active', so a checkout that completes
 * with a `trialing`/`incomplete`/`past_due` subscription is reflected
 * accurately. If the subscription cannot be retrieved we fall back to the
 * Stripe-provided `payment_status` as a best-effort hint, never an unconditional
 * 'active'. The authoritative state is still the subsequent
 * customer.subscription.* events.
 */
async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  if (session.mode !== 'subscription') return;

  const userId = session.metadata?.user_id ?? null;

  // Accept any purchasable plan in the catalogue, derived rather than listed.
  // A hardcoded ('solo' | 'pro') list here was the bug that would take a
  // Personal customer's money and then leave them on free: the metadata is
  // rejected, this handler returns early, and no plan is ever written.
  // `free` is not purchasable, so it stays rejected along with any unknown id.
  const rawPlanId = session.metadata?.plan_id;
  const planId: PlanId | undefined =
    typeof rawPlanId === 'string' && rawPlanId !== 'free' && rawPlanId in PLANS
      ? (rawPlanId as PlanId)
      : undefined;

  if (!planId) {
    console.error(
      `[stripe-webhook] checkout.session.completed bad/missing plan_id "${rawPlanId}" (session ${session.id})`,
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

  // Derive the real subscription status instead of assuming 'active'.
  let subscriptionStatus: string | null = null;
  let currentPeriodEnd: number | null = null;
  let currentPeriodStart: number | null = null;
  let resolvedPlan: PlanId | 'free' = planId;
  // Resolved from the price the customer actually subscribed to; the checkout
  // metadata is only the fallback.
  let resolvedInterval: BillingInterval | null = null;

  if (subscriptionId) {
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      subscriptionStatus = subscription.status;
      currentPeriodEnd =
        subscription.items.data[0]?.current_period_end ?? null;
      currentPeriodStart =
        subscription.items.data[0]?.current_period_start ?? null;

      // Prefer the price the customer actually subscribed to over the metadata
      // plan_id (they should agree, but the subscription is authoritative).
      const priceId = subscription.items.data[0]?.price?.id;
      const resolved = getPlanByStripePriceId(priceId);
      if (resolved) {
        resolvedPlan = resolved.plan.id;
        resolvedInterval = resolved.interval;
      } else if (priceId) {
        console.error(
          `[stripe-webhook] checkout.session.completed: price "${priceId}" on sub ${subscriptionId} does not map to a known plan; using metadata plan_id "${planId}" (session ${session.id})`,
        );
      }

      // If the subscription is NOT entitled (e.g. incomplete), do not grant the
      // paid plan; downgrade to free and persist the raw status for visibility.
      if (!ENTITLED_STATUSES.has(subscription.status)) {
        resolvedPlan = 'free';
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[stripe-webhook] checkout.session.completed: failed to retrieve subscription ${subscriptionId}: ${message}. Falling back to session.payment_status.`,
      );
      // Best-effort fallback: a paid checkout session implies an active sub.
      subscriptionStatus =
        session.payment_status === 'paid' ? 'active' : (session.payment_status ?? null);
    }
  } else {
    // No subscription id on the session (unexpected for mode=subscription).
    subscriptionStatus =
      session.payment_status === 'paid' ? 'active' : (session.payment_status ?? null);
  }

  await applyUserPlan({
    userId,
    customerId,
    subscriptionId,
    newPlan: resolvedPlan,
    subscriptionStatus,
    currentPeriodEnd,
    currentPeriodStart,
    source: 'checkout.session.completed',
  });

  if (resolvedPlan === 'free') return;
  // Re-bind to a const: `resolvedPlan` is a `let`, and TypeScript discards the
  // non-'free' narrowing for a `let` captured by the `after()` closure below.
  const purchasedPlan: Exclude<PlanId, 'free'> = resolvedPlan;

  // The price the customer actually subscribed to is authoritative; the
  // checkout metadata is only a fallback for a session whose subscription we
  // could not retrieve.
  const interval: BillingInterval =
    resolvedInterval ?? (session.metadata?.interval === 'year' ? 'year' : 'month');

  // Close the billing funnel. Only an entitled outcome counts as a completed
  // checkout: an `incomplete` subscription resolves to `free` above and is a
  // failed payment, which must not read as revenue in the funnel.
  if (userId) {
    const service = createServiceRoleClient();
    await recordCheckoutCompleted(
      await primaryWorkspaceId(service, userId),
      billingTarget(purchasedPlan, interval),
    );
  }

  // ── Purchase confirmation email ──────────────────────────────────────────
  //
  // WHY ONLY HERE. `checkout.session.completed` is the one event that means "a
  // human just bought this". It fires exactly once per Checkout session and is
  // never emitted again for that purchase. `customer.subscription.updated`, by
  // contrast, fires on every renewal, every upgrade and downgrade, every
  // payment-method change, every dunning status transition and every proration,
  // so confirming from there would mail a customer on a monthly cadence
  // forever. `customer.subscription.created` overlaps this event for the same
  // purchase (different event id, so the ledger would NOT dedupe it) and also
  // fires for subscriptions we create outside Checkout, such as the comped
  // 100%-off grants, which must not receive a purchase confirmation. Hence:
  // checkout.session.completed, and nothing else.
  //
  // A customer who cancels and later subscribes again completes a genuinely new
  // Checkout session and is correctly confirmed a second time.
  //
  // IDEMPOTENCY. Stripe-side only, and that is sufficient on its own:
  //   1. `stripe_webhook_events` rejects a redelivered event id, and this send
  //      is the LAST thing the handler does, after every write that could
  //      throw. The only path that removes a ledger row is the catch block in
  //      POST, which can no longer be reached once we get here, so a Stripe
  //      retry of this event is always skipped as a duplicate before any code
  //      in this function runs.
  //   2. Stripe emits `checkout.session.completed` exactly once per Checkout
  //      session, and no other event type reaches this send, so there is no
  //      second event that could confirm the same purchase.
  //   3. `sendPurchaseConfirmationEmail` makes exactly one Resend call and
  //      never retries, so it cannot duplicate a delivered mail on its own, and
  //      that call carries a Resend Idempotency-Key derived from this session
  //      id as a second layer.
  //
  // CONTAINMENT. The send runs in `after()`, so it is scheduled outside this
  // handler's try/catch and executes only after the 200 has gone back to
  // Stripe. It cannot delay the response into a Stripe timeout, it cannot roll
  // the ledger row back, and `sendPurchaseConfirmationEmail` is written never to
  // throw, so a bounced or failed email can never cost a customer their plan.
  const recipient = session.customer_details?.email ?? session.customer_email ?? null;
  if (recipient) {
    after(() =>
      sendPurchaseConfirmationEmail({
        to: recipient,
        planId: purchasedPlan,
        interval,
        amountTotalCents: session.amount_total ?? null,
        currency: session.currency ?? null,
        sessionId: session.id,
      }),
    );
  } else {
    console.error(
      `[stripe-webhook] checkout.session.completed ${session.id}: no email on the session; confirmation email skipped.`,
    );
  }
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
    // Unknown / archived price: we cannot map it to a current plan. Do NOT
    // crash and do NOT blindly downgrade (that would yank access from a paying
    // customer whose subscription is merely on a legacy/archived price id). But
    // we also must not silently drop the event: persist the customer +
    // subscription linkage and the raw status so the row is not orphaned (the
    // portal/dunning banner keeps working) while leaving the existing plan
    // untouched. This is loud-logged so the price can be reconciled.
    console.error(
      `[stripe-webhook] price ID "${priceId}" does not map to a known plan (sub ${subscription.id}, status=${status}); persisting linkage + status WITHOUT changing plan. Reconcile this price.`,
    );
    await applyUserPlan({
      userId,
      customerId,
      subscriptionId: subscription.id,
      newPlan: null, // sentinel: keep the current plan, only sync linkage/status
      subscriptionStatus: status,
      currentPeriodStart: subscription.items.data[0]?.current_period_start ?? null,
      currentPeriodEnd: subscription.items.data[0]?.current_period_end ?? null,
      source: `customer.subscription.upserted (unmapped price ${priceId})`,
    });
    return;
  }

  await applyUserPlan({
    userId,
    customerId,
    subscriptionId: subscription.id,
    newPlan: resolved.plan.id,
    subscriptionStatus: status,
    currentPeriodStart: subscription.items.data[0]?.current_period_start ?? null,
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
  /**
   * Plan to grant the user: 'free' or any catalogue plan id
   * ('personal' | 'solo' | 'pro'). The value is written to `user_billing.plan`
   * (plain text) and projected onto `workspaces.plan`, whose CHECK constraint
   * allows 'personal' as of migration 20260827100000.
   * `null` is a sentinel meaning "do not change the plan" — used when a
   * subscription is on an unknown/archived price we cannot map: we still want to
   * sync the customer/subscription linkage and raw status, but must not change
   * the plan column.
   */
  newPlan: PlanId | 'free' | null;
  /** Raw Stripe subscription status to persist (for dunning banners). */
  subscriptionStatus?: string | null;
  /** Unix seconds of current period end, if known. */
  currentPeriodEnd?: number | null;
  /** Unix seconds of current period start, if known. */
  currentPeriodStart?: number | null;
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
    currentPeriodStart,
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
    plan?: string;
    updated_at: string;
    stripe_customer_id?: string;
    stripe_subscription_id?: string | null;
    subscription_status?: string | null;
    current_period_end?: string;
    current_period_start?: string;
  } = {
    user_id: resolvedUserId,
    updated_at: new Date().toISOString(),
  };
  // newPlan === null means "leave the plan as-is" (unknown/archived price).
  if (newPlan !== null) billingUpdate.plan = newPlan;
  if (customerId) billingUpdate.stripe_customer_id = customerId;
  if (subscriptionId !== undefined) billingUpdate.stripe_subscription_id = subscriptionId;
  if (subscriptionStatus !== undefined) billingUpdate.subscription_status = subscriptionStatus;
  if (currentPeriodEnd != null) {
    billingUpdate.current_period_end = new Date(currentPeriodEnd * 1000).toISOString();
  }
  if (currentPeriodStart != null) {
    billingUpdate.current_period_start = new Date(currentPeriodStart * 1000).toISOString();
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
  // When newPlan === null (unmapped price) we only sync the customer linkage and
  // leave the plan column untouched on both user_billing and workspaces.
  const workspaceUpdate: {
    plan?: string;
    stripe_customer_id?: string;
    updated_at: string;
  } = {
    updated_at: new Date().toISOString(),
  };
  if (newPlan !== null) workspaceUpdate.plan = newPlan;
  if (customerId) workspaceUpdate.stripe_customer_id = customerId;

  const { error: wsError } = await supabase
    .from('workspaces')
    .update(workspaceUpdate)
    .eq('owner_id', resolvedUserId)
    .is('deleted_at', null);

  if (wsError) {
    throw new Error(
      `[stripe-webhook] ${source}: failed to project plan "${newPlan ?? '(unchanged)'}" onto workspaces of ${resolvedUserId}: ${wsError.message}`,
    );
  }

  console.log(
    `[stripe-webhook] ${source}: user ${resolvedUserId} → plan "${newPlan ?? '(unchanged)'}" (status=${subscriptionStatus ?? 'n/a'}); propagated to all owned workspaces`,
  );
}
