/**
 * The two service notices a 3-month Personal pass is owed, through the billing
 * lifecycle queue (`billing_email_sends`), and the `pass_renewed` rule.
 *
 *   pass_ending_7d  7 days before the pass ends
 *   pass_ended      on the day it ends
 *
 * QUEUED AT PURCHASE. recordPassPurchase hands both notices to the sink built
 * here, which writes two rows keyed (stripe customer, template, pass id). The
 * unique index on exactly that triple is what makes "exactly two per pass" a
 * database property: the expiry sweep hands the same pass_ended notice again
 * as a backfill, and that insert is a no-op.
 *
 * SERVICE NOTICES, NOT MARKETING. They are about the end of a fixed-term
 * contract the customer bought, so they go out without marketing consent and
 * carry no unsubscribe link: their GENERATED category is 'transactional'.
 * Like every lifecycle email they need BILLING_LIFECYCLE_EMAILS to queue
 * (queue_only or on) and `on` to send.
 *
 * CANCELLED WHEN UNTRUE. A full refund cancels both of that pass's rows; a
 * subscription starting cancels every open pass notice of the customer; a
 * stacked pass cancels the earlier pass's notices (a pass that another pass
 * follows does not end). The dispatcher asks checkPassNoticeFreshness again
 * immediately before each send, which covers whatever no event cancelled.
 *
 * RESTORED WHEN TRUE AGAIN. A cancellation for `pass_renewed` or
 * `subscription_started` can stop being right: the stacked pass is refunded,
 * or the subscription ends while the pass still runs. restorePassNotices then
 * puts the last live pass's two rows back (un-cancelled, with its current end
 * date) so a pass never ends without its notices. It also moves the dates of
 * open rows, for a stacked pass that a refund started early.
 *
 * Nothing here throws into the webhook: every function logs and swallows.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import {
  getActivePass,
  hasEntitledSubscription,
  passNoticesFor,
  type BillingSnapshot,
  type PassNotice,
  type PassNoticeSink,
  type PassStatus,
} from '@/lib/billing/pass';
import { cancelOpenSequence, resolveRecipient, type CancelReason } from '@/lib/billing/lifecycle-queue';
import { lifecycleQueueingEnabled } from '@/lib/billing/lifecycle-mode';
import { PASS_TEMPLATES, type LifecyclePayload } from '@/lib/email/billing-lifecycle';

type Db = SupabaseClient<Database>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How close to a pass's end a purchase still counts as renewing it. */
export const RENEWAL_WINDOW_MS = 14 * DAY_MS;

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

/** The Stripe customer a user's pass rows are keyed on: user_billing first. */
async function customerFor(db: Db, userId: string): Promise<string | null> {
  const { data, error } = await db
    .from('user_billing')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error(`[pass-notices] customer lookup failed for ${userId}: ${error.message}`);
    return null;
  }
  return data?.stripe_customer_id ?? null;
}

/**
 * Build the sink recordPassPurchase and sweepPassExpiry call. Queues nothing
 * when BILLING_LIFECYCLE_EMAILS is off (read at call time), or when no Stripe
 * customer or recipient can be found. A buyer always has a customer: the pass
 * Checkout runs through getOrCreateStripeCustomer.
 */
