/**
 * The restart email after a card-failure cancel (`payment_failed_restart`),
 * and the price its link restarts at.
 *
 * WHY. Stripe cancels a subscription when its retries run out
 * (`cancellation_details.reason = 'payment_failed'`). Some of those owners are
 * still using MCPEmails every day on Free: they did not choose to leave, a card
 * did. Until this, the next email they got was the day-14 win-back, which is a
 * marketing email. This sends one service email the moment the plan ends, with
 * one link back to the same plan and interval.
 *
 * WHO GETS IT (all must hold, decided in `restartDecision`):
 *   - the deletion's cancellation_details.reason is 'payment_failed';
 *   - the account is not deleted and holds no 3-month pass;
 *   - a workspace the owner owns made a SUCCESSFUL MCP call (activity_log,
 *     status 'success') in the last RECENT_USE_DAYS days;
 *   - the ended plan resolves to a paid plan and interval;
 *   - PAYMENT_RESTART_EMAIL_ENABLED is 'on' ('dry_run' logs the decision and
 *     queues nothing; anything else, unset included, is off).
 *
 * THE PRICE. The link carries the ended subscription id. Checkout keeps that
 * subscription's price (`keptRestartPrice`) only when all of these hold, and
 * otherwise sells the current price, which the email then does not promise:
 *   - the subscription belongs to this Stripe customer, is canceled, ended for
 *     payment_failed, and ended at most RESTART_PRICE_WINDOW_DAYS ago;
 *   - its price maps to the same plan and interval being bought, and that plan
 *     is Personal or Pro (Business has its own founder-price rules in
 *     founder-offer.ts and always takes the normal path);
 *   - the price is still active in Stripe;
 *   - it costs no more than the price sold today, in the same currency. A
 *     retired price that is HIGHER than today's (Pro $29) is never kept: that
 *     would charge a returning customer more than a new one.
 * Never throws; every failure means "use the current price".
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  PLANS,
  basePlanItem,
  getPlanByStripePriceId,
  type BillingInterval,
  type PlanId,
} from '@/lib/stripe/plans';
import type { Database } from '@/types/database.types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A successful MCP call within this many days counts as "still using it". */
export const RECENT_USE_DAYS = 7;

/** The restart link keeps the old price for this long after the plan ended. */
export const RESTART_PRICE_WINDOW_DAYS = 60;

/** Plans whose old price a restart may keep. Business never: see the header. */
const KEEP_PRICE_PLANS: ReadonlySet<PlanId> = new Set<PlanId>(['personal', 'solo']);

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

export type PaymentRestartMode = 'off' | 'dry_run' | 'on';

/**
 * PAYMENT_RESTART_EMAIL_ENABLED, read at call time (a module-scope constant is
 * not a kill switch on Vercel). Exactly 'on' sends, 'dry_run' logs, anything
 * else is off.
 */
export function paymentRestartMode(env: Record<string, string | undefined> = process.env): PaymentRestartMode {
  const raw = (env.PAYMENT_RESTART_EMAIL_ENABLED ?? '').trim().toLowerCase();
  if (raw === 'on') return 'on';
  if (raw === 'dry_run' || raw === 'dry-run') return 'dry_run';
  return 'off';
}

// ---------------------------------------------------------------------------
// Eligibility (pure)
// ---------------------------------------------------------------------------

export type RestartSkip =
  | 'flag_off'
  | 'not_payment_failed'
  | 'account_deleted'
  | 'holds_pass'
  | 'no_recent_use'
  | 'no_plan'
  | 'no_recipient';

export type RestartDecision =
  | { send: true; planId: PlanId; interval: BillingInterval }
  | { send: false; skip: RestartSkip };

export function restartDecision(input: {
  mode: PaymentRestartMode;
  cancellationReason: string | null | undefined;
  accountDeleted: boolean;
  holdsPass: boolean;
  recentSuccessfulCall: boolean;
  plan: { planId: PlanId; interval: BillingInterval } | null;
  hasRecipient: boolean;
}): RestartDecision {
  // The reason first: it is free, and it is false for almost every deletion.
  if (input.cancellationReason !== 'payment_failed') return { send: false, skip: 'not_payment_failed' };
  if (input.mode === 'off') return { send: false, skip: 'flag_off' };
  if (input.accountDeleted) return { send: false, skip: 'account_deleted' };
  if (input.holdsPass) return { send: false, skip: 'holds_pass' };
  if (!input.plan || input.plan.planId === 'free') return { send: false, skip: 'no_plan' };
  if (!input.recentSuccessfulCall) return { send: false, skip: 'no_recent_use' };
  if (!input.hasRecipient) return { send: false, skip: 'no_recipient' };
  return { send: true, planId: input.plan.planId, interval: input.plan.interval };
}

