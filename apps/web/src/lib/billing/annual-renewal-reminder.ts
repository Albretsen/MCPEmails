/**
 * The annual renewal reminder: one transactional email 30 days before an
 * ANNUAL subscription renews, with the date, the amount and currency Stripe
 * will charge, the plan's display name, and how to cancel or switch to monthly
 * before that date. Monthly subscriptions never get it.
 *
 * HOW IT RUNS. pg_cron calls public.dispatch_annual_renewal_reminder() daily
 * (migration 20261111140200), which posts to
 * /api/internal/annual-renewal-reminder/dispatch only when a stored annual
 * period ends in 27 to 30 days. The route calls `runAnnualRenewalReminder`:
 *
 *   1. Candidates from user_billing: live status, a subscription id, a stored
 *      period ending 27 to 30 days from now, and a stored period longer than
 *      300 days (user_billing has no interval column; the stored period length
 *      is the cheap guess, Stripe is the answer).
 *   2. Per candidate, ONE subscription read (customer expanded for the email
 *      address) decides: still live, not cancelling, not paused, every item
 *      billed yearly. Only then one invoice preview, which is the upcoming
 *      renewal invoice exactly as Stripe will charge it (tax, discounts and
 *      customer balance included).
 *   3. A row in billing_email_sends, template annual_renewal_30, scope_key
 *      `${subscriptionId}:${periodEndSeconds}`. The unique index on
 *      (stripe_customer_id, template, scope_key) is the per-period ledger, so
 *      a second run, or the next day's run, inserts nothing. The row is due
 *      now and goes through the normal lifecycle dispatcher, which asks Stripe
 *      again right before the send (dispatch-freshness.ts).
 *
 * THE SWITCH. ANNUAL_RENEWAL_REMINDER_ENABLED, read at call time:
 *   off      (default) nothing is read or written.
 *   dry_run  steps 1 and 2 run for real, nothing is written, and the report
 *            lists what would be queued (masked recipient, subject, amount).
 *   on       rows are queued. Sending still needs BILLING_LIFECYCLE_EMAILS=on
 *            (queue_only composes and logs instead).
 * A dry run may widen the window with `horizonDays` (up to 400) so the whole
 * path can be exercised long before the first real renewal is 30 days out.
 *
 * Never throws: every failure is a count in the report.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { basePlanItem, getPlanByStripePriceId, type PlanId } from '@/lib/stripe/plans';
import {
  ANNUAL_RENEWAL_TEMPLATE,
  composeBillingEmail,
  type LifecyclePayload,
} from '@/lib/email/billing-lifecycle';
import { scheduledToStop } from '@/lib/analytics/revenue-math';
import { dueIds, kickDueRows } from '@/lib/billing/dispatch-kick';
import { maskAddress } from '@/lib/billing/lifecycle-dispatch';

type Db = SupabaseClient<Database>;

const DAY_MS = 24 * 60 * 60 * 1000;

export type AnnualRenewalReminderMode = 'off' | 'dry_run' | 'on';

export function annualRenewalReminderMode(
  env: Record<string, string | undefined> = process.env,
): AnnualRenewalReminderMode {
  const raw = (env.ANNUAL_RENEWAL_REMINDER_ENABLED ?? '').trim().toLowerCase();
  if (raw === 'on') return 'on';
  if (raw === 'dry_run') return 'dry_run';
  return 'off';
}

/** The reminder goes when the renewal is at most this many days away... */
export const REMINDER_DAYS = 30;
/** ...and at least this many, so a missed daily run still reaches it. */
export const REMINDER_MIN_DAYS = 27;
/** A stored period longer than this is treated as annual (a candidate). */
export const ANNUAL_PERIOD_MIN_DAYS = 300;
/** The widest dry-run window. */
export const MAX_HORIZON_DAYS = 400;

/** The parts of a Stripe subscription this reads. */
export interface RenewalSubscriptionFacts {
  id: string;
  status: string;
  customer: string | { id: string; email?: string | null; deleted?: boolean } | null;
  cancel_at?: number | null;
  cancel_at_period_end?: boolean | null;
  pause_collection?: unknown;
  items: {
    data: Array<{
      current_period_end?: number | null;
      price?: {
        id?: string | null;
        metadata?: Record<string, string> | null;
        recurring?: { interval?: string | null } | null;
      } | null;
    }>;
  };
}