export function passNoticeSink(
  db: Db,
  options: { stripeCustomerId?: string | null; stripeEmail?: string | null } = {},
): PassNoticeSink {
  return async (notices: PassNotice[]) => {
    try {
      if (!lifecycleQueueingEnabled() || notices.length === 0) return;
      const userId = notices[0].userId;
      const customerId = options.stripeCustomerId ?? (await customerFor(db, userId));
      if (!customerId) {
        console.error(`[pass-notices] no Stripe customer for ${userId}; pass notices not queued.`);
        return;
      }
      const recipient = await resolveRecipient(db, options.stripeEmail ?? null, userId);
      if (!recipient) {
        console.error(`[pass-notices] no recipient for ${userId}; pass notices not queued.`);
        return;
      }
      const rows = notices.map((notice) => ({
        stripe_customer_id: customerId,
        user_id: userId,
        recipient,
        template: notice.template,
        scope_key: notice.passId,
        send_after: notice.sendAfter,
        payload: { planId: 'personal', periodEnd: notice.endsAt } satisfies LifecyclePayload,
      }));
      const { data, error } = await db
        .from('billing_email_sends')
        .upsert(rows, { onConflict: 'stripe_customer_id,template,scope_key', ignoreDuplicates: true })
        .select('id');
      if (error) {
        console.error(`[pass-notices] queue failed for ${userId}: ${error.message}`);
        return;
      }
      console.log(`[pass-notices] queued ${data?.length ?? 0} of ${rows.length} pass notice(s) for ${userId}`);
    } catch (err) {
      console.error('[pass-notices] sink failed, swallowed:', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/** Stop the unsent pass notices of a customer, or of one pass. Never throws. */
export async function cancelPassNotices(
  db: Db,
  options: { stripeCustomerId: string | null; passId?: string; reason: CancelReason },
): Promise<number> {
  if (!options.stripeCustomerId) return 0;
  return cancelOpenSequence({
    db,
    stripeCustomerId: options.stripeCustomerId,
    templates: [...PASS_TEMPLATES],
    reason: options.reason,
    ...(options.passId ? { scopeKey: options.passId } : {}),
  });
}

/** Cancellations that a later event can make untrue again. */
const RESTORABLE_REASONS: readonly CancelReason[] = ['pass_renewed', 'subscription_started'];

/**
 * Bring the pass notices back in line with what is stored, after an event that
 * can make an earlier cancellation untrue: a pass refunded (the stacked one, or
 * the running one, which starts the stacked one early) or a subscription that
 * ended while a pass runs.
 *
 * The pass whose notices are due is the LAST of the live cover (the queued one
 * when there is one: the running pass does not end). For its two rows, unsent:
 *   - an open row gets the pass's current end (send_after and payload);
 *   - a row cancelled for `pass_renewed` or `subscription_started` is
 *     un-cancelled with the same dates;
 *   - a missing row is queued through the sink.
 * Rows cancelled for any other reason (a refund, suppression) stay cancelled.
 * Nothing when the user has an entitled subscription, holds no pass, or
 * BILLING_LIFECYCLE_EMAILS is off. Returns the rows written. Never throws.
 */
export async function restorePassNotices(
  db: Db,
  options: { userId: string; stripeCustomerId?: string | null; now?: Date },
): Promise<number> {
  try {
    if (!lifecycleQueueingEnabled()) return 0;
    const now = options.now ?? new Date();
    const { data: billing, error: billingError } = await db
      .from('user_billing')
      .select('plan, subscription_status, stripe_customer_id')
      .eq('user_id', options.userId)
      .maybeSingle();
    if (billingError) {
      console.error(`[pass-notices] restore: billing read failed for ${options.userId}: ${billingError.message}`);
      return 0;
    }
    if (hasEntitledSubscription(billing as BillingSnapshot | null)) return 0;
    const active = await getActivePass(db, options.userId, { now });
    if (!active) return 0;
    const last = active.queued ?? active.current;
    const customerId = options.stripeCustomerId ?? billing?.stripe_customer_id ?? null;
    if (!customerId) {
      console.error(`[pass-notices] restore: no Stripe customer for ${options.userId}; nothing restored.`);
      return 0;
    }

    let written = 0;
    for (const notice of passNoticesFor(last)) {
      const patch = {
        send_after: notice.sendAfter,
        payload: { planId: 'personal', periodEnd: notice.endsAt } satisfies LifecyclePayload,
      };
      const scoped = () =>
        db
          .from('billing_email_sends')
          .update({ ...patch, cancelled_at: null, cancel_reason: null })
          .eq('stripe_customer_id', customerId)
          .eq('template', notice.template)
          .eq('scope_key', last.id)
          .is('sent_at', null);
      const [open, restored] = await Promise.all([
        scoped().is('cancelled_at', null).select('id'),
        scoped().in('cancel_reason', [...RESTORABLE_REASONS]).select('id'),
      ]);
      for (const result of [open, restored]) {
        if (result.error) {
          console.error(`[pass-notices] restore failed for pass ${last.id}: ${result.error.message}`);
        } else {
          written += result.data?.length ?? 0;
        }
      }
    }
    // Rows that were never queued (queueing was off at purchase, say).
    await passNoticeSink(db, { stripeCustomerId: customerId })(passNoticesFor(last));
    if (written > 0) console.log(`[pass-notices] restored or moved ${written} notice row(s) for pass ${last.id}`);
    return written;
  } catch (err) {
    console.error('[pass-notices] restore failed, swallowed:', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// pass_renewed
// ---------------------------------------------------------------------------

export interface RenewalCandidate {
  id: string;
  starts_at: string;
  ends_at: string;
  status: PassStatus;
}

/**
 * Is a purchase at `at` a renewal of a pass this user held?
 *
 * A renewal is another pass or a subscription bought by someone who held a
 * pass, no later than 14 days after that pass ended: during the pass (a
 * stacked pass, or a subscription anchored to its end) or within 14 days of
 * `ends_at`. A refunded pass was never held, and a pass that had not started
 * yet is the purchase itself or a queued one. Pure.
 */
export function isPassRenewal(passes: readonly RenewalCandidate[], at: Date, excludeId?: string): boolean {
  const t = at.getTime();
  return passes.some((pass) => {
    if (pass.id === excludeId || pass.status === 'refunded') return false;
    const start = Date.parse(pass.starts_at);
    const end = Date.parse(pass.ends_at);
    return Number.isFinite(start) && Number.isFinite(end) && start <= t && t <= end + RENEWAL_WINDOW_MS;
  });
}

/** The user's passes, for isPassRenewal. Empty on any error or a missing table. */
export async function passesForRenewal(db: Db, userId: string): Promise<RenewalCandidate[]> {
  try {
    const { data, error } = await (db as unknown as {
      from(table: 'user_passes'): {
        select(columns: string): {
          eq(column: string, value: string): PromiseLike<{
            data: RenewalCandidate[] | null;
            error: { message: string } | null;
          }>;
        };
      };
    })
      .from('user_passes')
      .select('id, starts_at, ends_at, status')
      .eq('user_id', userId);
    if (error) return [];
    return data ?? [];
  } catch {
    return [];
  }
}

// Freshness lives in pass-notice-freshness.ts so the dispatcher can import it
// without the queue writer; re-exported here for one import site.
export { checkPassNoticeFreshness, passNoticeFreshness } from '@/lib/billing/pass-notice-freshness';
