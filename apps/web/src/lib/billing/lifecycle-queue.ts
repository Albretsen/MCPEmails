/**
 * Queueing and cancelling billing lifecycle email sequences.
 *
 * This module is the only writer of `public.billing_email_sends`. The webhook
 * calls it to MATERIALISE a whole sequence at trigger time (one row per email,
 * each with its own `send_after`); the dispatcher only ever claims rows that are
 * already due. See the long WHY in
 * supabase/migrations/20260902130000_billing_lifecycle_emails.sql.
 *
 * EVERYTHING HERE IS BEST-EFFORT AND NEVER THROWS.
 *
 * That is a deliberate inversion of the rest of the webhook, where a failed
 * write throws so Stripe retries. These functions are called from inside
 * handlers that also apply the customer's PLAN, and a lifecycle email must
 * never be able to cost somebody their entitlement. A failure to queue means a
 * missed email, which is recoverable by hand; a throw here would roll back the
 * webhook's ledger row and re-run a plan change.
 *
 * IDEMPOTENCY. Every insert is ON CONFLICT DO NOTHING against
 * UNIQUE (stripe_customer_id, template, scope_key). Stripe redelivering
 * `invoice.payment_failed`, or emitting it a second time for the same invoice
 * on a later retry, inserts nothing the second time. That is the layer that
 * catches what the event-id ledger cannot: two DIFFERENT event ids describing
 * the same failed invoice.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  DUNNING_SCHEDULE,
  WINBACK_SCHEDULE,
  type BillingTemplate,
  type LifecyclePayload,
} from '@/lib/email/billing-lifecycle';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface QueueTarget {
  stripeCustomerId: string;
  userId: string | null;
  recipient: string;
}

interface QueueRow {
  stripe_customer_id: string;
  user_id: string | null;
  recipient: string;
  template: BillingTemplate;
  scope_key: string;
  send_after: string;
  payload: LifecyclePayload;
}

async function insertRows(
  db: SupabaseClient,
  rows: QueueRow[],
  label: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  try {
    // ignoreDuplicates maps to ON CONFLICT DO NOTHING against the
    // (stripe_customer_id, template, scope_key) unique index.
    const { data, error } = await db
      .from('billing_email_sends')
      .upsert(rows, {
        onConflict: 'stripe_customer_id,template,scope_key',
        ignoreDuplicates: true,
      })
      .select('id');

    if (error) {
      console.error(`[lifecycle-queue] ${label}: insert failed: ${error.message}`);
      return 0;
    }
    const queued = data?.length ?? 0;
    console.log(
      `[lifecycle-queue] ${label}: queued ${queued} of ${rows.length} (the rest were already queued)`,
    );
    return queued;
  } catch (err) {
    console.error(`[lifecycle-queue] ${label}: unexpected failure, swallowed:`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Resolve the address a lifecycle email goes to.
 *
 * Prefers the email Stripe has on the CUSTOMER, because that is the address the
 * person entered at checkout and the one their card statement will match, and
 * falls back to the login email in `public.users`. Returns null if neither
 * exists, which is a queue-nothing condition rather than an error: there is no
 * useful email to send.
 */
