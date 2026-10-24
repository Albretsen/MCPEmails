/**
 * Failed-payment STATE, written by the Stripe webhook (2026-10-24).
 *
 * While a renewal is failing, two places tell the customer: the dashboard
 * banner (reads user_billing.subscription_status + last_decline_code) and a
 * once-a-day note on MCP tool results (reads workspaces.payment_issue_*).
 *
 * This is billing state, NOT entitlement. Nothing here touches `plan`, and
 * nothing reads these columns to decide what a workspace may do. The customer
 * keeps full service while Stripe retries.
 *
 * Projection mirrors `plan` in the webhook's applyUserPlan: the owner is
 * resolved through user_billing, and every non-deleted workspace they own gets
 * the same values.
 *
 * NEVER THROWS. Both writers are called from the webhook after (or beside) the
 * entitlement work, and a throw there deletes the ledger row and makes Stripe
 * redeliver an event whose plan write already happened. A failure here is
 * logged and swallowed; the next billing event repairs it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';

type Db = SupabaseClient<Database>;

export type PaymentIssueKind = 'declined' | 'confirm';

/** Subscription statuses that mean "a renewal payment is failing". */
export const PAYMENT_ISSUE_STATUSES: ReadonlySet<string> = new Set(['past_due', 'unpaid']);

/** The bank wants the customer to confirm (SCA / 3-D Secure). */
export const CONFIRM_DECLINE_CODE = 'authentication_required';

export function paymentIssueKind(declineCode: string | null | undefined): PaymentIssueKind {
  return declineCode === CONFIRM_DECLINE_CODE ? 'confirm' : 'declined';
}

async function ownerFor(db: Db, stripeCustomerId: string): Promise<string | null> {
  const { data, error } = await db
    .from('user_billing')
    .select('user_id')
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle();
  if (error) throw new Error(`owner lookup failed: ${error.message}`);
  return (data as { user_id?: string } | null)?.user_id ?? null;
}

function logFailure(what: string, stripeCustomerId: string, err: unknown): void {
  console.error(`[payment-issue] ${what} failed for ${stripeCustomerId}, swallowed:`, {
    error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * A renewal payment failed. Store the decline code and mark every workspace
 * the owner owns. `payment_issue_since` keeps its first value across retries;
 * the kind follows the latest decline (a card can move from "declined" to
 * "confirm" between attempts).
 */
export async function recordPaymentIssue(
  db: Db,
  options: { stripeCustomerId: string; declineCode: string | null; now?: Date },
): Promise<void> {
  const { stripeCustomerId, declineCode } = options;
  const now = (options.now ?? new Date()).toISOString();
  try {
    const { error: billingError } = await db
      .from('user_billing')
      .update({ last_decline_code: declineCode })
      .eq('stripe_customer_id', stripeCustomerId);
    if (billingError) throw new Error(`user_billing: ${billingError.message}`);

    const ownerId = await ownerFor(db, stripeCustomerId);
    if (!ownerId) {
      console.error(`[payment-issue] no owner for ${stripeCustomerId}; nothing projected.`);
      return;
    }

    const { error: sinceError } = await db
      .from('workspaces')
      .update({ payment_issue_since: now })
      .eq('owner_id', ownerId)
      .is('deleted_at', null)
      .is('payment_issue_since', null);
    if (sinceError) throw new Error(`workspaces since: ${sinceError.message}`);

    const { error: kindError } = await db
      .from('workspaces')
      .update({ payment_issue_kind: paymentIssueKind(declineCode) })
      .eq('owner_id', ownerId)
      .is('deleted_at', null);
    if (kindError) throw new Error(`workspaces kind: ${kindError.message}`);

    console.log(
      `[payment-issue] recorded for ${stripeCustomerId} (kind=${paymentIssueKind(declineCode)}).`,
    );
  } catch (err) {
    logFailure('record', stripeCustomerId, err);
  }
}

/** Is any failed-payment state stored for this customer? False on any error. */
export async function hasPaymentIssue(db: Db, stripeCustomerId: string): Promise<boolean> {
  try {
    const { data: billing } = await db
      .from('user_billing')
      .select('user_id, last_decline_code')
      .eq('stripe_customer_id', stripeCustomerId)
      .maybeSingle();
    const row = billing as { user_id?: string; last_decline_code?: string | null } | null;
    if (!row?.user_id) return false;
    if (row.last_decline_code) return true;
    const { data: marked } = await db
      .from('workspaces')
      .select('id')
      .eq('owner_id', row.user_id)
      .not('payment_issue_since', 'is', null)
      .limit(1);
    return Array.isArray(marked) && marked.length > 0;
  } catch {
    return false;
  }
}

/**
 * The payment went through, or the subscription is gone. Clear the decline
 * code and every workspace's marker, including the day the MCP note was last
 * shown, so a later failure starts fresh. Only rows that hold something are
 * written, so a healthy customer's renewal touches nothing.
 */
export async function clearPaymentIssue(
  db: Db,
  options: { stripeCustomerId: string; source: string },
): Promise<void> {
  const { stripeCustomerId, source } = options;
  try {
    const ownerId = await ownerFor(db, stripeCustomerId);

    const { error: billingError } = await db
      .from('user_billing')
      .update({ last_decline_code: null })
      .eq('stripe_customer_id', stripeCustomerId)
      .not('last_decline_code', 'is', null);
    if (billingError) throw new Error(`user_billing: ${billingError.message}`);

    if (!ownerId) return;

    const { data: cleared, error: wsError } = await db
      .from('workspaces')
      .update({
        payment_issue_since: null,
        payment_issue_kind: null,
        payment_notice_shown_on: null,
      })
      .eq('owner_id', ownerId)
      .not('payment_issue_since', 'is', null)
      .select('id');
    if (wsError) throw new Error(`workspaces: ${wsError.message}`);

    if (Array.isArray(cleared) && cleared.length > 0) {
      console.log(`[payment-issue] cleared for ${stripeCustomerId} (${source}).`);
    }
  } catch (err) {
    logFailure(`clear (${source})`, stripeCustomerId, err);
  }
}