export interface RenewalStripe {
  retrieveSubscription(id: string): Promise<RenewalSubscriptionFacts>;
  /** The upcoming renewal invoice: amount_due and currency as Stripe will charge. */
  previewRenewal(customerId: string, subscriptionId: string): Promise<{ amount_due: number; currency: string }>;
}

export interface RenewalCandidate {
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
}

/** Pure: the stored row looks like an annual subscription renewing in the window. */
export function isRenewalCandidate(row: RenewalCandidate, now: Date, horizonDays = REMINDER_DAYS): boolean {
  if (!row.stripe_subscription_id || !row.stripe_customer_id) return false;
  const end = row.current_period_end ? Date.parse(row.current_period_end) : Number.NaN;
  const start = row.current_period_start ? Date.parse(row.current_period_start) : Number.NaN;
  if (!Number.isFinite(end) || !Number.isFinite(start)) return false;
  if (end - start <= ANNUAL_PERIOD_MIN_DAYS * DAY_MS) return false;
  const t = now.getTime();
  const lower = horizonDays > REMINDER_DAYS ? t : t + REMINDER_MIN_DAYS * DAY_MS;
  return end > lower && end <= t + horizonDays * DAY_MS;
}

export type RenewalDecision =
  | { send: true; periodEnd: number; planId: PlanId | null; customerId: string; email: string | null }
  | { send: false; reason: 'not_live' | 'cancelling' | 'paused' | 'not_annual' | 'no_period' | 'no_customer' };

/** Pure: does this subscription renew yearly, unchanged, and when? */
export function decideRenewal(sub: RenewalSubscriptionFacts): RenewalDecision {
  if (sub.status !== 'active' && sub.status !== 'trialing') return { send: false, reason: 'not_live' };
  if (scheduledToStop({ cancel_at_period_end: sub.cancel_at_period_end ?? null, cancel_at: sub.cancel_at ?? null })) {
    return { send: false, reason: 'cancelling' };
  }
  if (sub.pause_collection) return { send: false, reason: 'paused' };
  const items = sub.items?.data ?? [];
  // Every item yearly: the plan and, on Business, the mailbox add-on.
  if (items.length === 0 || items.some((item) => item.price?.recurring?.interval !== 'year')) {
    return { send: false, reason: 'not_annual' };
  }
  const base = basePlanItem(items);
  const periodEnd = base?.current_period_end ?? null;
  if (typeof periodEnd !== 'number' || !Number.isFinite(periodEnd)) return { send: false, reason: 'no_period' };
  const customer = sub.customer;
  const customerId = typeof customer === 'string' ? customer : customer?.id ?? null;
  if (!customerId) return { send: false, reason: 'no_customer' };
  const email = typeof customer === 'object' && customer && !customer.deleted ? customer.email ?? null : null;
  return {
    send: true,
    periodEnd,
    planId: getPlanByStripePriceId(base?.price ?? null)?.plan.id ?? null,
    customerId,
    email,
  };
}

export interface ReminderReportItem {
  scope: string;
  to: string;
  subject: string | null;
  amount: string;
  renewsOn: string;
}

export interface ReminderReport {
  mode: AnnualRenewalReminderMode;
  candidates: number;
  checked: number;
  skipped: Record<string, number>;
  queued: number;
  alreadyQueued: number;
  failed: number;
  wouldQueue: ReminderReportItem[];
}

