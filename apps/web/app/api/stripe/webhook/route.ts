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
 *   invoice.payment_action_required   : the bank wants the renewal approved (SCA /
 *                                       3DS); start the confirm-the-payment dunning
 *   invoice.payment_succeeded         : a charge landed; STOP any dunning
 *   checkout.session.expired          : a checkout was left unpaid; one
 *                                       reminder email (or a holdout row), see
 *                                       src/lib/email/abandoned-checkout.ts
 *   checkout.session.async_payment_succeeded : a delayed first payment (SEPA
 *                                       Direct Debit) cleared; re-sync the plan
 *   checkout.session.async_payment_failed    : a delayed first payment failed;
 *                                       revoke the provisional access
 *   charge.dispute.created            : a SEPA debit was disputed; log only
 *
 * Delayed payment methods (added 2026-10-24, for the EUR launch):
 *   Stripe makes a SEPA Direct Debit subscription `active` while its first
 *   debit is still processing (up to six business days), and
 *   checkout.session.completed arrives with payment_status 'unpaid'. The buyer
 *   gets the plan at once anyway: PROVISIONAL ACCESS, decided 2026-10-24.
 *   Two things take it back if the money never arrives: the async_payment_failed
 *   handler, and the "never paid" rule in src/lib/stripe/sepa-entitlement.ts,
 *   which stops `past_due` / `unpaid` from keeping a SEPA subscription entitled
 *   when it has never had a paid invoice.
 *
 * Failed-payment state (added 2026-10-24, src/lib/billing/payment-issue.ts):
 *   `invoice.payment_failed` and `invoice.payment_action_required` store the
 *   decline code and mark every owned workspace (dashboard banner +
 *   once-a-day MCP note); a successful payment,
 *   a subscription back out of past_due/unpaid, or a deleted subscription
 *   clears it. Billing state only, never entitlement, and independent of the
 *   lifecycle email flag.
 *
 * Billing lifecycle email (added 2026-09-02):
 *   The four subscription events above still do all the entitlement work; the
 *   invoice events do NO entitlement work at all and exist only to start
 *   and stop email sequences. `invoice.payment_failed` materialises the
 *   four-email dunning sequence into `billing_email_sends`, and
 *   `invoice.payment_action_required` (added 2026-10-24) queues the same
 *   sequence with the decline code forced to `authentication_required`, so the
 *   emails ask the customer to approve the payment with their bank;
 *   `invoice.payment_succeeded` cancels whatever is still pending for that
 *   invoice, which is the primary guarantee that a "your payment failed" email
 *   never lands after the retry already worked.
 *
 *   `customer.subscription.updated` is EXTENDED rather than duplicated: when it
 *   carries a scheduled cancel (cancel_at_period_end = true OR cancel_at set;
 *   see cancellationAction in lifecycle-queue.ts) it also queues the one-question
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
 * Delivered through a queue (2026-09-20):
 *   Stripe points at a Queuey ingress, which verifies Stripe's signature with
 *   its Stripe signing template and forwards here. The body must cross the
 *   queue as RAW bytes under either scheme below — both hash exactly what was
 *   sent, and neither survives a re-serialisation.
 *
 *   Which signature THIS route checks depends on QUEUEY_SIGNING_SECRET:
 *     - unset  Stripe's forwarded `Stripe-Signature`, with a seven-day
 *              tolerance because a held replay carries its ORIGINAL timestamp.
 *              Needs the queue to map `Stripe-Signature` through.
 *     - set    Queuey's own `X-Queuey-*` HMAC, re-signed per delivery attempt,
 *              so ±5 minutes suffices. See src/lib/queuey/verify-delivery.ts.
 *   The variable is the rollout switch, not a feature flag: the queue must be
 *   signing before this route demands it. Unsetting it rolls back.
 *
 * References:
 *   src/lib/stripe/plans.ts  (plan catalogue, getPlanByStripePriceId)
 *   src/lib/stripe/client.ts (stripe SDK instance)
 *   src/lib/email/purchase-confirmation.ts (confirmation email composer + sender)
 */

import { NextRequest, NextResponse, after } from 'next/server';
import type Stripe from 'stripe';
import { stripe } from '@/lib/stripe/client';
import { isAccountDeletionCancellation } from '@/lib/stripe/cancel-on-account-delete';
import { accountState } from '@/lib/billing/deleted-account';
import { createServiceRoleClient } from '@/lib/supabase/service';
import {
  basePlanItem,
  getPlanByStripePriceId,
  PLANS,
  type BillingInterval,
  type PlanId,
} from '@/lib/stripe/plans';
import { syncMailboxAddon } from '@/lib/stripe/mailbox-addon';
import { recordFounderPlace, recordFounderPlaceFromInvoice } from '@/lib/stripe/founder-places';
import { hasPaidInvoice, neverPaidSepa } from '@/lib/stripe/sepa-entitlement';
import { markCheckoutLinkComplete } from '@/lib/stripe/checkout-link';
import { sendPurchaseConfirmationEmail } from '@/lib/email/purchase-confirmation';
import {
  creditAbandonedCheckout,
  remindAbandonedCheckout,
} from '@/lib/email/abandoned-checkout-send';
import {
  cancelDunningForCustomer,
  cancelOpenSequence,
  cancellationAction,
  cancellationSource,
  hasCancellationSeries,
  isGrandfathered,
  queueCancellationSequence,
  queueDunningSequence,
  resolveRecipient,
  resolveUserId,
} from '@/lib/billing/lifecycle-queue';
import {
  CONFIRM_PAYMENT_DECLINE_CODE,
  type LifecyclePayload,
} from '@/lib/email/billing-lifecycle';
import { lifecycleQueueingEnabled } from '@/lib/billing/lifecycle-mode';
import {
  clearPaymentIssue,
  hasPaymentIssue,
  PAYMENT_ISSUE_STATUSES,
  recordPaymentIssue,
} from '@/lib/billing/payment-issue';
import { invoiceLinePriceId, invoiceSubscriptionId } from '@/lib/billing/invoice-shape';
import {
  liftPlanLimitPauses,
  workspacesEnteringPaidPlan,
} from '@/lib/billing/plan-limit-pauses';
import {
  billingTarget,
  primaryWorkspaceId,
  recordCheckoutCompleted,
} from '@/lib/analytics/billing-funnel';
import { verifyQueueyDelivery } from '@/lib/queuey/verify-delivery';
import {
  PAUSED_STATUS,
  parkOwner,
  projectSubscription,
  readPlanChangeRow,
  unparkOwner,
  writePlanChangeColumns,
  type PlanChangeProjection,
  type PlanChangeRow,
} from '@/lib/billing/plan-change-sync';
import { PAUSE_EARLY_KEY } from '@/lib/billing/pause';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import { expireGrowthCache } from '@/lib/analytics/growth-queries';

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
 * Signature timestamp tolerance, in seconds. Default 7 days.
 *
 * WHY IT IS NOT STRIPE'S 300-SECOND DEFAULT.
 * Stripe no longer delivers here directly: a queue (Queuey) sits in front,
 * receives the signed request, and forwards it byte for byte. When our endpoint
 * is down that queue HOLDS the event and re-sends it later — after 30 seconds,
 * then minutes, then every ~30 minutes for about two days, and after that only
 * when a human resumes it. Every one of those replays carries the ORIGINAL
 * signature, because the signature is over the original bytes and the queue
 * must not touch them. With the 300-second default, every replay older than
 * five minutes fails verification as "timestamp outside tolerance" and returns
 * 400 — which the queue classifies as a PERMANENT failure and dead-letters
 * instead of retrying. The outage would eat the events it was installed to
 * protect.
 *
 * WHAT STILL STOPS A REPLAY. The tolerance was never the only defence and is
 * not the interesting one here. Section 2 inserts every event id into
 * `stripe_webhook_events` under a unique constraint, so a replayed event is a
 * no-op ack. Section 3 additionally ignores any event for a customer whose
 * `created` predates the newest event already processed for that customer, so
 * even a first-time-seen stale event cannot clobber newer subscription state.
 * Widening the window costs the ability to reject an old signature as old; it
 * costs nothing in state correctness.
 *
 * Read at call time, not captured at module scope — see the WHY on
 * BILLING_LIFECYCLE_EMAILS below; a warm lambda keeps whatever it booted with.
 */
