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
 *   invoice.payment_failed            : a renewal was declined; start dunning
 *   invoice.payment_succeeded         : a charge landed; STOP any dunning
 *
 * Billing lifecycle email (added 2026-09-02):
 *   The four subscription events above still do all the entitlement work; the
 *   two invoice events do NO entitlement work at all and exist only to start
 *   and stop email sequences. `invoice.payment_failed` materialises the
 *   four-email dunning sequence into `billing_email_sends`;
 *   `invoice.payment_succeeded` cancels whatever is still pending for that
 *   invoice, which is the primary guarantee that a "your payment failed" email
 *   never lands after the retry already worked.
 *
 *   `customer.subscription.updated` is EXTENDED rather than duplicated: when it
 *   carries cancel_at_period_end = true it also queues the one-question
 *   cancellation email plus the two win-backs, scheduled from the period end.
 *
 *   Everything is gated on BILLING_LIFECYCLE_EMAILS (off | queue_only | on).
 *   The default is `off`, so merging this file changes nothing that a customer
 *   can see. See src/lib/billing/lifecycle-queue.ts.
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
  cancelDunningForCustomer,
  cancelOpenSequence,
  hasCancellationSeries,
  isGrandfathered,
  queueCancellationSequence,
  queueDunningSequence,
  resolveRecipient,
  resolveUserId,
} from '@/lib/billing/lifecycle-queue';
import type { LifecyclePayload } from '@/lib/email/billing-lifecycle';
import { lifecycleQueueingEnabled } from '@/lib/billing/lifecycle-mode';
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

/**
 * Billing lifecycle email mode. THE PRODUCTION KILL SWITCH.
 *
 *   off        (default) Queue nothing, cancel nothing. This file behaves
 *              exactly as it did before lifecycle email existed, which is why
 *              it is safe to merge and deploy before the copy has been signed
 *              off.
 *   queue_only Write the queue rows so the exact sequence, recipient and
 *              schedule can be inspected in the database, but the dispatcher
 *              sends nothing. This is the review mode.
 *   on         Live.
 *
 * Deliberately a three-state string and not a boolean: the interesting state is
 * the middle one, where the trigger logic runs against real Stripe events and
 * produces rows to read, with no possibility of a customer receiving anything.
 *
 * READ AT CALL TIME, never captured into a const at module scope. See the long
 * WHY in src/lib/billing/lifecycle-mode.ts: a module-scope capture is evaluated
 * once per warm lambda, so flipping the variable in the Vercel dashboard would
 * appear to work and change nothing until the next deploy.
 */

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
  //
  // `checkout.session.completed` is EXEMPT, deliberately. The guard exists to
  // stop a redelivered subscription event from overwriting newer subscription
  // state, and this event is not that kind of event: it is the record that a
  // human completed a purchase, it is emitted exactly once per Checkout session,
  // and it is the sole trigger for the purchase confirmation email and the
  // `checkout_completed` funnel row.
  //
  // Stripe emits `customer.subscription.created` for the same purchase, in
  // parallel, with a second-granularity `created` timestamp that can land one
  // second LATER than the checkout event. If that sibling wins the race into the
  // ledger, the checkout event reads as "stale" and returns here — so the
  // customer is charged, keeps their plan (the sibling projects it), and
  // silently receives no confirmation and leaves no completed-checkout row.
  // The two events on the one real Personal purchase (2026-08-29 11:20:45Z)
  // share a timestamp to the second and escaped this only because the
  // comparison is strictly greater-than.
  //
  // Exempting it is safe: it writes the plan its own session paid for, and the
  // per-event-id ledger above still makes a redelivery a no-op.
  //
  // The two `invoice.*` events are exempt for the same reason, and it is not a
  // theoretical concern: Stripe emits `customer.subscription.updated`
  // (status -> past_due) alongside `invoice.payment_failed` for the same
  // decline, with second-granularity timestamps that can land in either order.
  // If the subscription event won that race the invoice event would read as
  // stale and return here, and the dunning sequence would never be queued at
  // all. Exempting them is safe because neither one changes plan state: they
  // only start and stop email sequences, both keyed on the invoice id.
  const EXEMPT_FROM_STALENESS: ReadonlySet<string> = new Set([
    'checkout.session.completed',
    'invoice.payment_failed',
    'invoice.payment_succeeded',
  ]);

  if (customerIdForEvent && !EXEMPT_FROM_STALENESS.has(event.type)) {
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

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
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

  // ── Cancellation save + win-back ─────────────────────────────────────────
  //
  // EXTENDING this handler rather than adding a branch to the switch, as asked.
  // `cancel_at_period_end = true` is not a distinct Stripe event; it is a field
  // on the subscription that this handler already receives, so a new case would
  // have had to listen to the same event type twice.
  //
  // No previous_attributes check, deliberately. Stripe emits
  // customer.subscription.updated for a great many reasons and this flag stays
  // true on every one of them until the period ends, so this queue call runs
  // repeatedly during a cancellation. That is fine and is the design: the
  // sequence is keyed on (customer, template, subscription:period_end), so the
  // first call inserts and every later one conflicts and does nothing. Relying
  // on the constraint rather than on previous_attributes also survives the case
  // where the flag was set outside a webhook we saw at all.
  if (lifecycleQueueingEnabled()) {
    await maybeQueueCancellation(subscription, resolved.plan.id);
  }

  // Un-cancelled: they clicked "renew" in the portal before the period ended.
  // Kill the pending question and both win-backs. Cheap, and the alternative is
  // asking a paying customer why they left.
  if (lifecycleQueueingEnabled() && subscription.cancel_at_period_end === false && customerId) {
    await cancelOpenSequence({
      db: createServiceRoleClient(),
      stripeCustomerId: customerId,
      templates: ['cancel_ask', 'winback_14', 'winback_30'],
      reason: 'subscription_reactivated',
    });
  }
}

