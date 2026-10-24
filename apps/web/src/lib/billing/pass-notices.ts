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
 * Nothing here throws into the webhook: every function logs and swallows.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import {
  hasEntitledSubscription,
  passNoticesFor,
  type BillingSnapshot,
  type PassNotice,
  type PassNoticeSink,
  type PassStatus,
} from '@/lib/billing/pass';
import { cancelOpenSequence, resolveRecipient, type CancelReason } from '@/lib/billing/lifecycle-queue';
import { lifecycleQueueingEnabled } from '@/lib/billing/lifecycle-mode';
import { dueIds, kickDueRows } from '@/lib/billing/dispatch-kick';
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
        .select('id, send_after');
      if (error) {
        console.error(`[pass-notices] queue failed for ${userId}: ${error.message}`);
        return;
      }
      console.log(`[pass-notices] queued ${data?.length ?? 0} of ${rows.length} pass notice(s) for ${userId}`);
      // A notice already due (a sweep that ran late) goes now, not next tick.
      await kickDueRows(dueIds(data), `pass notices ${userId}`);
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

/**
 * Put a user's pass notices back in line with their passes after a refund.
 *
 * A refund can change which pass ends the cover, and when:
 *   - refunding the covering pass starts the stacked one TODAY, so its two
 *     rows (queued at purchase for its old, later window) are dated wrong:
 *     pass_ending_7d would be dropped as past due and pass_ended would arrive
 *     months after the pass really ended;
 *   - refunding the stacked pass makes the earlier one end again, but its rows
 *     were cancelled as `pass_renewed` when the stacked one was bought, and
 *     the sweep's backfill cannot revive them (the identity index is not
 *     partial, so its insert is a no-op).
 *
 * So: the live pass that ends the cover gets both notices queued (if missing)
 * and every unsent row of it re-dated to its window, reviving rows cancelled
 * as `pass_renewed`. Rows cancelled for any other reason stay cancelled.
 * Nothing when the user has an entitled subscription (subscription_started
 * stands) or no live pass. Queueing off: nothing. Never throws.
 */
export async function resyncPassNotices(
  db: Db,
  options: { userId: string; stripeCustomerId: string | null; stripeEmail?: string | null; now?: Date },
): Promise<void> {
  try {
    if (!lifecycleQueueingEnabled()) return;
    const now = options.now ?? new Date();
    const customerId = options.stripeCustomerId ?? (await customerFor(db, options.userId));
    if (!customerId) return;

    const { data: billing, error: billingError } = await db
      .from('user_billing')
      .select('plan, subscription_status')
      .eq('user_id', options.userId)
      .maybeSingle();
    if (billingError) throw new Error(billingError.message);
    if (hasEntitledSubscription(billing as BillingSnapshot | null)) return;

    const live = (await passesForRenewal(db, options.userId))
      .filter((p) => (p.status === 'active' || p.status === 'scheduled') && Date.parse(p.ends_at) > now.getTime())
      .sort((a, b) => Date.parse(a.ends_at) - Date.parse(b.ends_at));
    const last = live[live.length - 1];
    if (!last) return;

    const notices = passNoticesFor({ id: last.id, user_id: options.userId, ends_at: last.ends_at });
    // Queue whatever is missing (a no-op for rows that exist in any state).
    await passNoticeSink(db, { stripeCustomerId: customerId, stripeEmail: options.stripeEmail ?? null })(notices);

    for (const notice of notices) {
      const patch = {
        send_after: notice.sendAfter,
        payload: { planId: 'personal', periodEnd: notice.endsAt } satisfies LifecyclePayload,
      };
      const base = () =>
        db
          .from('billing_email_sends')
          .update({ ...patch, cancelled_at: null, cancel_reason: null })
          .eq('stripe_customer_id', customerId)
          .eq('template', notice.template)
          .eq('scope_key', notice.passId)
          .is('sent_at', null);
      const { error: openError } = await base().is('cancelled_at', null);
      if (openError) throw new Error(openError.message);
      const { error: reviveError } = await base().eq('cancel_reason', 'pass_renewed');
      if (reviveError) throw new Error(reviveError.message);
    }
    console.log(`[pass-notices] resynced notices of pass ${last.id} to end ${new Date(last.ends_at).toISOString()}`);
  } catch (err) {
    console.error('[pass-notices] resync failed, swallowed:', {
      error: err instanceof Error ? err.message : String(err),
    });
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
