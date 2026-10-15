/**
 * Cancel a user's Stripe subscriptions when they delete their account.
 *
 * Account deletion soft-deletes every workspace and bans the auth user, but
 * the subscription lives in Stripe and nothing on our side stops it: no DB
 * trigger, no edge function, and the webhook only reacts to Stripe's events.
 * Before this, a paying customer who deleted their account kept being charged
 * every period for a product they could no longer sign in to.
 *
 * Every subscription that can still bill is cancelled IMMEDIATELY (not at
 * period end: there is no account left to use the rest of the period). No
 * proration credit and no final invoice: the unused part of the current period
 * is not refunded automatically. Refunds inside the 14-day window stay a manual
 * decision, as they are for every other cancellation.
 *
 * Idempotent: an already-cancelled subscription is skipped, so a retry after a
 * partial failure cancels only what is left.
 *
 * Server-side only.
 */

/**
 * Written into `cancellation_details.comment` so the webhook can tell this
 * cancellation apart and skip the "why did you cancel" and win-back emails to
 * an address whose owner just deleted their account.
 */
export const ACCOUNT_DELETED_CANCELLATION_COMMENT = 'account_deleted';

/** True when delete-account is what cancelled this subscription. */
export function isAccountDeletionCancellation(subscription: {
  cancellation_details?: { comment?: string | null } | null;
}): boolean {
  return subscription.cancellation_details?.comment === ACCOUNT_DELETED_CANCELLATION_COMMENT;
}

/** Statuses that can no longer bill. Everything else gets cancelled. */
const ENDED_STATUSES = new Set(['canceled', 'incomplete_expired']);

/** The slice of the Stripe client this needs, so tests can pass a stand-in. */
export interface SubscriptionCanceller {
  subscriptions: {
    list(params: {
      customer: string;
      status: 'all';
      limit: number;
      starting_after?: string;
    }): Promise<{ data: Array<{ id: string; status: string }>; has_more: boolean }>;
    cancel(
      id: string,
      params: {
        invoice_now: boolean;
        prorate: boolean;
        cancellation_details: { comment: string };
      },
    ): Promise<{ id: string; status: string }>;
  };
}

/**
 * Cancel every live subscription on the given customers. Throws on the first
 * Stripe error; the caller must then stop the deletion.
 *
 * @returns the ids of the subscriptions cancelled by this call.
 */
export async function cancelSubscriptionsForDeletedAccount(
  stripe: SubscriptionCanceller,
  customerIds: readonly string[],
): Promise<string[]> {
  const cancelled: string[] = [];
  for (const customer of new Set(customerIds.filter(Boolean))) {
    let startingAfter: string | undefined;
    for (;;) {
      const page = await stripe.subscriptions.list({
        customer,
        status: 'all',
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const sub of page.data) {
        if (ENDED_STATUSES.has(sub.status)) continue;
        await stripe.subscriptions.cancel(sub.id, {
          invoice_now: false,
          prorate: false,
          cancellation_details: { comment: ACCOUNT_DELETED_CANCELLATION_COMMENT },
        });
        cancelled.push(sub.id);
      }
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1].id;
    }
  }
  return cancelled;
}
