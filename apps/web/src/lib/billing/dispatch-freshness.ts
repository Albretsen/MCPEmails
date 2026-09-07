/**
 * "Should this queued email still go out?", asked of Stripe, immediately before
 * the send.
 *
 * Lifted out of app/api/internal/billing-lifecycle/dispatch/route.ts so it can
 * be tested. It is the single most important piece of logic in the feature and
 * it had no tests: a dunning email that arrives after the money was taken is
 * worse than no dunning at all, and this function is the thing that stops it.
 *
 * IT ASKS STRIPE, NEVER OUR OWN TABLES. Our tables are downstream of the
 * webhook, and the whole reason dunning did not exist until now is that the
 * endpoint was subscribed to no invoice events. Reading `user_billing` here
 * would be reading the same silence that caused the problem.
 *
 * A READ FAILURE IS NOT PERMISSION TO SEND. Any error returns `__retry__`, the
 * row is left claimed, the fifteen-minute lease expires and the next run tries
 * again. A delayed dunning email costs very little; one sent against an invoice
 * we could not confirm was unpaid is a support incident.
 */

export type Freshness = { send: true } | { send: false; reason: string };

/** The sentinel reason meaning "we could not tell; leave the row and retry". */
export const RETRY_REASON = '__retry__';

/** The row fields this decision reads. Deliberately narrower than the table. */
export interface FreshnessRow {
  id: number;
  template: string;
  scope_key: string;
}

/**
 * The slice of the Stripe SDK this needs. Narrow on purpose: a test supplies
 * three functions rather than a mock of the whole client, and the narrowness is
 * itself a check that nothing here reaches for state it should not.
 */
export interface FreshnessStripe {
  invoices: {
    retrieve(id: string): Promise<{
      status?: string | null;
      amount_remaining?: number | null;
      amount_due?: number | null;
    }>;
  };
  subscriptions: {
    retrieve(id: string): Promise<{
      status?: string | null;
      cancel_at_period_end?: boolean | null;
    }>;
  };
  paymentMethods: {
    retrieve(id: string): Promise<{
      customer?: unknown;
      card?: { exp_month?: number | null; exp_year?: number | null } | null;
    }>;
  };
}

export async function checkFreshness(
  stripe: FreshnessStripe,
  row: FreshnessRow,
): Promise<Freshness> {
  try {
    // ── Dunning: is the invoice still unpaid? ──────────────────────────────
    if (row.template.startsWith('dunning_')) {
      const invoice = await stripe.invoices.retrieve(row.scope_key);
      if (invoice.status === 'paid') return { send: false, reason: 'payment_recovered' };
      if (invoice.status === 'void' || invoice.status === 'uncollectible') {
        return { send: false, reason: 'no_longer_due' };
      }
      // A paid-off balance with a status that has not caught up yet is still
      // money we have taken. Treat it as recovered.
      if ((invoice.amount_remaining ?? invoice.amount_due ?? 0) <= 0) {
        return { send: false, reason: 'payment_recovered' };
      }
      return { send: true };
    }

    // ── Cancellation + win-back: did they come back? ───────────────────────
    if (row.template === 'cancel_ask' || row.template.startsWith('winback_')) {
      // scope_key is "sub_xxx" or "sub_xxx:1790718901".
      const subscriptionId = row.scope_key.split(':')[0];
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);

      if (row.template === 'cancel_ask') {
        // They un-cancelled before we got to the question. Do not ask a paying
        // customer why they left.
        if (!subscription.cancel_at_period_end && subscription.status === 'active') {
          return { send: false, reason: 'subscription_reactivated' };
        }
        return { send: true };
      }

      // A win-back only makes sense if they are actually gone. A customer who
      // resubscribed on a NEW subscription is not covered by this check, which
      // is why handleInvoicePaymentSucceeded also cancels win-backs on any
      // successful charge.
      if (subscription.status === 'active' || subscription.status === 'trialing') {
        return { send: false, reason: 'subscription_reactivated' };
      }
      return { send: true };
    }

    // ── Card expiry: is that card still the one on file? ───────────────────
    if (row.template.startsWith('card_expiry_')) {
      const paymentMethodId = row.scope_key.split(':')[0];
      const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
      if (!pm.customer) return { send: false, reason: 'card_replaced' };
      const stillExpiring = `${pm.card?.exp_month}/${pm.card?.exp_year}`;
      if (!row.scope_key.endsWith(stillExpiring)) {
        return { send: false, reason: 'card_replaced' };
      }
      return { send: true };
    }

    return { send: true };
  } catch (err) {
    console.error(`[lifecycle-dispatch] freshness check failed for row ${row.id}:`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { send: false, reason: RETRY_REASON };
  }
}

// ---------------------------------------------------------------------------
// The run budget
// ---------------------------------------------------------------------------

/**
 * How many emails one run may claim. Small on purpose: the next cron tick is
 * five minutes away, and a run that always answers is worth more than a run
 * that drains the queue.
 */
export const BATCH_SIZE = 25;

/**
 * Stop taking new work at this point. `maxDuration` on the route is 60 seconds,
 * so 45 leaves fifteen for the row in flight plus the response. A run that is
 * killed mid-loop leaves rows claimed but unsent, which the fifteen-minute
 * lease recovers, but only after a delay nobody asked for.
 */
export const WALL_CLOCK_BUDGET_MS = 45_000;

/** True when the loop must stop claiming new work and answer cron. */
export function budgetExhausted(startedAt: number, now: number, budgetMs = WALL_CLOCK_BUDGET_MS): boolean {
  return now - startedAt > budgetMs;
}