// ---------------------------------------------------------------------------
// "Still using it"
// ---------------------------------------------------------------------------

/**
 * True when any non-deleted workspace the owner owns logged a successful call
 * since `now - RECENT_USE_DAYS`. False on any read error: a missed restart
 * email is recoverable, one sent to somebody who left is not.
 */
export async function hasRecentSuccessfulCall(
  db: Pick<SupabaseClient<Database>, 'from'>,
  ownerId: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const { data: workspaces, error } = await db
      .from('workspaces')
      .select('id')
      .eq('owner_id', ownerId)
      .is('deleted_at', null);
    if (error) throw new Error(error.message);
    const ids = (workspaces ?? []).map((w) => (w as { id: string }).id).filter(Boolean);
    if (ids.length === 0) return false;
    const since = new Date(now.getTime() - RECENT_USE_DAYS * DAY_MS).toISOString();
    const { data: calls, error: callError } = await db
      .from('activity_log')
      .select('id')
      .in('workspace_id', ids)
      .eq('status', 'success')
      .gte('created_at', since)
      .limit(1);
    if (callError) throw new Error(callError.message);
    return (calls ?? []).length > 0;
  } catch (err) {
    console.error('[payment-restart] recent-use read failed, treated as no use:', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// The price a restart keeps
// ---------------------------------------------------------------------------

/** The slice of the Stripe SDK this needs; a test supplies two functions. */
export interface RestartStripe {
  subscriptions: {
    retrieve(id: string): Promise<{
      id: string;
      customer: string | { id: string };
      status?: string | null;
      ended_at?: number | null;
      canceled_at?: number | null;
      cancellation_details?: { reason?: string | null } | null;
      items: { data: Array<{ price: { id: string; metadata?: Record<string, string> | null } }> };
    }>;
  };
  prices: {
    retrieve(id: string): Promise<{
      id: string;
      active?: boolean | null;
      currency?: string | null;
      unit_amount?: number | null;
    }>;
  };
}

/** A Stripe subscription id, and nothing else, from an untrusted query value. */
export function restartSubscriptionIdOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^sub_[A-Za-z0-9]{6,64}$/.test(value) ? value : null;
}

/**
 * The ended subscription's price id when a restart may keep it, else null
 * (use the price sold today). See the header for every condition.
 */
export async function keptRestartPrice(options: {
  stripe: RestartStripe;
  stripeCustomerId: string;
  subscriptionId: string;
  planId: PlanId;
  interval: BillingInterval;
  now?: Date;
}): Promise<string | null> {
  const { stripe, stripeCustomerId, subscriptionId, planId, interval } = options;
  const now = options.now ?? new Date();
  if (!KEEP_PRICE_PLANS.has(planId)) return null;
  const plan = PLANS[planId];
  const soldPriceId = interval === 'year' ? plan.stripePriceIdYearly : plan.stripePriceIdMonthly;
  if (!soldPriceId) return null;
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    if (customer !== stripeCustomerId) return null;
    if (subscription.status !== 'canceled') return null;
    if (subscription.cancellation_details?.reason !== 'payment_failed') return null;
    const endedAt = subscription.ended_at ?? subscription.canceled_at ?? null;
    if (endedAt == null || now.getTime() - endedAt * 1000 > RESTART_PRICE_WINDOW_DAYS * DAY_MS) return null;

    const item = basePlanItem(subscription.items.data);
    const oldPriceId = item?.price?.id ?? null;
    if (!item || !oldPriceId) return null;
    const resolved = getPlanByStripePriceId(item.price);
    if (!resolved || resolved.plan.id !== planId || resolved.interval !== interval) return null;
    if (oldPriceId === soldPriceId) return oldPriceId;

    const [oldPrice, soldPrice] = await Promise.all([
      stripe.prices.retrieve(oldPriceId),
      stripe.prices.retrieve(soldPriceId),
    ]);
    if (oldPrice.active !== true) return null;
    if ((oldPrice.currency ?? '').toLowerCase() !== (soldPrice.currency ?? '').toLowerCase()) return null;
    if (oldPrice.unit_amount == null || soldPrice.unit_amount == null) return null;
    if (oldPrice.unit_amount > soldPrice.unit_amount) return null;
    return oldPriceId;
  } catch (err) {
    console.error('[payment-restart] could not check the old price; the current one is used:', {
      subscriptionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