async function loginEmail(db: Db, userId: string): Promise<string | null> {
  try {
    const { data } = await db.from('users').select('email').eq('id', userId).maybeSingle();
    return data?.email?.trim().toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export async function runAnnualRenewalReminder(options: {
  db: Db;
  stripe: RenewalStripe;
  mode: AnnualRenewalReminderMode;
  now?: Date;
  /** Dry run only: widen the window to this many days ahead. */
  horizonDays?: number;
}): Promise<ReminderReport> {
  const { db, stripe, mode } = options;
  const now = options.now ?? new Date();
  const report: ReminderReport = {
    mode, candidates: 0, checked: 0, skipped: {}, queued: 0, alreadyQueued: 0, failed: 0, wouldQueue: [],
  };
  if (mode === 'off') return report;
  const skip = (reason: string) => { report.skipped[reason] = (report.skipped[reason] ?? 0) + 1; };

  const horizon =
    mode === 'dry_run' && typeof options.horizonDays === 'number' && Number.isFinite(options.horizonDays)
      ? Math.min(MAX_HORIZON_DAYS, Math.max(REMINDER_DAYS, Math.floor(options.horizonDays)))
      : REMINDER_DAYS;
  const lower = horizon > REMINDER_DAYS ? now : new Date(now.getTime() + REMINDER_MIN_DAYS * DAY_MS);
  const upper = new Date(now.getTime() + horizon * DAY_MS);

  const { data, error } = await db
    .from('user_billing')
    .select('user_id, stripe_customer_id, stripe_subscription_id, current_period_start, current_period_end')
    .in('subscription_status', ['active', 'trialing'])
    .not('stripe_subscription_id', 'is', null)
    .gt('current_period_end', lower.toISOString())
    .lte('current_period_end', upper.toISOString())
    .order('current_period_end', { ascending: true })
    .limit(500);
  if (error) {
    console.error('[annual-renewal] candidate read failed:', error.message);
    report.failed += 1;
    return report;
  }
  const candidates = (data ?? []).filter((row) => isRenewalCandidate(row, now, horizon));
  report.candidates = candidates.length;

  for (const row of candidates) {
    try {
      const sub = await stripe.retrieveSubscription(row.stripe_subscription_id as string);
      report.checked += 1;
      const decision = decideRenewal(sub);
      if (!decision.send) {
        skip(decision.reason);
        continue;
      }
      const preview = await stripe.previewRenewal(decision.customerId, sub.id);
      if (!(preview.amount_due > 0)) {
        skip('nothing_to_charge');
        continue;
      }
      const recipient = decision.email?.trim().toLowerCase() || (await loginEmail(db, row.user_id));
      if (!recipient) {
        skip('no_recipient');
        continue;
      }
      const payload: LifecyclePayload = {
        planId: decision.planId,
        amountCents: preview.amount_due,
        currency: preview.currency,
        periodEnd: new Date(decision.periodEnd * 1000).toISOString(),
        interval: 'year',
      };
      const scope = `${sub.id}:${decision.periodEnd}`;

      if (mode === 'dry_run') {
        const composed = composeBillingEmail(ANNUAL_RENEWAL_TEMPLATE, payload);
        report.wouldQueue.push({
          scope,
          to: maskAddress(recipient),
          subject: composed?.subject ?? null,
          amount: `${preview.amount_due} ${preview.currency}`,
          renewsOn: payload.periodEnd as string,
        });
        continue;
      }

      const { data: inserted, error: insertError } = await db
        .from('billing_email_sends')
        .upsert(
          [{
            stripe_customer_id: decision.customerId,
            user_id: row.user_id,
            recipient,
            template: ANNUAL_RENEWAL_TEMPLATE,
            scope_key: scope,
            send_after: now.toISOString(),
            payload,
          }],
          { onConflict: 'stripe_customer_id,template,scope_key', ignoreDuplicates: true },
        )
        .select('id, send_after');
      if (insertError) {
        console.error(`[annual-renewal] queue failed for ${sub.id}: ${insertError.message}`);
        report.failed += 1;
        continue;
      }
      if ((inserted?.length ?? 0) === 0) {
        report.alreadyQueued += 1;
        continue;
      }
      report.queued += 1;
      await kickDueRows(dueIds(inserted), `annual renewal ${sub.id}`);
    } catch (err) {
      console.error('[annual-renewal] candidate failed:', err instanceof Error ? err.message : String(err));
      report.failed += 1;
    }
  }
  return report;
}

/** The real Stripe calls. Server only. */
export async function stripeRenewalReader(): Promise<RenewalStripe> {
  const { stripe } = await import('@/lib/stripe/client');
  return {
    retrieveSubscription: async (id) =>
      (await stripe.subscriptions.retrieve(id, { expand: ['customer'] })) as unknown as RenewalSubscriptionFacts,
    previewRenewal: async (customer, subscription) => {
      const preview = await stripe.invoices.createPreview({ customer, subscription });
      return { amount_due: preview.amount_due, currency: preview.currency };
    },
  };
}