/**
 * Queue the cancellation question and the two win-backs, if this subscription
 * is on its way out.
 *
 * Split out of handleSubscriptionUpserted so that the entitlement path above
 * stays readable, and so that every failure in here is contained: this function
 * cannot throw, because it is called AFTER applyUserPlan has already written the
 * customer's plan and a throw would roll the webhook's ledger row back and
 * re-run that write.
 */
async function maybeQueueCancellation(
  subscription: Stripe.Subscription,
  planId: PlanId,
): Promise<void> {
  try {
    if (!subscription.cancel_at_period_end) return;

    const customerId =
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer.id;

    const db = createServiceRoleClient();
    const userId = await resolveUserId(
      db,
      customerId,
      subscription.metadata?.user_id ?? null,
    );

    // The customer object is retrieved rather than read off the event, because
    // the event is serialised at the ENDPOINT's pinned API version while the
    // SDK is pinned to a newer one, and the billing email address is the one
    // field here we cannot afford to read from the wrong shape.
    const email = await stripeCustomerEmail(customerId);
    const recipient = await resolveRecipient(db, email, userId);
    if (!recipient) {
      console.error(
        `[stripe-webhook] cancellation for ${customerId}: no usable recipient; nothing queued.`,
      );
      return;
    }

    const item = subscription.items.data[0];
    const periodEnd = item?.current_period_end ?? subscription.cancel_at ?? null;

    const payload: LifecyclePayload = {
      planId,
      amountCents: item?.price?.unit_amount ?? null,
      currency: subscription.currency ?? null,
      periodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      grandfathered: await isGrandfathered(db, userId),
    };

    await queueCancellationSequence({
      db,
      target: { stripeCustomerId: customerId, userId, recipient },
      subscriptionId: subscription.id,
      periodEndSeconds: periodEnd,
      payload,
    });
  } catch (err) {
    console.error('[stripe-webhook] maybeQueueCancellation failed, swallowed:', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

  // The subscription is gone, so any dunning still queued for it is now a lie:
  // "update your card and this carries on" is not true once there is nothing
  // left to carry on. The win-backs are deliberately NOT cancelled here, since
  // this event is exactly when a cancelled subscription reaches its end and the
  // win-back schedule starts to make sense.
  if (lifecycleQueueingEnabled() && customerId) {
    await cancelDunningForCustomer(
      createServiceRoleClient(),
      customerId,
      'subscription_deleted',
    );

    // And queue the cancellation series if nothing queued it already.
    //
    // The normal route in is `customer.subscription.updated` with
    // cancel_at_period_end = true, which covers a customer who cancels in the
    // portal. It does NOT cover a subscription deleted outright: cancelled
    // immediately from the dashboard, or closed by Stripe when the retries on a
    // dead card run out. Those customers passed through no cancel_at_period_end
    // state, so before this they received neither the question nor a win-back,
    // and churn from a dead card is precisely the churn a win-back is for.
    await maybeQueueCancellationOnDelete(subscription, customerId);
  }
}

/**
 * The cancellation series, queued from the DELETE event, for a subscription that
 * never advertised its cancellation in advance.
 *
 * Cannot throw, for the same reason maybeQueueCancellation cannot: it runs after
 * applyUserPlan has already written the plan, and a throw here would take the
 * webhook's ledger row with it and re-run that write.
 */
async function maybeQueueCancellationOnDelete(
  subscription: Stripe.Subscription,
  customerId: string,
): Promise<void> {
  try {
    const db = createServiceRoleClient();
    if (await hasCancellationSeries(db, customerId, subscription.id)) return;

    const userId = await resolveUserId(
      db,
      customerId,
      subscription.metadata?.user_id ?? null,
    );
    const recipient = await resolveRecipient(
      db,
      await stripeCustomerEmail(customerId),
      userId,
    );
    if (!recipient) {
      console.error(
        `[stripe-webhook] subscription.deleted ${subscription.id}: no usable recipient; nothing queued.`,
      );
      return;
    }

    const item = subscription.items.data[0];
    const resolved = item?.price?.id ? getPlanByStripePriceId(item.price.id) : null;

    // The period they paid for. `ended_at` is when the subscription actually
    // stopped, which for an immediate cancellation is now and for a
    // cancel-at-period-end is the period boundary. It is the honest anchor for
    // "14 days after you stopped having the product"; current_period_end is the
    // fallback for the events that carry one and no ended_at.
    const periodEnd =
      subscription.ended_at ?? item?.current_period_end ?? subscription.canceled_at ?? null;

    await queueCancellationSequence({
      db,
      target: { stripeCustomerId: customerId, userId, recipient },
      subscriptionId: subscription.id,
      periodEndSeconds: periodEnd,
      payload: {
        planId: resolved?.plan.id ?? null,
        amountCents: item?.price?.unit_amount ?? null,
        currency: subscription.currency ?? null,
        periodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
        grandfathered: await isGrandfathered(db, userId),
      },
    });
  } catch (err) {
    console.error('[stripe-webhook] maybeQueueCancellationOnDelete failed, swallowed:', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * invoice.payment_failed
 *
 * A charge on an invoice was declined. Starts the four-email dunning sequence.
 *
 * DOES NO ENTITLEMENT WORK, ON PURPOSE. The customer's plan and status are
 * already handled by the `customer.subscription.updated` that Stripe emits
 * alongside this (status -> past_due), and that path deliberately keeps a
 * failing customer ENTITLED while the card is retried. Duplicating any of that
 * here would give two events the ability to write the same state, which is the
 * class of bug the out-of-order guard exists to prevent. This handler queues
 * email and nothing else.
 *
 * WHAT IT REFUSES TO DUN
 *
 *   billing_reason !== subscription_cycle / subscription_update
 *     `subscription_create` is a card declined AT CHECKOUT. That person never
 *     had the product, is very likely still sitting on the checkout page
 *     watching the same error, and emailing them "your payment failed, your
 *     agent will lose inboxes 2 and 3" describes a subscription that never
 *     existed. It is a failed signup, not churn, and it belongs to a different
 *     piece of work.
 *
 *   collection_method !== charge_automatically
 *     A `send_invoice` customer is being billed by invoice, so there is no card
 *     to update and the entire sequence is wrong for them.
 *
 *   amount_due <= 0
 *     A $0 invoice cannot fail in a way the customer can fix, and the comped
 *     accounts are all $0.
 *
 *   next_payment_attempt === null AND attempt_count <= 1
 *     Stripe scheduled no retry and has barely tried. Rather than start a
 *     fourteen-day sequence on an invoice nothing is going to happen to, this
 *     falls through to the log. See the review notes: this case also means
 *     Smart Retries is off, which is a configuration problem, not an email one.
 */
async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  if (!lifecycleQueueingEnabled()) return;

  const customerId =
    typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;
  if (!customerId || !invoice.id) return;

  const reason = invoice.billing_reason;
  if (reason !== 'subscription_cycle' && reason !== 'subscription_update') {
    console.log(
      `[stripe-webhook] invoice.payment_failed ${invoice.id}: billing_reason=${reason}; not a renewal, no dunning.`,
    );
    return;
  }
  if (invoice.collection_method !== 'charge_automatically') {
    console.log(
      `[stripe-webhook] invoice.payment_failed ${invoice.id}: collection_method=${invoice.collection_method}; no card to fix, no dunning.`,
    );
    return;
  }
  if ((invoice.amount_due ?? 0) <= 0) {
    console.log(
      `[stripe-webhook] invoice.payment_failed ${invoice.id}: amount_due is 0; no dunning.`,
    );
    return;
  }
  // Stripe scheduled no retry and has barely tried. The whole sequence asserts
  // that "the card gets retried automatically over the next two weeks", so
  // starting it on an invoice nothing is going to happen to would put a
  // falsehood in four emails. Deliberately narrow: a null next_payment_attempt
  // on a SECOND or later attempt is the normal end of a retry schedule and
  // still deserves the sequence.
  if (invoice.next_payment_attempt == null && (invoice.attempt_count ?? 0) <= 1) {
    console.log(
      `[stripe-webhook] invoice.payment_failed ${invoice.id}: no retry scheduled after ${invoice.attempt_count ?? 0} attempt(s); no dunning. Check that Smart Retries is enabled.`,
    );
    return;
  }

  const db = createServiceRoleClient();

  // Resolve the owner through user_billing; an invoice carries no user_id.
  const userId = await resolveUserId(db, customerId, null);
  const recipient = await resolveRecipient(
    db,
    invoice.customer_email ?? (await stripeCustomerEmail(customerId)),
    userId,
  );
  if (!recipient) {
    console.error(
      `[stripe-webhook] invoice.payment_failed ${invoice.id}: no usable recipient; nothing queued.`,
    );
    return;
  }

  // The plan the failing invoice was for. Resolved from the price on the line
  // item, exactly as the subscription handlers do, so a legacy price still maps.
  const priceId = invoiceLinePriceId(invoice);
  const resolved = priceId ? getPlanByStripePriceId(priceId) : null;
  if (!resolved) {
    // Not fatal: the sequence is still worth sending, and the composer omits the
    // consequence sentence rather than guessing. Loud, though, because an
    // unresolved price means every email in this sequence names the wrong plan
    // unless the composer is given null, which is what happens here.
    console.error(
      `[stripe-webhook] invoice.payment_failed ${invoice.id}: could not resolve a plan from price ${priceId ?? 'none'}; queueing without a plan name.`,
    );
  }

  const payload: LifecyclePayload = {
    planId: resolved?.plan.id ?? null,
    amountCents: invoice.amount_due ?? null,
    currency: invoice.currency ?? null,
    declineCode: await invoiceDeclineCode(invoice),
    // The one-click "pay this exact invoice" page. Better than the billing
    // portal for a customer whose only problem is that one charge.
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    grandfathered: await isGrandfathered(db, userId),
  };

  await queueDunningSequence({
    db,
    target: { stripeCustomerId: customerId, userId, recipient },
    invoiceId: invoice.id,
    payload,
  });
}

/**
 * invoice.payment_succeeded
 *
 * THE STOP SIGNAL. Cancels every unsent dunning email for this invoice.
 *
 * This is the primary answer to "an email must never land after the charge
 * already succeeded": a retry that works on day 2 kills the day-3, day-7 and
 * day-14 emails before they are ever due. It is not the only answer, because
 * it depends on receiving an event, and the whole reason dunning did not exist
 * until now is that this endpoint was subscribed to no invoice events at all.
 * The dispatcher therefore re-reads the invoice from Stripe immediately before
 * every send and refuses to send against a paid one. Either mechanism alone is
 * sufficient; both are cheap.
 *
 * It also cancels the win-backs for this customer. A successful charge means
 * they are a paying customer again, whatever the subscription record said when
 * the sequence was queued.
 */
async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
  if (!lifecycleQueueingEnabled()) return;

  const customerId =
    typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;
  if (!customerId) return;

  const db = createServiceRoleClient();

  if (invoice.id) {
    await cancelOpenSequence({
      db,
      stripeCustomerId: customerId,
      scopeKey: invoice.id,
      reason: 'payment_recovered',
    });
  }

  await cancelOpenSequence({
    db,
    stripeCustomerId: customerId,
    templates: ['winback_14', 'winback_30'],
    reason: 'subscription_reactivated',
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The billing email Stripe holds for a customer.
 *
 * Retrieved rather than read off the event object. The live webhook endpoint is
 * pinned to an older API version than src/lib/stripe/client.ts, so an event
 * payload and this SDK's TypeScript types do not necessarily describe the same
 * shape. A retrieve goes through the SDK's own pinned version, which is the one
 * the types match. Never throws: no email is a skip, not a failure.
 */
async function stripeCustomerEmail(customerId: string): Promise<string | null> {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) return null;
    return customer.email ?? null;
  } catch (err) {
    console.error(`[stripe-webhook] could not retrieve customer ${customerId}:`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The issuer's decline code for a failed invoice, or null.
 *
 * Worth the extra API call because it is the difference between "your payment
 * failed" and "your bank said there was not enough in the account", and the
 * second one gets fixed in a minute while the first one gets ignored.
 *
 * IT HAS TO RETRIEVE, AND IT HAS TO EXPAND. Verified against a real declined
 * invoice in Stripe test mode on 2026-09-02: on the pinned API version an
 * invoice carries NEITHER `payment_intent` (removed after basil) NOR `payments`
 * unless `payments` is explicitly expanded. Reading the webhook's payload alone
 * therefore yields null every single time, which would have shipped a dunning
 * email that silently never explains why the card failed. The expanded path is:
 *
 *   invoice.payments.data[].payment.payment_intent.last_payment_error
 *
 * The event payload is still probed first, because it is free and because the
 * live endpoint is pinned to an OLDER API version than this SDK, where
 * `invoice.payment_intent` does exist.
 *
 * Never throws. A null here costs one sentence of copy; an exception here costs
 * the whole dunning sequence.
 */
async function invoiceDeclineCode(invoice: Stripe.Invoice): Promise<string | null> {
  try {
    // 1. The old shape, present when the endpoint is on an older API version.
    const raw = invoice as unknown as Record<string, unknown>;
    const direct = raw.payment_intent;
    let paymentIntentId: string | null = null;
    if (typeof direct === 'string') paymentIntentId = direct;
    else if (direct && typeof direct === 'object' && 'id' in direct) {
      paymentIntentId = String((direct as { id: unknown }).id);
    }
    if (paymentIntentId) {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      return declineFrom(intent.last_payment_error);
    }

    if (!invoice.id) return null;

    // 2. The current shape. One call: expanding through to the intent means the
    //    error is already on the object and no second retrieve is needed.
    const full = await stripe.invoices.retrieve(invoice.id, {
      expand: ['payments.data.payment.payment_intent'],
    });

    const payments = (full as unknown as { payments?: { data?: unknown[] } }).payments;
    for (const entry of payments?.data ?? []) {
      const payment = (entry as { payment?: Record<string, unknown> })?.payment;
      const intent = payment?.payment_intent;
      if (intent && typeof intent === 'object' && 'last_payment_error' in intent) {
        const code = declineFrom(
          (intent as { last_payment_error?: Stripe.PaymentIntent.LastPaymentError | null })
            .last_payment_error,
        );
        if (code) return code;
      }
    }
    return null;
  } catch (err) {
    console.error('[stripe-webhook] could not resolve decline code:', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * decline_code is the issuer's specific reason; code is Stripe's generic
 * classification. Prefer the specific one and accept either, because the copy
 * table only recognises the informative values and maps the rest to no reason
 * block at all.
 */
function declineFrom(
  error: Stripe.PaymentIntent.LastPaymentError | null | undefined,
): string | null {
  return error?.decline_code ?? error?.code ?? null;
}

/**
 * The price id on the first line of an invoice, across API versions.
 *
 * The live webhook endpoint is pinned to its own API version, which is not
 * necessarily the one src/lib/stripe/client.ts is pinned to, and the shape of a
 * line item changed: `line.pricing.price_details.price` is the current form and
 * `line.price` / `line.plan` are what older versions serialise. Reading only the
 * current form returns null on an older endpoint, and a null price id means a
 * null plan id, which the composer renders as "Personal" for every customer,
 * including a Team subscriber at $79.
 *
 * All three shapes are probed, most-current first, because the cost of being
 * wrong is naming the wrong plan in an email about money.
 */
function invoiceLinePriceId(invoice: Stripe.Invoice): string | null {
  const line = invoice.lines?.data?.[0] as unknown as Record<string, unknown> | undefined;
  if (!line) return null;

  const idOf = (value: unknown): string | null => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'id' in value) {
      const id = (value as { id: unknown }).id;
      return typeof id === 'string' ? id : null;
    }
    return null;
  };

  const pricing = line.pricing as { price_details?: { price?: unknown } } | undefined;
  return (
    idOf(pricing?.price_details?.price) ?? idOf(line.price) ?? idOf(line.plan) ?? null
  );
}

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