const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 7 * 24 * 60 * 60;

function signatureToleranceSeconds(): number {
  const raw = process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS;
  if (!raw) return DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(
      `[stripe-webhook] STRIPE_WEBHOOK_TOLERANCE_SECONDS is not a positive number (${raw}); using the default.`,
    );
    return DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  }
  return parsed;
}

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

/**
 * Subscription statuses that should keep the user ENTITLED to their paid plan.
 *
 * One exception on top of this set: a `past_due` / `unpaid` subscription on
 * SEPA Direct Debit that has never had a paid invoice is NOT entitled. See
 * neverPaidSepa in src/lib/stripe/sepa-entitlement.ts, applied by the handlers.
 */
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
  // ── 1. Authenticate the request ───────────────────────────────────────────
  // The raw bytes come first, because BOTH schemes below hash exactly what was
  // sent and neither survives a parse/re-serialise round trip.
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

  // WHICH SCHEME, AND WHY IT IS A SWITCH RATHER THAN A REPLACEMENT.
  // Setting QUEUEY_SIGNING_SECRET moves authentication from Stripe's signature
  // (signed once, by Stripe) to Queuey's (re-signed on every delivery attempt).
  // Both cannot be cut over atomically: the queue has to be signing before this
  // route demands a signature, or every delivery is refused and dead-lettered.
  // So the variable IS the rollout — unset keeps today's behaviour exactly,
  // setting it flips the route, unsetting it rolls back without a code change.
  //
  // Once signing has been live long enough to trust, the Stripe branch and
  // signatureToleranceSeconds() come out and the seven-day window goes with
  // them: a Queuey signature on a two-day-old replay is minutes old, so ±5
  // minutes is enough and a captured delivery stops being replayable for a week.
  const queueySecret = process.env.QUEUEY_SIGNING_SECRET;

  let event: Stripe.Event;
  if (queueySecret) {
    const verdict = verifyQueueyDelivery({
      method: request.method,
      url: request.url,
      header: (name) => request.headers.get(name),
      rawBody,
      secret: queueySecret,
    });
    if (!verdict.ok) {
      // The reason goes to our logs and never to the caller: telling an
      // attacker which of the five checks they failed is free help.
      console.error(`[stripe-webhook] Queuey delivery rejected: ${verdict.failure}`);
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }
    try {
      event = JSON.parse(rawBody.toString('utf8')) as Stripe.Event;
    } catch {
      return NextResponse.json({ error: 'Malformed event body.' }, { status: 400 });
    }
    if (!event?.id || !event?.type) {
      return NextResponse.json({ error: 'Malformed event body.' }, { status: 400 });
    }
  } else {
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

    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        WEBHOOK_SECRET,
        signatureToleranceSeconds(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[stripe-webhook] Signature verification failed:', message);
      return NextResponse.json(
        { error: `Webhook signature verification failed: ${message}` },
        { status: 400 },
      );
    }
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

  // Measurement: why the subscription ended. Before the out-of-order guard so
  // a stale-skipped deletion is still counted. Never throws.
  if (event.type === 'customer.subscription.deleted') {
    await recordDeletionReason(supabase, event);
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
  // The `invoice.*` events are exempt for the same reason, and it is not a
  // theoretical concern: Stripe emits `customer.subscription.updated`
  // (status -> past_due) alongside `invoice.payment_failed` for the same
  // decline, with second-granularity timestamps that can land in either order.
  // If the subscription event won that race the invoice event would read as
  // stale and return here, and the dunning sequence would never be queued at
  // all. Exempting them is safe because neither one changes plan state: they
  // only start and stop email sequences, both keyed on the invoice id. They
  // also write the failed-payment banner state, which is not entitlement; a
  // late `payment_failed` re-reads the live invoice before it writes anything.
  //
  // `checkout.session.expired` changes no plan state either; it only decides
  // whether one reminder email goes out.
  //
  // The two `checkout.session.async_payment_*` events are exempt for the
  // reason checkout.session.completed is: each fires once per Checkout
  // session, and neither trusts its own payload for plan state. Both
  // re-retrieve the subscription from Stripe and write what it says NOW, so a
  // late delivery cannot write an old state. They also arrive days after the
  // purchase, beside a burst of invoice and subscription events with the same
  // second-granularity timestamps; reading as stale there would silently skip
  // the one event that revokes an unpaid SEPA buyer's access.
  //
  // `charge.dispute.created` carries no customer id, so the guard never runs
  // for it; listed for the reader, and because it only logs.
  const EXEMPT_FROM_STALENESS: ReadonlySet<string> = new Set([
    'checkout.session.completed',
    'checkout.session.expired',
    'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed',
    'charge.dispute.created',
    'invoice.payment_failed',
    'invoice.payment_action_required',
    'invoice.payment_succeeded',
    // Only retries the idempotent founder-place insert; no plan state.
    'invoice.paid',
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

      case 'checkout.session.async_payment_succeeded':
        await handleCheckoutAsyncPaymentSucceeded(
          event.data.object as Stripe.Checkout.Session,
        );
        break;

      case 'checkout.session.async_payment_failed':
        await handleCheckoutAsyncPaymentFailed(
          event.data.object as Stripe.Checkout.Session,
        );
        break;

      case 'charge.dispute.created':
        await handleChargeDisputeCreated(event.data.object as Stripe.Dispute);
        break;

      case 'checkout.session.expired': {
        // Post-response and never throws: a reminder email can neither delay
        // the ack nor roll back the ledger row.
        const expired = event.data.object as Stripe.Checkout.Session;
        after(() => remindAbandonedCheckout(expired));
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpserted(
          event.data.object as Stripe.Subscription,
        );
        // Billing state only, after the entitlement work, and never throws.
        await clearPaymentIssueIfRecovered(event.data.object as Stripe.Subscription);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.payment_action_required':
        await handleInvoicePaymentActionRequired(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
        retryFounderPlace(event.data.object as Stripe.Invoice);
        break;

      // Only the founder-place retry listens to this one; the lifecycle
      // handlers stay on invoice.payment_succeeded. Both are idempotent.
      case 'invoice.paid':
        retryFounderPlace(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.voided':
        // A paused subscription's renewal is finalized, then voided (Stripe
        // test T6). The void is the moment the paid period has rolled into
        // the pause, so it re-projects the subscription like the period-roll
        // subscription.updated does. Either event alone is enough.
        await handleInvoiceVoided(event.data.object as Stripe.Invoice);
        break;

      case 'customer.subscription.deleted': {
        const deleted = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(deleted);
        // Nothing left to pay for, so nothing left to warn about. Never throws.
        const deletedCustomer =
          typeof deleted.customer === 'string' ? deleted.customer : deleted.customer?.id;
        if (deletedCustomer) {
          await clearPaymentIssue(createServiceRoleClient(), {
            stripeCustomerId: deletedCustomer,
            source: 'customer.subscription.deleted',
          });
        }
        break;
      }

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

  // The growth board and kiosk cache their money reads for ten minutes. A
  // billing event is exactly the change the owner is looking for, so expire
  // them now instead of after the purchase email has long arrived.
  if (GROWTH_EVENT_TYPES.has(event.type)) expireGrowthCache(`stripe:${event.type}`);

  return NextResponse.json({ received: true }, { status: 200 });
}

/** Stripe events that move a number on the growth board or the kiosk. */
const GROWTH_EVENT_TYPES = new Set([
  'invoice.voided',
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
]);

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
 *
 * A SEPA Direct Debit purchase arrives here with payment_status 'unpaid' and an
 * `active` subscription, and is granted the plan like any other (provisional
 * access; see the file header). Its funnel row and purchase email go out now,
 * not when the debit clears.
 */
async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const synced = await syncPlanFromCheckoutSession(session, 'checkout.session.completed');
  if (!synced) return;
  const { userId, resolvedPlan, resolvedInterval } = synced;

  if (resolvedPlan === 'free') return;
  // Bound once, narrowed, for the `after()` closures below.
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
  // Credit an abandoned-checkout reminder (or its holdout row) with this
  // purchase, for the holdout comparison. Post-response, never throws.
  after(() => creditAbandonedCheckout(session));
  // The chat checkout link this session came from, if any: stamp it paid for
  // the experiment read-out. Post-response and never throws, so it cannot cost
  // anyone the plan that was just granted above.
  if (session.metadata?.checkout_link_id) {
    after(() => markCheckoutLinkComplete(session.metadata?.checkout_link_id));
  }

  const recipient = session.customer_details?.email ?? session.customer_email ?? null;
  if (recipient) {
    after(() =>
      sendPurchaseConfirmationEmail({
        to: recipient,
        planId: purchasedPlan,
        interval,
        amountTotalCents: session.amount_total ?? null,
        currency: session.currency ?? null,
        // Set when Adaptive Pricing charged the buyer in their local currency;
        // amount_total/currency above stay in our USD integration currency.
        presentment: session.presentment_details
          ? {
            amountCents: session.presentment_details.presentment_amount,
            currency: session.presentment_details.presentment_currency,
          }
          : null,
        sessionId: session.id,
        // 'unpaid' for a delayed method (SEPA Direct Debit): the email then
        // says the debit is processing instead of "payment received".
        paymentStatus: session.payment_status ?? null,
      }),
    );
  } else {
    console.error(
      `[stripe-webhook] checkout.session.completed ${session.id}: no email on the session; confirmation email skipped.`,
    );
  }
}

/**
 * The plan half of a completed Checkout session: resolve the plan the session
 * paid for from the subscription Stripe holds NOW, and write it with
 * applyUserPlan. Shared by checkout.session.completed and
 * checkout.session.async_payment_succeeded, so the two can never disagree about
 * what a session entitles. Idempotent: it writes the current state, so running
 * it twice for the same session writes the same row twice.
 *
 * Returns null when there is nothing to sync (not a subscription session, or
 * no usable plan id in its metadata).
 */
async function syncPlanFromCheckoutSession(
  session: Stripe.Checkout.Session,
  source: string,
): Promise<{
  userId: string | null;
  resolvedPlan: PlanId | 'free';
  resolvedInterval: BillingInterval | null;
} | null> {
  if (session.mode !== 'subscription') return null;

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
      `[stripe-webhook] ${source} bad/missing plan_id "${rawPlanId}" (session ${session.id})`,
    );
    return null;
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
        basePlanItem(subscription.items.data)?.current_period_end ?? null;
      currentPeriodStart =
        basePlanItem(subscription.items.data)?.current_period_start ?? null;

      // Prefer the price the customer actually subscribed to over the metadata
      // plan_id (they should agree, but the subscription is authoritative).
      const priceId = basePlanItem(subscription.items.data)?.price?.id;
      const resolved = getPlanByStripePriceId(priceId);
      if (resolved) {
        resolvedPlan = resolved.plan.id;
        resolvedInterval = resolved.interval;
      } else if (priceId) {
        console.error(
          `[stripe-webhook] ${source}: price "${priceId}" on sub ${subscriptionId} does not map to a known plan; using metadata plan_id "${planId}" (session ${session.id})`,
        );
      }

      // If the subscription is NOT entitled (e.g. incomplete), do not grant the
      // paid plan; downgrade to free and persist the raw status for visibility.
      // The same holds for a SEPA subscription in dunning that never paid.
      if (
        !ENTITLED_STATUSES.has(subscription.status) ||
        (await neverPaidSepa(stripe, subscription))
      ) {
        resolvedPlan = 'free';
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[stripe-webhook] ${source}: failed to retrieve subscription ${subscriptionId}: ${message}. Falling back to session.payment_status.`,
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
    source,
    offer: session.metadata?.offer ?? null,
  });

  return { userId, resolvedPlan, resolvedInterval };
}

/**
 * checkout.session.async_payment_succeeded
 *
 * The delayed first payment of a Checkout session cleared: in practice a SEPA
 * Direct Debit, about six business days after the purchase. The buyer has had
 * the plan since checkout.session.completed (provisional access), so this
 * changes nothing in the normal case. It re-syncs anyway, through the same
 * path checkout.session.completed uses, because it is the one event that says
 * "this purchase is now paid", and it would repair a plan that a past_due
 * blip in between had taken away. No funnel row and no email: both went out
 * at completion, and this must not count the purchase twice.
 */
async function handleCheckoutAsyncPaymentSucceeded(
  session: Stripe.Checkout.Session,
): Promise<void> {
  console.log(
    `[stripe-webhook] checkout.session.async_payment_succeeded ${session.id}: delayed payment cleared (customer ${customerIdOf(session) ?? 'none'}).`,
  );
  await syncPlanFromCheckoutSession(session, 'checkout.session.async_payment_succeeded');
}

/**
 * checkout.session.async_payment_failed
 *
 * The delayed first payment of a Checkout session failed: the bank refused the
 * SEPA debit (no funds, closed account, mandate refused). The buyer has had
 * the plan since checkout.session.completed, provisionally. If the
 * subscription has never had a paid invoice, that access ends here, through
 * applyUserPlan like every other downgrade. A subscription that has a paid
 * invoice (the buyer paid the open invoice some other way in the meantime)
 * keeps its plan.
 *
 * Errors throw on purpose, unlike the fail-open entitlement check: the route
 * then answers 500 and Stripe redelivers, and a retried downgrade is harmless
 * where a silently skipped one leaves an unpaid account on a paid plan.
 */
async function handleCheckoutAsyncPaymentFailed(
  session: Stripe.Checkout.Session,
): Promise<void> {
  if (session.mode !== 'subscription') return;
  const customerId = customerIdOf(session);
  const subscriptionId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id ?? null;

  console.error(
    `[stripe-webhook] checkout.session.async_payment_failed ${session.id}: delayed first payment failed (customer ${customerId ?? 'none'}, subscription ${subscriptionId ?? 'none'}).`,
  );
  if (!subscriptionId) return;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const paid = await hasPaidInvoice(stripe, subscription.id);
  if (paid === null) {
    throw new Error(
      `checkout.session.async_payment_failed ${session.id}: could not tell whether ${subscription.id} ever paid; retry.`,
    );
  }

  if (ENTITLED_STATUSES.has(subscription.status) && paid) {
    console.log(
      `[stripe-webhook] checkout.session.async_payment_failed ${session.id}: ${subscription.id} has a paid invoice (status=${subscription.status}); plan kept.`,
    );
    return;
  }

  await applyUserPlan({
    userId: session.metadata?.user_id ?? subscription.metadata?.user_id ?? null,
    customerId,
    subscriptionId: subscription.id,
    newPlan: 'free',
    subscriptionStatus: subscription.status,
    source: `checkout.session.async_payment_failed (status=${subscription.status}, never paid)`,
  });
}

/**
 * charge.dispute.created, for SEPA Direct Debit only.
 *
 * A SEPA payer can dispute a debit with no questions asked for eight weeks
 * (thirteen months if they say it was unauthorized), and the dispute is final:
 * there is no evidence to submit. This logs one loud line so the owner can
 * look at the workspace; it does not downgrade anyone, because a disputed
 * renewal is not proof the customer wants to leave, and a dispute filed by
 * mistake is withdrawn by paying again. Card disputes are left to the Stripe
 * dashboard as before.
 *
 * Never throws: a log line is not worth a 500 and a redelivery.
 */
async function handleChargeDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
  try {
    const chargeId =
      typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id ?? null;
    // The dispute names its own method for a few types (card, klarna, paypal),
    // never for SEPA, so a type on the dispute that is not SEPA ends it here.
    const disputeType = dispute.payment_method_details?.type ?? null;
    if (disputeType && disputeType !== 'sepa_debit') return;

    let charge: Stripe.Charge | null =
      typeof dispute.charge === 'object' && dispute.charge ? dispute.charge : null;
    if (!charge && chargeId) charge = await stripe.charges.retrieve(chargeId);
    if (charge?.payment_method_details?.type !== 'sepa_debit') return;

    const customerId =
      typeof charge.customer === 'string' ? charge.customer : charge.customer?.id ?? null;
    console.error(
      `[stripe-webhook] SEPA DISPUTE ${dispute.id} on charge ${chargeId ?? 'none'} (customer ${customerId ?? 'none'}): ${dispute.amount} ${dispute.currency}, reason=${dispute.reason}. SEPA disputes are final; review this account by hand. No plan change made.`,
    );
  } catch (err) {
    console.error('[stripe-webhook] charge.dispute.created %s: could not inspect the charge:', dispute.id, {
      error: err instanceof Error ? err.message : String(err),
    });
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
  //
  // Not entitled: canceled / incomplete / incomplete_expired / paused, and a
  // SEPA subscription in past_due / unpaid that has never had a paid invoice
  // (sepa-entitlement.ts). Downgrade to free but keep the raw status for
  // visibility. The SEPA check makes no Stripe call outside past_due / unpaid.
  const neverPaid = ENTITLED_STATUSES.has(status) && (await neverPaidSepa(stripe, subscription));
  if (!ENTITLED_STATUSES.has(status) || neverPaid) {
    await applyUserPlan({
      userId,
      customerId,
      subscriptionId: subscription.id,
      newPlan: 'free',
      subscriptionStatus: status,
      source: `customer.subscription.updated (status=${status}${neverPaid ? ', SEPA never paid' : ''})`,
    });
    return;
  }

  // Entitled — resolve which paid plan from the price ID.
  const priceId = basePlanItem(subscription.items.data)?.price?.id;
  if (!priceId) {
    console.error(
      '[stripe-webhook] subscription has no price ID on its plan item:',
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
      currentPeriodStart: basePlanItem(subscription.items.data)?.current_period_start ?? null,
      currentPeriodEnd: basePlanItem(subscription.items.data)?.current_period_end ?? null,
      source: `customer.subscription.upserted (unmapped price ${priceId})`,
    });
    return;
  }

  // ── Pause and pending downgrade ──────────────────────────────────────────
  //
  // `status` stays 'active' through a Stripe pause, so the price alone would
  // keep a paused customer on the paid plan for free. projectSubscription
  // decides the entitlement first: paused = Free; a downgrade booked for the
  // period end = the plan it came from until then. The stored row is read
  // BEFORE the write, so the transitions (resumed, downgrade landed) are
  // visible. See src/lib/billing/plan-change-sync.ts.
  const projection = projectSubscription(subscription, resolved.plan.id);
  const planChangeDb = createServiceRoleClient();
  const ownerId = await resolveUserId(planChangeDb, customerId, userId);
  const before = ownerId ? await readPlanChangeRow(planChangeDb, ownerId) : null;

  await applyUserPlan({
    userId,
    customerId,
    subscriptionId: subscription.id,
    newPlan: projection.grantPlan,
    subscriptionStatus: projection.status,
    currentPeriodStart: basePlanItem(subscription.items.data)?.current_period_start ?? null,
    currentPeriodEnd: basePlanItem(subscription.items.data)?.current_period_end ?? null,
    source:
      projection.status === PAUSED_STATUS
        ? 'customer.subscription.upserted (paused)'
        : projection.downgrade.state === 'pending'
          ? 'customer.subscription.upserted (downgrade pending)'
          : 'customer.subscription.upserted',
    offer: subscription.metadata?.offer ?? null,
  });

  if (ownerId) {
    await syncPlanChange(ownerId, subscription, projection, before);
  }

  // Business bills mailboxes past ten as a second item. Re-sync it on every
  // Business subscription event: it covers a mailbox connected while a plan
  // change was in flight, and the update this may make comes back here as a
  // no-op (the sync compares before it writes). After the response, and it
  // cannot throw, so the plan write above keeps its ledger row.
  if (resolved.plan.id === 'pro') {
    const ownerId = userId;
    after(async () => {
      const owner = ownerId ?? (await resolveUserId(createServiceRoleClient(), customerId, null));
      if (owner) await syncMailboxAddon(owner);
      // A paid subscription on the founder price takes its place in the
      // counter and gets the cohort tag. No-op for any other price.
      await recordFounderPlace({
        db: createServiceRoleClient(),
        subscription,
        ownerId: owner,
        tagSubscription: (id, metadata) => stripe.subscriptions.update(id, { metadata }),
      });
    });
  }

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
  //
  // "Scheduled to stop" is EITHER field: Stripe's portal and dashboard now set
  // `cancel_at` to the period end and leave `cancel_at_period_end` false.
  // Reading the boolean alone skipped the queue for those customers and then
  // ran the un-cancel branch below against them.
  const cancellation = cancellationAction(subscription);
  if (lifecycleQueueingEnabled() && cancellation === 'queue') {
    await maybeQueueCancellation(subscription, resolved.plan.id);
  }

  // Un-cancelled: they clicked "renew" in the portal before the period ended,
  // which clears whichever field was set. Kill the pending question and both
  // win-backs. Cheap, and the alternative is asking a paying customer why they
  // left.
  if (lifecycleQueueingEnabled() && cancellation === 'cancel_open' && customerId) {
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
    if (cancellationAction(subscription) !== 'queue') return;

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
    if ((await accountState(db, userId)) === 'deleted') {
      console.log(`[stripe-webhook] cancellation for ${customerId}: account deleted; nothing queued.`);
      return;
    }

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

    const item = basePlanItem(subscription.items.data);
    const periodEnd = item?.current_period_end ?? subscription.cancel_at ?? null;

    const payload: LifecyclePayload = {
      planId,
      amountCents: item?.price?.unit_amount ?? null,
      currency: subscription.currency ?? null,
      periodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      grandfathered: await isGrandfathered(db, userId),
      // "Switch to Free" on the billing card: the cancel email leaves out the
      // "switch to a cheaper plan" line for it.
      source: cancellationSource(subscription.metadata, periodEnd),
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

  await clearPlanChangeOnDelete(subscription, customerId, userId);

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
    // The normal route in is `customer.subscription.updated` with a scheduled
    // cancel (cancel_at_period_end = true or cancel_at set), which covers a customer who cancels in the
    // portal. It does NOT cover a subscription deleted outright: cancelled
    // immediately from the dashboard, or closed by Stripe when the retries on a
    // dead card run out. Those customers passed through no scheduled-cancel
    // state, so before this they received neither the question nor a win-back,
    // and churn from a dead card is precisely the churn a win-back is for.
    //
    // Except when the customer deleted their account: delete-account cancels
    // the subscription itself, and asking someone who just deleted everything
    // why they left, then trying to win them back, is mail they did not want.
    if (!isAccountDeletionCancellation(subscription)) {
      await maybeQueueCancellationOnDelete(subscription, customerId);
    }
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
    // The comment check in the caller only covers a cancel that delete-account
    // made. One made from the dashboard (or by Stripe) on an account that was
    // already deleted carries no comment. 'unknown' still queues: the
    // dispatcher asks again before it sends.
    if ((await accountState(db, userId)) === 'deleted') {
      console.log(
        `[stripe-webhook] subscription.deleted ${subscription.id}: account deleted; nothing queued.`,
      );
      return;
    }
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

    const item = basePlanItem(subscription.items.data);
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
 * email and records the failed-payment banner state (decline code and the
 * workspaces.payment_issue_* markers), which no entitlement check reads.
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
 *     EXCEPT for `authentication_required` (SCA / 3DS): the customer's bank
 *     wants them to approve the charge, no retry can ever do that, and a null
 *     next_payment_attempt after one attempt is normal there. It is the case
 *     that needs a human most, and its copy promises no retry, so it is queued.
 */
async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  await queueDunningForInvoice(invoice, { eventType: 'invoice.payment_failed' });
}

/**
 * invoice.payment_action_required
 *
 * The renewal needs the customer to approve it with their bank (EU SCA /
 * 3DS). Same gates and same sequence as invoice.payment_failed, with the
 * decline code forced to `authentication_required`, so the emails say
 * "confirm the payment" instead of "update the card".
 *
 * Stripe usually sends invoice.payment_failed for the same invoice too, in
 * either order. Both key their rows (stripe_customer_id, template,
 * scope_key = invoice id), and the insert is ON CONFLICT DO NOTHING
 * (`ignoreDuplicates` in lifecycle-queue.ts), so whichever event lands first
 * writes the four rows and the second inserts nothing. The second never
 * overwrites the first one's payload. That is fine in both orders: the
 * payment_failed for an SCA charge carries `authentication_required` as its
 * own decline code, so both events normally freeze the same payload.
 */
async function handleInvoicePaymentActionRequired(invoice: Stripe.Invoice): Promise<void> {
  await queueDunningForInvoice(invoice, {
    eventType: 'invoice.payment_action_required',
    declineCode: CONFIRM_PAYMENT_DECLINE_CODE,
  });
}

/**
 * The one dunning path behind both invoice events. Every gate described on
 * handleInvoicePaymentFailed lives here, once.
 */
async function queueDunningForInvoice(
  invoice: Stripe.Invoice,
  options: { eventType: string; declineCode?: string },
): Promise<void> {
  // NOT gated on lifecycleQueueingEnabled() here: the failed-payment state
  // below is written whether or not lifecycle email is on.
  const tag = [options.eventType, invoice.id] as const;

  const customerId =
    typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;
  if (!customerId || !invoice.id) return;

  // A paused subscription's renewals are voided, never dunned (Stripe T6:
  // finalized, then voided, no charge attempt). Guarded anyway: a "your
  // payment failed" email to someone who paused is the worst outcome here.
  if (invoice.status === 'void') {
    console.log(`[stripe-webhook] invoice.payment_failed ${invoice.id}: invoice is void; no dunning.`);
    return;
  }

  const reason = invoice.billing_reason;
  if (reason !== 'subscription_cycle' && reason !== 'subscription_update') {
    console.log('[stripe-webhook] %s %s: billing_reason=%s; not a renewal, no dunning.', ...tag, reason);
    return;
  }
  if (invoice.collection_method !== 'charge_automatically') {
    console.log(
      '[stripe-webhook] %s %s: collection_method=%s; no card to fix, no dunning.', ...tag, invoice.collection_method,
    );
    return;
  }
  if ((invoice.amount_due ?? 0) <= 0) {
    console.log('[stripe-webhook] %s %s: amount_due is 0; no dunning.', ...tag);
    return;
  }

  // Resolved before the retry guard, because the guard depends on it.
  const failed = options.declineCode
    ? { declineCode: options.declineCode, paymentMethodId: null }
    : await invoiceFailedAttempt(invoice);
  const declineCode = failed.declineCode;

  // The failed-payment STATE (dashboard banner + once-a-day MCP note), for
  // both invoice.payment_failed and invoice.payment_action_required. It runs
  // whether or not lifecycle email is on, and before the retry guard below on
  // purpose: an SCA invoice often has no retry scheduled, and that customer is
  // the one who most needs to be told. Billing state only, never throws.
  await recordPaymentIssueForInvoice(invoice, customerId, declineCode);

  if (!lifecycleQueueingEnabled()) return;

  // Stripe scheduled no retry and has barely tried. The ordinary sequence
  // asserts that "the card gets retried automatically over the next two weeks",
  // so starting it on an invoice nothing is going to happen to would put a
  // falsehood in four emails. Deliberately narrow: a null next_payment_attempt
  // on a SECOND or later attempt is the normal end of a retry schedule and
  // still deserves the sequence. Never applied to a bank approval (SCA): no
  // retry can approve it, and that copy promises none.
  if (
    declineCode !== CONFIRM_PAYMENT_DECLINE_CODE &&
    invoice.next_payment_attempt == null &&
    (invoice.attempt_count ?? 0) <= 1
  ) {
    console.log(
      '[stripe-webhook] %s %s: no retry scheduled after %d attempt(s); no dunning. Check that Smart Retries is enabled.', ...tag, invoice.attempt_count ?? 0,
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
    console.error('[stripe-webhook] %s %s: no usable recipient; nothing queued.', ...tag);
    return;
  }

  // The plan the failing invoice was for. Resolved from the price on the line
  // item, exactly as the subscription handlers do, so a legacy price still maps.
  // invoiceLinePriceId prefers the charged line over an upgrade's credit line
  // on the old price. When no line maps to a plan, the subscription's own plan
  // item is the fallback.
  let priceId = invoiceLinePriceId(invoice);
  let resolved = priceId ? getPlanByStripePriceId(priceId) : null;
  const invoiceSubscription = resolved ? null : invoiceSubscriptionId(invoice);
  if (invoiceSubscription) {
    try {
      const subscription = await stripe.subscriptions.retrieve(invoiceSubscription);
      const basePriceId = basePlanItem(subscription.items.data)?.price?.id ?? null;
      const fromBase = basePriceId ? getPlanByStripePriceId(basePriceId) : null;
      if (fromBase) {
        priceId = basePriceId;
        resolved = fromBase;
      }
    } catch {
      // Logged below as unresolved; the sequence still goes out.
    }
  }
  if (!resolved) {
    // Not fatal: the sequence is still worth sending, and the composer omits the
    // consequence sentence rather than guessing. Loud, though, because an
    // unresolved price means every email in this sequence names the wrong plan
    // unless the composer is given null, which is what happens here.
    console.error(
      '[stripe-webhook] %s %s: could not resolve a plan from price %s; queueing without a plan name.', ...tag, priceId ?? 'none',
    );
  }

  const payload: LifecyclePayload = {
    planId: resolved?.plan.id ?? null,
    amountCents: invoice.amount_due ?? null,
    currency: invoice.currency ?? null,
    declineCode,
    // Not shown to anyone: recoveredBy compares it with the method that pays.
    failedPaymentMethodId: failed.paymentMethodId,
    // The one-click "pay this exact invoice" page. Better than the billing
    // portal for a customer whose only problem is that one charge, and for a
    // bank approval it is the page that runs the 3DS challenge.
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
/**
 * A paid invoice on the Business founder price records its place again (an
 * idempotent no-op once the row exists), so a place whose first insert failed
 * after a subscription event is recovered on the next payment. After the
 * response, and it cannot throw.
 */
function retryFounderPlace(invoice: Stripe.Invoice): void {
  after(() =>
    recordFounderPlaceFromInvoice({
      db: createServiceRoleClient(),
      invoice,
      retrieveSubscription: (id) => stripe.subscriptions.retrieve(id),
      resolveOwner: async (subscription) => {
        const customerId =
          typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
        return resolveUserId(createServiceRoleClient(), customerId, subscription.metadata?.user_id ?? null);
      },
      tagSubscription: (id, metadata) => stripe.subscriptions.update(id, { metadata }),
    }),
  );
}

async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
  const customerId =
    typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;
  if (!customerId) return;

  const db = createServiceRoleClient();

  // The payment went through: the banner and the MCP note stop. Independent of
  // the lifecycle email flag, and never throws.
  await clearPaymentIssue(db, {
    stripeCustomerId: customerId,
    source: 'invoice.payment_succeeded',
  });

  if (!lifecycleQueueingEnabled()) return;

  if (invoice.id) {
    const cancelled = await cancelOpenSequence({
      db,
      stripeCustomerId: customerId,
      scopeKey: invoice.id,
      reason: 'payment_recovered',
    });
    // Measurement only (/admin/growth/dunning): who fixed it. Only when this
    // event is what closed a live sequence, so a redelivery or an invoice that
    // was never dunned costs no Stripe call. Never throws.
    if (cancelled > 0) await recordRecoveredBy(db, customerId, invoice.id);
  }

  await cancelOpenSequence({
    db,
    stripeCustomerId: customerId,
    templates: ['winback_14', 'winback_30'],
    reason: 'subscription_reactivated',
  });
}

/**
 * The pause / downgrade half of a subscription event, after the plan write.
 *
 * Writes the user_billing pause and downgrade columns, parks inboxes when the
 * plan has just dropped (pause running, downgrade landed), unparks them when
 * it comes back, and records the transitions. The column write and the
 * transition rows are skipped before migration 20261024233000 is applied
 * (`before` is null); parking for a running pause still happens, because it
 * only needs the parking columns.
 *
 * CANNOT THROW (every call below is non-throwing and the body is guarded): it
 * runs after applyUserPlan, and a throw would roll back the ledger row and
 * make Stripe re-deliver a plan write that already happened. Same pattern as
 * liftPlanLimitPauses.
 */
async function syncPlanChange(
  ownerId: string,
  subscription: Stripe.Subscription,
  projection: PlanChangeProjection,
  before: PlanChangeRow | null,
): Promise<void> {
  try {
    const db = createServiceRoleClient();
    const involved =
      projection.pause.state !== 'none' ||
      projection.downgrade.state !== 'none' ||
      Boolean(before?.paused_from) ||
      Boolean(before?.pending_plan) ||
      before?.subscription_status === PAUSED_STATUS;
    const keepOrder = before?.inbox_keep_order ?? null;
    const label = `webhook ${subscription.id}`;

    if (before && involved) {
      await writePlanChangeColumns(db, ownerId, projection.columns);
    }

    if (projection.parkTo) {
      await parkOwner(db, ownerId, projection.parkTo, keepOrder, label);
    } else if (
      projection.unpark &&
      (involved || (before !== null && planRankOf(projection.grantPlan) > planRankOf(before.plan)))
    ) {
      await unparkOwner(db, ownerId, projection.grantPlan, keepOrder, label);
    }

    if (!before) return;
    const workspaceId = await primaryWorkspaceId(db, ownerId);
    if (!workspaceId) return;

    // The pause ended by itself (Stripe cleared pause_collection). A resume
    // the customer asked for early is recorded by the route instead.
    if (
      before.subscription_status === PAUSED_STATUS &&
      projection.status !== PAUSED_STATUS &&
      subscription.metadata?.[PAUSE_EARLY_KEY] !== '1'
    ) {
      await recordProductFunnelEvent(db, { workspaceId, stage: 'pause_resumed', outcome: 'success', category: 'auto' });
    }

    // The downgrade landed: the closing row of the plan_downgraded that the
    // route opened as `started` at confirm time.
    if (before.pending_plan && projection.downgrade.state === 'effective') {
      const interval: BillingInterval =
        basePlanItem(subscription.items.data)?.price?.recurring?.interval === 'year' ? 'year' : 'month';
      const target = projection.grantPlan;
      if (target !== 'free') {
        // The same row recordPlanChange writes, through the writer itself:
        // this file's other billing-funnel imports are all it needs from there.
        await recordProductFunnelEvent(db, {
          workspaceId,
          stage: 'plan_downgraded',
          outcome: 'success',
          category: billingTarget(target, interval),
        });
      }
    }
  } catch (err) {
    console.error('[stripe-webhook] syncPlanChange failed, swallowed:', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Ladder position for "did the plan go up". Unknown and free are 0. */
function planRankOf(plan: string | null | undefined): number {
  return plan === 'personal' ? 1 : plan === 'solo' ? 2 : plan === 'pro' ? 3 : 0;
}

/**
 * A subscription ended. If it was paused or had a downgrade pending, the
 * columns are cleared, and a pause that ended in a cancel is recorded as such
 * (a pause is not churn; a pause that ends in a cancel is, at this moment).
 * Inboxes parked by the pause stay parked: the owner is on Free now.
 * Cannot throw, for the same reason as syncPlanChange.
 */
async function clearPlanChangeOnDelete(
  subscription: Stripe.Subscription,
  customerId: string | null,
  metadataUserId: string | null,
): Promise<void> {
  try {
    if (!customerId) return;
    const db = createServiceRoleClient();
    const ownerId = await resolveUserId(db, customerId, metadataUserId);
    if (!ownerId) return;
    const before = await readPlanChangeRow(db, ownerId);
    if (!before || (!before.paused_from && !before.pending_plan)) return;
    await writePlanChangeColumns(db, ownerId, {
      paused_from: null,
      pause_resumes_at: null,
      pending_plan: null,
      pending_plan_effective_at: null,
    });
    if (before.paused_from) {
      const workspaceId = await primaryWorkspaceId(db, ownerId);
      const item = basePlanItem(subscription.items.data);
      const plan = item?.price?.id ? getPlanByStripePriceId(item.price.id)?.plan.id ?? null : null;
      if (workspaceId) {
        await recordProductFunnelEvent(db, {
          workspaceId,
          stage: 'pause_ended_cancelled',
          outcome: 'success',
          category: plan ?? 'unknown',
        });
      }
    }
  } catch (err) {
    console.error('[stripe-webhook] clearPlanChangeOnDelete failed, swallowed:', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * invoice.voided: re-project the subscription when it carries a pause or a
 * pending downgrade. Any other voided invoice changes nothing. The invoice's
 * subscription id sits in `parent.subscription_details` on current API
 * versions and at the top level on older ones; the endpoint is pinned older
 * than the SDK, so both are read.
 */
async function handleInvoiceVoided(invoice: Stripe.Invoice): Promise<void> {
  const shape = invoice as unknown as {
    subscription?: string | { id: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null;
  };
  const raw = shape.parent?.subscription_details?.subscription ?? shape.subscription ?? null;
  const subscriptionId = typeof raw === 'string' ? raw : raw?.id ?? null;
  if (!subscriptionId) return;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const meta = subscription.metadata ?? {};
  const relevant =
    Boolean(subscription.pause_collection?.behavior) ||
    Boolean(meta.mcpe_pause_from) ||
    Boolean(meta.mcpe_downgrade_effective_at);
  if (!relevant) return;
  await handleSubscriptionUpserted(subscription);
}

// ---------------------------------------------------------------------------
// Who fixed it: recovered_by on a recovered dunning sequence
// ---------------------------------------------------------------------------

const DUNNING_TEMPLATE_LIST = ['dunning_1', 'dunning_3', 'dunning_7', 'dunning_14'] as const;

type RecoveredBy = 'customer' | 'retry' | 'unknown';

/**
 * Did the customer act, or did Stripe's own retry get the money?
 *
 * THE HEURISTIC, from one invoice retrieve expanded through to the paying
 * charge (payments.data.payment.payment_intent.latest_charge):
 *
 *   1. The paying charge ran 3-D Secure (payment_method_details.card.
 *      three_d_secure is set) -> 'customer'. A 3DS check needs the cardholder
 *      in a browser, which an off-session retry never has; this is the bank
 *      approval (SCA) case and the hosted invoice page with a 3DS card.
 *   2. The paying payment method differs from the one on the failed attempt
 *      (failedPaymentMethodId, stored in the dunning payload at decline time)
 *      -> 'customer'. A card typed on the hosted invoice page or saved in the
 *      portal is a new pm_ id, even when it is the same physical card.
 *   3. Same payment method, no 3DS -> 'retry'.
 *   4. Anything not known (no stored failed method, no succeeded intent on the
 *      invoice, or a Stripe error) -> 'unknown'.
 *
 * Its one blind spot: a customer who tops up the account and waits for the
 * retry reads as 'retry'. Stripe records no "paid from the hosted page" flag
 * on the charge, so the payment method is the strongest signal one retrieve
 * gives. Never throws.
 */
async function recoveredBy(
  invoiceId: string,
  failedPaymentMethodId: string | null,
): Promise<RecoveredBy> {
  try {
    const full = await stripe.invoices.retrieve(invoiceId, {
      expand: ['payments.data.payment.payment_intent.latest_charge'],
    });
    const payments = (full as unknown as { payments?: { data?: unknown[] } }).payments;
    for (const entry of payments?.data ?? []) {
      const intent = (entry as { payment?: { payment_intent?: unknown } })?.payment?.payment_intent;
      if (!intent || typeof intent !== 'object') continue;
      const pi = intent as {
        status?: string;
        payment_method?: unknown;
        latest_charge?: unknown;
      };
      if (pi.status !== 'succeeded') continue;

      const charge =
        pi.latest_charge && typeof pi.latest_charge === 'object'
          ? (pi.latest_charge as {
              payment_method?: unknown;
              payment_method_details?: { card?: { three_d_secure?: unknown } | null } | null;
            })
          : null;
      if (charge?.payment_method_details?.card?.three_d_secure) return 'customer';

      const paidWith = paymentMethodIdOf(charge?.payment_method) ?? paymentMethodIdOf(pi.payment_method);
      if (!failedPaymentMethodId || !paidWith) return 'unknown';
      return paidWith === failedPaymentMethodId ? 'retry' : 'customer';
    }
    return 'unknown';
  } catch (err) {
    console.error('[stripe-webhook] recovered_by lookup failed for %s:', invoiceId, {
      error: err instanceof Error ? err.message : String(err),
    });
    return 'unknown';
  }
}

/**
 * Stamp recovered_by on every row of the dunning sequence for this invoice.
 * Measurement only: a failure is logged and swallowed, and the webhook acks.
 */
async function recordRecoveredBy(
  db: ReturnType<typeof createServiceRoleClient>,
  customerId: string,
  invoiceId: string,
): Promise<void> {
  try {
    const { data: rows, error: readError } = await db
      .from('billing_email_sends')
      .select('payload')
      .eq('stripe_customer_id', customerId)
      .eq('scope_key', invoiceId)
      .in('template', [...DUNNING_TEMPLATE_LIST]);
    if (readError) {
      console.error('[stripe-webhook] recovered_by: could not read the sequence:', readError.message);
      return;
    }
    if (!rows?.length) return;

    let failedPaymentMethodId: string | null = null;
    for (const row of rows) {
      const payload = row.payload as { failedPaymentMethodId?: unknown } | null;
      if (typeof payload?.failedPaymentMethodId === 'string' && payload.failedPaymentMethodId) {
        failedPaymentMethodId = payload.failedPaymentMethodId;
        break;
      }
    }

    const by = await recoveredBy(invoiceId, failedPaymentMethodId);
    const { error } = await db
      .from('billing_email_sends')
      .update({ recovered_by: by })
      .eq('stripe_customer_id', customerId)
      .eq('scope_key', invoiceId)
      .in('template', [...DUNNING_TEMPLATE_LIST]);
    if (error) {
      console.error('[stripe-webhook] recovered_by: update failed:', error.message);
      return;
    }
    console.log('[stripe-webhook] %s recovered_by=%s', invoiceId, by);
  } catch (err) {
    console.error('[stripe-webhook] recordRecoveredBy failed, swallowed:', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Why a subscription ended, on its own ledger row: Stripe's
 * cancellation_details.reason ('payment_failed' when the retries ran out,
 * 'cancellation_requested' when someone cancelled), or 'none'. Feeds the
 * involuntary-churn panel on /admin/growth/dunning.
 *
 * Written right after the ledger insert, before the out-of-order guard, so a
 * deletion that is skipped as stale is still counted with its reason. Best
 * effort: before migration 20261024225000 the column does not exist, the
 * update fails, and that is logged and swallowed. Never throws.
 */
async function recordDeletionReason(
  db: ReturnType<typeof createServiceRoleClient>,
  event: Stripe.Event,
): Promise<void> {
  try {
    const subscription = event.data.object as Stripe.Subscription;
    const raw = subscription.cancellation_details?.reason ?? null;
    const reason = typeof raw === 'string' && raw ? raw.slice(0, 64) : 'none';
    const { error } = await db
      .from('stripe_webhook_events')
      .update({ cancellation_reason: reason })
      .eq('event_id', event.id);
    if (error) console.error('[stripe-webhook] could not record the deletion reason:', error.message);
  } catch (err) {
    console.error('[stripe-webhook] recordDeletionReason failed, swallowed:', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Failed-payment state (src/lib/billing/payment-issue.ts)
// ---------------------------------------------------------------------------

/**
 * Record the failed-payment state for a declined renewal invoice, unless the
 * invoice has been paid or voided since this event was emitted.
 *
 * Both invoice events are exempt from the out-of-order guard, so a redelivered
 * `payment_failed` can land AFTER the `payment_succeeded` that settled it. The
 * live invoice is the arbiter: one retrieve, only on a decline. If the
 * retrieve fails the state is written anyway; the next success clears it.
 *
 * An `invoice.payment_action_required` handler records the same state through
 * this, with the 'authentication_required' code. Never throws.
 */
async function recordPaymentIssueForInvoice(
  invoice: Stripe.Invoice,
  customerId: string,
  declineCode: string | null,
): Promise<void> {
  try {
    if (invoice.id) {
      try {
        const live = await stripe.invoices.retrieve(invoice.id);
        if (live.status === 'paid' || live.status === 'void') {
          console.log(
            '[stripe-webhook] %s is already %s; no payment issue recorded.', invoice.id, live.status,
          );
          return;
        }
      } catch (err) {
        console.error('[stripe-webhook] could not re-read invoice %s:', invoice.id, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await recordPaymentIssue(createServiceRoleClient(), {
      stripeCustomerId: customerId,
      declineCode,
    });
  } catch (err) {
    console.error('[stripe-webhook] recordPaymentIssueForInvoice failed, swallowed:', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A subscription event says the subscription is no longer failing (active,
 * trialing, canceled, ...). Clear the failed-payment state.
 *
 * The out-of-order guard compares whole seconds and strictly, so a sibling
 * `subscription.updated` (still `active`) emitted in the same second as the
 * `invoice.payment_failed` can arrive after it and is not stale. So, only when
 * there is something to clear, the live subscription decides. Never throws.
 */
async function clearPaymentIssueIfRecovered(subscription: Stripe.Subscription): Promise<void> {
  try {
    if (PAYMENT_ISSUE_STATUSES.has(subscription.status)) return;
    const customerId =
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer?.id;
    if (!customerId) return;

    const db = createServiceRoleClient();
    if (!(await hasPaymentIssue(db, customerId))) return;

    const live = await stripe.subscriptions.retrieve(subscription.id);
    if (PAYMENT_ISSUE_STATUSES.has(live.status)) return;

    await clearPaymentIssue(db, {
      stripeCustomerId: customerId,
      source: `customer.subscription.updated (status=${live.status})`,
    });
  } catch (err) {
    console.error('[stripe-webhook] clearPaymentIssueIfRecovered failed, swallowed:', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

/** The pm_ id on a last_payment_error, whether Stripe expanded it or not. */
function paymentMethodIdOf(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id: unknown }).id;
    return typeof id === 'string' && id ? id : null;
  }
  return null;
}

/**
 * The failed attempt on an invoice: the issuer's decline code and the payment
 * method it was tried on, each null when unknown.
 *
 * The payment method is kept in the dunning payload so that, when the invoice
 * is finally paid, recoveredBy can tell a new card from the same one retried.
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
async function invoiceFailedAttempt(
  invoice: Stripe.Invoice,
): Promise<{ declineCode: string | null; paymentMethodId: string | null }> {
  const none = { declineCode: null, paymentMethodId: null };
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
      return {
        declineCode: declineFrom(intent.last_payment_error),
        paymentMethodId: paymentMethodIdOf(intent.last_payment_error?.payment_method),
      };
    }

    if (!invoice.id) return none;

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
        const error = (intent as { last_payment_error?: Stripe.PaymentIntent.LastPaymentError | null })
          .last_payment_error;
        const code = declineFrom(error);
        if (code) return { declineCode: code, paymentMethodId: paymentMethodIdOf(error?.payment_method) };
      }
    }
    return none;
  } catch (err) {
    console.error('[stripe-webhook] could not resolve decline code:', {
      error: err instanceof Error ? err.message : String(err),
    });
    return none;
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

/** The customer id on a Checkout session, expanded or not. */
function customerIdOf(session: Stripe.Checkout.Session): string | null {
  return typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id ?? null;
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
  /**
   * The seasonal offer cohort tag (metadata `offer`, e.g. 'bw2026') from the
   * session or subscription. Logged only: there is no column for it, and the
   * tag on the Stripe subscription is the record of the cohort.
   */
  offer?: string | null;
}

/** A metadata tag safe to print in a log line, or null. */
function safeOfferTag(value: string | null | undefined): string | null {
  return typeof value === 'string' && /^[a-z0-9_]{1,32}$/.test(value) ? value : null;
}

/**
 * Single source of truth update:
 *   1. Resolve the owner (user_id from metadata, else user_billing by customer).
 *   2. Upsert `user_billing` (plan + status + customer + subscription).
 *   3. Project the plan onto EVERY non-deleted workspace owned by that user.
 *   4. For a workspace that just moved onto a paid plan, lift the plan-limit
 *      pauses on its automations (src/lib/billing/plan-limit-pauses.ts).
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
    offer,
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

  // Read BEFORE the projection overwrites it: which workspaces are about to
  // move onto a paid plan. A renewal or a card change for a customer already
  // on the plan returns none, and this cannot throw.
  const enteringPaidPlan = await workspacesEnteringPaidPlan(supabase, resolvedUserId, newPlan);

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
    `[stripe-webhook] ${source}: user ${resolvedUserId} → plan "${newPlan ?? '(unchanged)'}" (status=${subscriptionStatus ?? 'n/a'})${safeOfferTag(offer) ? ` offer=${safeOfferTag(offer)}` : ''}; propagated to all owned workspaces`,
  );

  // ── Resume automations the Free allowance paused ──────────────────────────
  // The dispatcher pauses a rule until the END of the allowance period, and
  // nothing else re-reads that pause, so without this a customer who pays today
  // keeps every automation paused until next month. AFTER the projection on
  // purpose: a rule made due while the workspace still read as Free would be
  // paused straight back. Cannot throw, so a failure here never costs the plan
  // write above its ledger row.
  await liftPlanLimitPauses(supabase, enteringPaidPlan, { label: source });
}