export async function resolveRecipient(
  db: SupabaseClient,
  stripeEmail: string | null | undefined,
  userId: string | null,
): Promise<string | null> {
  const fromStripe = stripeEmail?.trim();
  if (fromStripe) return fromStripe.toLowerCase();
  if (!userId) return null;
  try {
    const { data } = await db.from('users').select('email').eq('id', userId).maybeSingle();
    return data?.email?.trim().toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** Resolve the owner behind a Stripe customer. Null when unknown. */
export async function resolveUserId(
  db: SupabaseClient,
  stripeCustomerId: string,
  metadataUserId: string | null,
): Promise<string | null> {
  if (metadataUserId) return metadataUserId;
  try {
    const { data } = await db
      .from('user_billing')
      .select('user_id')
      .eq('stripe_customer_id', stripeCustomerId)
      .maybeSingle();
    return data?.user_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Does this user carry the 2026-08-19 repricing grandfather?
 *
 * Read at QUEUE time and frozen into the payload, because it decides whether
 * the email may say "your agent loses inboxes 2 and 3". For a grandfathered
 * user that sentence is false: they keep unlimited inboxes on Free, forever.
 * Defaults to TRUE on any read failure, which is the safe direction: the worst
 * case of a false positive is an email that understates what they lose, and the
 * worst case of a false negative is telling 151 users we are about to take away
 * something we promised them permanently.
 */
export async function isGrandfathered(
  db: SupabaseClient,
  userId: string | null,
): Promise<boolean> {
  if (!userId) return true;
  try {
    const { data, error } = await db
      .from('user_usage_entitlements')
      .select('unlimited_inboxes')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return true;
    return data?.unlimited_inboxes ?? false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Dunning
// ---------------------------------------------------------------------------

/**
 * Queue the four-email dunning sequence for one failed invoice.
 *
 * `scope_key` is the INVOICE id, not the subscription id, so a customer whose
 * card fails in September and again in October gets two sequences rather than
 * one silently-deduplicated one. That is correct: they are two separate
 * failures and the second one deserves to be told.
 *
 * The first row is due immediately, which the dispatcher's five-minute cadence
 * turns into "within an hour of the decline" with about eleven cycles to spare.
 * That timing is the single highest-leverage thing in the sequence: the
 * customer's own bank notification is still on their phone, so the email
 * explains a thing they are already looking at instead of introducing one.
 */
export async function queueDunningSequence(options: {
  db: SupabaseClient;
  target: QueueTarget;
  invoiceId: string;
  payload: LifecyclePayload;
  now?: Date;
}): Promise<number> {
  const { db, target, invoiceId, payload } = options;
  const now = options.now ?? new Date();

  const rows: QueueRow[] = DUNNING_SCHEDULE.map(({ template, dayOffset }) => ({
    stripe_customer_id: target.stripeCustomerId,
    user_id: target.userId,
    recipient: target.recipient,
    template,
    scope_key: invoiceId,
    send_after: new Date(now.getTime() + dayOffset * DAY_MS).toISOString(),
    payload,
  }));

  return insertRows(db, rows, `dunning ${invoiceId}`);
}

// ---------------------------------------------------------------------------
// Cancellation + win-back
// ---------------------------------------------------------------------------

/**
 * Queue the cancellation question now, and the two win-backs relative to the
 * date the paid period actually ends.
 *
 * The win-back offsets are measured from PERIOD END, not from the cancellation,
 * which is the difference between "14 days after you stopped having the
 * product" and "14 days after you clicked cancel". For an annual subscriber
 * cancelling in month two those are ten months apart, and only the first one is
 * a message anybody wants.
 *
 * `scope_key` is the subscription id plus the period end. Adding the period end
 * means a customer who cancels, un-cancels, and cancels again a year later gets
 * a second sequence rather than being permanently deduplicated by the first.
 */
export async function queueCancellationSequence(options: {
  db: SupabaseClient;
  target: QueueTarget;
  subscriptionId: string;
  /** Unix seconds. The end of the period they have already paid for. */
  periodEndSeconds: number | null;
  payload: LifecyclePayload;
  now?: Date;
}): Promise<number> {
  const { db, target, subscriptionId, periodEndSeconds, payload } = options;
  const now = options.now ?? new Date();
  const periodEnd = periodEndSeconds ? new Date(periodEndSeconds * 1000) : null;
  const scopeKey = periodEnd
    ? `${subscriptionId}:${Math.floor(periodEnd.getTime() / 1000)}`
    : subscriptionId;

  const rows: QueueRow[] = [
    {
      stripe_customer_id: target.stripeCustomerId,
      user_id: target.userId,
      recipient: target.recipient,
      template: 'cancel_ask',
      scope_key: scopeKey,
      // Immediately. The reason they cancelled is freshest right now, and this
      // is the one email in the file whose value is entirely in the reply.
      send_after: now.toISOString(),
      payload,
    },
  ];

  // No period end means we cannot honestly schedule "14 days after it ended",
  // so the win-backs are skipped rather than guessed. The question still goes.
  if (periodEnd) {
    for (const { template, dayOffset } of WINBACK_SCHEDULE) {
      rows.push({
        stripe_customer_id: target.stripeCustomerId,
        user_id: target.userId,
        recipient: target.recipient,
        template,
        scope_key: scopeKey,
        send_after: new Date(periodEnd.getTime() + dayOffset * DAY_MS).toISOString(),
        payload,
      });
    }
  }

  return insertRows(db, rows, `cancellation ${subscriptionId}`);
}

/**
 * Has ANY cancellation-series row ever been queued for this subscription?
 *
 * `customer.subscription.updated` with `cancel_at_period_end = true` is the
 * normal trigger for the cancellation question and the win-backs, and it covers
 * a customer who cancels in the portal. It does not cover a subscription that is
 * deleted outright: cancelled immediately from the Stripe dashboard, or closed
 * by Stripe when the retries on a failed card run out. Those customers passed
 * through no `cancel_at_period_end = true` state at all and, before this,
 * received neither the question nor a win-back. Churn from a dead card is
 * exactly the churn a win-back is for.
 *
 * `customer.subscription.deleted` therefore queues the series too, but only when
 * nothing is there already. The unique index would collapse a genuine duplicate
 * on its own, but only when the scope_key matches to the second, and
 * `current_period_end` is not guaranteed to be identical in the two events. This
 * asks the question the index cannot: has this subscription already been through
 * the cancellation series, under any period end?
 *
 * Fails towards NOT queueing on a read error. A missing win-back costs a
 * marginal recovery; a duplicate "what stopped working for you?" to somebody who
 * already answered it costs the answer.
 */
export async function hasCancellationSeries(
  db: SupabaseClient,
  stripeCustomerId: string,
  subscriptionId: string,
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('billing_email_sends')
      .select('id')
      .eq('stripe_customer_id', stripeCustomerId)
      .in('template', ['cancel_ask', 'winback_14', 'winback_30'])
      .like('scope_key', `${subscriptionId}%`)
      .limit(1);
    if (error) {
      console.error(
        `[lifecycle-queue] could not check the cancellation series for ${subscriptionId}: ${error.message}`,
      );
      return true;
    }
    return (data?.length ?? 0) > 0;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Card expiry
// ---------------------------------------------------------------------------

/**
 * Queue one card-expiry warning.
 *
 * `scope_key` carries the payment method id AND the expiry, so replacing an
 * expiring card with another expiring card still warns about the new one, while
 * re-running the daily sweep over the same card warns once.
 */
export async function queueCardExpiryWarning(options: {
  db: SupabaseClient;
  target: QueueTarget;
  template: 'card_expiry_30' | 'card_expiry_7';
  paymentMethodId: string;
  expiryKey: string;
  payload: LifecyclePayload;
  now?: Date;
}): Promise<number> {
  const { db, target, template, paymentMethodId, expiryKey, payload } = options;
  const now = options.now ?? new Date();

  return insertRows(
    db,
    [
      {
        stripe_customer_id: target.stripeCustomerId,
        user_id: target.userId,
        recipient: target.recipient,
        template,
        scope_key: `${paymentMethodId}:${expiryKey}`,
        send_after: now.toISOString(),
        payload,
      },
    ],
    `card expiry ${template} ${paymentMethodId}`,
  );
}

// ---------------------------------------------------------------------------
// Cancelling an in-flight sequence
// ---------------------------------------------------------------------------

export type CancelReason =
  | 'payment_recovered'
  | 'subscription_reactivated'
  | 'subscription_deleted'
  | 'suppressed'
  | 'card_replaced'
  | 'no_longer_due'
  | 'undeliverable'
  | 'manual';

/**
 * Stop the unsent remainder of a sequence.
 *
 * This is the mechanism behind "an email never lands after the charge already
 * succeeded". `invoice.payment_succeeded` cancels the dunning rows for that
 * invoice the moment the retry works, so the day-3 email is never sent to
 * somebody who paid on day 2.
 *
 * It is not the ONLY mechanism, deliberately. The dispatcher re-reads the
 * invoice from Stripe immediately before every send and cancels the row if it
 * is already paid, which covers the cases this cannot: a webhook we never
 * received, an event Stripe did not send because the endpoint was not
 * subscribed to it, a payment taken by hand in the dashboard. Belt AND braces,
 * because the failure being guarded against here is dunning somebody who has
 * already paid, which is the single worst thing this feature can do.
 *
 * Only ever touches rows that are still pending. A row already `sent_at` stays
 * sent; you cannot un-send an email by writing to a table.
 */
export async function cancelOpenSequence(options: {
  db: SupabaseClient;
  stripeCustomerId: string;
  /** Restrict to one scope (invoice / subscription). Omit for every open row. */
  scopeKey?: string;
  /** Restrict to specific templates, e.g. only the win-backs. */
  templates?: BillingTemplate[];
  reason: CancelReason;
}): Promise<number> {
  const { db, stripeCustomerId, scopeKey, templates, reason } = options;
  try {
    let query = db
      .from('billing_email_sends')
      .update({ cancelled_at: new Date().toISOString(), cancel_reason: reason })
      .eq('stripe_customer_id', stripeCustomerId)
      .is('sent_at', null)
      .is('cancelled_at', null);

    if (scopeKey) query = query.eq('scope_key', scopeKey);
    if (templates?.length) query = query.in('template', templates);

    const { data, error } = await query.select('id');
    if (error) {
      console.error(`[lifecycle-queue] cancel (${reason}) failed: ${error.message}`);
      return 0;
    }
    const n = data?.length ?? 0;
    if (n > 0) {
      console.log(
        `[lifecycle-queue] cancelled ${n} pending email(s) for ${stripeCustomerId} (${reason})`,
      );
    }
    return n;
  } catch (err) {
    console.error('[lifecycle-queue] cancel: unexpected failure, swallowed:', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * The subscription is gone. Close out the dunning sequence honestly.
 *
 * TWO DIFFERENT THINGS HAPPEN TO THE FOUR EMAILS, because they do not all
 * become false at the same moment.
 *
 * dunning_1, _3 and _7 are cancelled. Every one of them says some version of
 * "your plan is still running" and "update the card and this carries on", and
 * once the subscription is deleted there is nothing left to carry on. Sending
 * one after the fact would be telling a customer their access is intact on the
 * day it stopped.
 *
 * dunning_14 is BROUGHT FORWARD instead. Its copy is "the retries are finished,
 * so the subscription is closing", which is not true on day 14 by calendar; it
 * is true at exactly the moment Stripe closes the subscription, and that moment
 * is this event. Cancelling it, which is what this function used to do, deleted
 * the one email in the sequence written for precisely this and left the
 * customer with no final word at all. Its `send_after` is moved to now so the
 * next dispatcher tick picks it up.
 *
 * The dispatcher still re-reads the invoice before sending it, so a
 * subscription that was deleted because the customer cancelled while an unpaid
 * invoice happened to be open is still checked rather than assumed.
 */
export async function cancelDunningForCustomer(
  db: SupabaseClient,
  stripeCustomerId: string,
  reason: CancelReason,
): Promise<number> {
  const cancelled = await cancelOpenSequence({
    db,
    stripeCustomerId,
    templates: ['dunning_1', 'dunning_3', 'dunning_7'],
    reason,
  });

  try {
    const { error } = await db
      .from('billing_email_sends')
      .update({ send_after: new Date().toISOString() })
      .eq('stripe_customer_id', stripeCustomerId)
      .eq('template', 'dunning_14')
      .is('sent_at', null)
      .is('cancelled_at', null);
    if (error) {
      console.error(
        `[lifecycle-queue] could not bring dunning_14 forward for ${stripeCustomerId}: ${error.message}`,
      );
    }
  } catch (err) {
    console.error('[lifecycle-queue] bringing dunning_14 forward failed, swallowed:', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return cancelled;
}
