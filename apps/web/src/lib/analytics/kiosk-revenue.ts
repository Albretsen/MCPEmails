/**
 * The money reads behind the kiosk board.
 *
 * Two sources, deliberately, because the two questions have different homes.
 *
 * WHAT WE ARE PAID comes from Stripe. Postgres stores a plan id and a period
 * end but never an amount, an interval or a coupon, so any MRR derived from it
 * would be our own price table wearing a customer's name. See revenue-math.ts
 * for the full argument and the arithmetic.
 *
 * HOW PEOPLE GET THERE comes from `product_funnel_events`. A pricing view, a
 * started checkout and, above all, an abandoned one leave no trace in Stripe:
 * an abandoned checkout is either an `incomplete` subscription or nothing at
 * all, and neither can be told apart from a card that simply failed. Our own
 * funnel table is the only place that knows someone tried.
 *
 * BOTH EXCLUDE OUR OWN ACCOUNTS, on owner email, the same rule the rest of the
 * growth reporting uses. This matters more here than anywhere else on the
 * board: the owner's dashboard visits and live test purchases are a large
 * fraction of every billing event ever recorded, and left in they would turn
 * the pricing rung of the funnel into a measure of our own browsing.
 */

import type Stripe from 'stripe';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { getPlanByStripePriceId, planDisplayName } from '@/lib/stripe/plans';
import { isInternalAccount } from '@/lib/analytics/internal-accounts';
import { GROWTH_TAGS, cachedSection, type GrowthResult } from '@/lib/analytics/growth-queries';
import {
  DEFAULT_VALUATION_ARR_MULTIPLE,
  monthlyFromInterval,
  summarizeSubscriptions,
  type DiscountFacts,
  type RevenueSummary,
  type SubscriptionFacts,
} from '@/lib/analytics/revenue-math';
// Cash arithmetic is shared with /admin/growth's money panel rather than
// reimplemented, for the same reason summarizeSubscriptions is: two surfaces
// that compute the same figure independently eventually disagree about it in
// public.
import { rollUpCash, stripeMode, type CashMonth } from '@/lib/analytics/cash-math';

/**
 * Hard ceiling on subscriptions pulled from Stripe.
 *
 * The account has fewer than twenty of any status. This exists so a future
 * where that is no longer true fails as a visibly capped number rather than as
 * a wall display quietly spending a minute paginating on every refresh.
 */
const MAX_SUBSCRIPTIONS = 500;

/** PostgREST returns at most 1000 rows per request, with no error when it truncates. */
const PAGE_SIZE = 1000;
/** Ceiling on billing-event paging, for the same reason as MAX_SUBSCRIPTIONS. */
const MAX_EVENT_PAGES = 10;

/**
 * Recurring revenue, priced from Stripe.
 *
 * Cached like every other growth read, so the board's five minute refresh
 * costs one Stripe call every ten minutes rather than one per render.
 */
export async function fetchRecurringRevenue(windowDays: number): Promise<GrowthResult<RevenueSummary>> {
  return cachedSection<RevenueSummary>(['recurring_revenue', String(windowDays)], GROWTH_TAGS.revenue, async () => {
    // Imported inside the cached read, not at module scope. `@/lib/stripe/client`
    // throws on an unset STRIPE_SECRET_KEY, and at module scope that throw takes
    // the whole board down rather than one tile: a wall display that shows
    // nothing at all because of one missing environment variable is a worse
    // failure than one that says which panel could not load.
    const { stripe } = await import('@/lib/stripe/client');
    const subscriptions = await stripe.subscriptions
      .list({
        status: 'all',
        limit: 100,
        // The customer carries the email the internal check runs on; the
        // discounts carry the coupons that make a comp worth nothing.
        expand: ['data.customer', 'data.discounts.source.coupon'],
      })
      .autoPagingToArray({ limit: MAX_SUBSCRIPTIONS });
    return summarizeSubscriptions(subscriptions.map(subscriptionFacts), {
      nowSeconds: Math.floor(Date.now() / 1000),
      windowDays,
    });
  });
}

/** Reduce a Stripe subscription to the facts revenue-math.ts works on. */
function subscriptionFacts(subscription: Stripe.Subscription): SubscriptionFacts {
  const items = subscription.items.data;
  const first = items[0]?.price;
  const interval = first?.recurring?.interval ?? 'month';
  const intervalCount = first?.recurring?.interval_count ?? 1;

  // Summed across items so a subscription with an add-on is priced whole.
  // A price with no `unit_amount` is tiered or metered and contributes nothing
  // here; we sell neither, and inventing a figure for one would be worse than
  // understating it.
  const grossMonthlyMinor = items.reduce((total, item) => {
    const price = item.price;
    const amount = price.unit_amount ?? 0;
    const quantity = item.quantity ?? 1;
    return total + monthlyFromInterval(amount * quantity, price.recurring?.interval ?? interval, price.recurring?.interval_count ?? intervalCount);
  }, 0);

  return {
    id: subscription.id,
    status: subscription.status,
    createdAt: subscription.created,
    endedAt: subscription.ended_at,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currency: subscription.currency,
    grossMonthlyMinor,
    discount: discountFacts(subscription, interval, intervalCount),
    planLabel: planLabel(first),
    internal: isInternalAccount(customerEmail(subscription.customer)),
  };
}

/**
 * Coupons, normalised to a month.
 *
 * A flat `amount_off` is taken off each invoice, so on a yearly subscription
 * it is one twelfth of that per month. Percentages are summed and clamped by
 * the math module; Stripe stacking two percentage coupons on one subscription
 * is not something we do, and summing is the direction that understates.
 *
 * An unresolved coupon (a bare id) cannot be valued. It is ignored rather than
 * guessed, which overstates revenue slightly; we always ask for the expansion,
 * so this is a guard rather than a path.
 */
function discountFacts(
  subscription: Stripe.Subscription,
  interval: string,
  intervalCount: number,
): DiscountFacts {
  let percentOff = 0;
  let amountOffMonthlyMinor = 0;
  for (const discount of subscription.discounts ?? []) {
    if (typeof discount === 'string') continue;
    // In the pinned API version the coupon hangs off `source`, and is a bare
    // id unless the expansion above resolved it. Verified against a live
    // 100% off coupon rather than read off the type.
    const coupon = discount.source?.coupon;
    if (!coupon || typeof coupon === 'string') continue;
    if (coupon.percent_off) percentOff += coupon.percent_off;
    if (coupon.amount_off) amountOffMonthlyMinor += monthlyFromInterval(coupon.amount_off, interval, intervalCount);
  }
  return { percentOff, amountOffMonthlyMinor };
}

/**
 * The plan as a person would say it.
 *
 * Resolved through the canonical price table so a renamed tier renames here
 * too, and so a subscription still billing on a price retired in the 2026-08-19
 * repricing is named rather than lumped into "Other".
 */
function planLabel(price: Stripe.Price | undefined): string {
  if (!price) return 'Other';
  const match = getPlanByStripePriceId(price.id);
  if (match) return `${planDisplayName(match.plan.id)} ${match.interval === 'year' ? 'yearly' : 'monthly'}`;
  return price.nickname ?? 'Other';
}

function customerEmail(customer: Stripe.Subscription['customer']): string | null {
  if (!customer || typeof customer === 'string') return null;
  if (customer.deleted) return null;
  return customer.email ?? null;
}

/** How far external accounts get down the road to paying us. All time. */
export type CheckoutFunnel = {
  /** Workspaces that looked at the plans while signed in. */
  pricingViewed: number;
  /** Workspaces Stripe handed a hosted checkout page to. */
  checkoutStarted: number;
  /** Workspaces whose checkout Stripe confirmed as paid. */
  checkoutCompleted: number;
  /** Started and never finished: the money left on Stripe's page. */
  abandoned: number;
  /** Workspaces where creating the checkout itself failed. */
  checkoutFailed: number;
  /** Existing subscribers who opened the billing portal. */
  portalOpened: number;
  /** Workspaces dropped from every count above because they are ours. */
  internalExcluded: number;
  /** When the most recent checkout completed, ISO, or null if none ever has. */
  lastCompletedAt: string | null;
};

const BILLING_STAGES = [
  'pricing_viewed',
  'checkout_started',
  'checkout_completed',
  'billing_portal_opened',
] as const;

/**
 * The checkout funnel, counted in distinct workspaces, all time.
 *
 * NOT read from `billing_funnel_by_workspace`. That view is the right shape but
 * it cannot exclude internal accounts: it aggregates before anything knows who
 * owns the workspace, and the owner's own pricing views and live test purchases
 * are a large share of every row in it. This reads the events with the owner
 * email embedded and filters in Node, where `isInternalAccount` already lives.
 * No address is returned to the caller; the shape above is counts only.
 *
 * All time rather than windowed on purpose, and for the same reason the
 * milestone funnel is: at a handful of checkouts a year, a 28 day window shows
 * zeros and hides the shape.
 */
export async function fetchCheckoutFunnel(): Promise<GrowthResult<CheckoutFunnel>> {
  return cachedSection<CheckoutFunnel>(['checkout_funnel'], GROWTH_TAGS.revenue, async () => {
    const rows = await loadBillingEvents();
    return summarizeCheckoutFunnel(rows);
  });
}

type BillingEventRow = {
  stage: string;
  outcome: string | null;
  workspace_id: string;
  occurred_at: string;
  workspaces: { users: { email: string | null } | null } | null;
};

/**
 * Every billing-stage event, paged.
 *
 * PostgREST caps a response at 1000 rows and reports no error when it
 * truncates, so a plain select would silently stop counting the day this table
 * outgrows one page. Paging with `range` is the fix; the ceiling is there so
 * the failure mode stays "capped" rather than "slow forever".
 */
async function loadBillingEvents(): Promise<BillingEventRow[]> {
  // Generated database types cover tables, not embedded relationships; cast
  // locally rather than weakening the shared client type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = createServiceRoleClient() as any;
  const rows: BillingEventRow[] = [];
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await service
      .from('product_funnel_events')
      .select('stage, outcome, workspace_id, occurred_at, workspaces!inner(users!workspaces_owner_id_fkey(email))')
      .in('stage', BILLING_STAGES)
      .order('occurred_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as BillingEventRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

/** Pure roll-up, separated from the query so the counting rules are readable. */
export function summarizeCheckoutFunnel(rows: BillingEventRow[]): CheckoutFunnel {
  const reached = new Map<string, Set<string>>();
  const failed = new Set<string>();
  const internal = new Set<string>();
  let lastCompletedAt: string | null = null;

  for (const row of rows) {
    const email = row.workspaces?.users?.email ?? null;
    if (isInternalAccount(email)) {
      internal.add(row.workspace_id);
      continue;
    }
    if (row.outcome === 'failure') {
      if (row.stage === 'checkout_started') failed.add(row.workspace_id);
      continue;
    }
    const seen = reached.get(row.stage) ?? new Set<string>();
    seen.add(row.workspace_id);
    reached.set(row.stage, seen);
    if (row.stage === 'checkout_completed') {
      // Rows arrive oldest first, so the last one wins.
      lastCompletedAt = row.occurred_at;
    }
  }

  const started = reached.get('checkout_started') ?? new Set<string>();
  const completed = reached.get('checkout_completed') ?? new Set<string>();
  const abandoned = [...started].filter((id) => !completed.has(id)).length;

  return {
    pricingViewed: (reached.get('pricing_viewed') ?? new Set()).size,
    checkoutStarted: started.size,
    checkoutCompleted: completed.size,
    abandoned,
    checkoutFailed: [...failed].filter((id) => !internal.has(id)).length,
    portalOpened: (reached.get('billing_portal_opened') ?? new Set()).size,
    internalExcluded: internal.size,
    lastCompletedAt,
  };
}

/* -------------------------------------------------------------------- cash */

/**
 * How much money has actually arrived.
 *
 * A DIFFERENT QUESTION FROM MRR, AND THE TWO ARE MEANT TO DISAGREE. The first
 * sale was a year up front: $48 landed in a single August afternoon and the MRR
 * it created is $4. A board showing only MRR hides every dollar that has ever
 * reached the bank, and a board showing only cash would claim the business
 * earns twelve times what it recurringly does and then appear to lose all of it
 * the following month. Both are on the tile, labelled, and a reader who notices
 * they differ has understood the business rather than found a bug.
 *
 * CHARGES, NOT INVOICES, for the reason cash-math.ts gives: an invoice can be
 * settled from a credit balance that moved no money. Refunds are netted off the
 * month the charge landed in, not the month the refund happened.
 *
 * OUR OWN PURCHASES ARE NOT INCOME. The live 100%-off test purchases would
 * otherwise appear here as cash that never arrived, which is the same class of
 * error that once had the kiosk reporting our own test account as a customer.
 * Same `isInternalAccount` rule as everywhere else, including the plus-tag
 * aliasing.
 *
 * "ALL TIME" IS HONEST BUT BOUNDED. It reaches back `CASH_HISTORY_DAYS` and
 * pages to a ceiling, and reports both, so the day this outgrows the ceiling
 * the tile can say "at least" rather than quietly understating. Stripe holds
 * nothing older than the account, so today the two are the same thing.
 */
export type CashCollected = {
  currency: string;
  /** Net of refunds, across the whole history read. */
  allTimeMinor: number;
  last30Minor: number;
  /** Net cash by UTC month, oldest first. Feeds the money view's chart. */
  months: CashMonth[];
  /** Charges counted. Zero is a real answer, not a failure. */
  charges: number;
  /** ISO date of the oldest charge read, or null when there are none. */
  since: string | null;
  /** Stripe had more than the ceiling: every figure above is a floor. */
  truncated: boolean;
  /** `test` means these are not real dollars. The tile must say so. */
  mode: 'live' | 'test' | 'unknown';
};

/** Two years covers the account's entire life and costs one paged request. */
const CASH_HISTORY_DAYS = 730;
/** Same posture as MAX_SUBSCRIPTIONS: fail as a visibly capped number. */
const MAX_CHARGES = 1000;

export async function fetchCashCollected(): Promise<GrowthResult<CashCollected>> {
  return cachedSection<CashCollected>(['cash_collected'], GROWTH_TAGS.revenue, async () => {
    // Imported inside the cached read for the same reason fetchRecurringRevenue
    // does it: an unset STRIPE_SECRET_KEY throws at import time, and at module
    // scope that throw takes the whole board down rather than one tile.
    const { stripe } = await import('@/lib/stripe/client');
    const since = Math.floor(Date.now() / 1000) - CASH_HISTORY_DAYS * 86_400;
    const charges = await stripe.charges
      .list({ limit: 100, created: { gte: since }, expand: ['data.customer'] })
      .autoPagingToArray({ limit: MAX_CHARGES });

    const counted = charges
      .filter((charge) => charge.status === 'succeeded')
      .filter((charge) => !isInternalAccount(chargeEmail(charge)))
      .map((charge) => ({
        grossMinor: charge.amount,
        refundedMinor: charge.amount_refunded ?? 0,
        at: new Date(charge.created * 1000).toISOString(),
      }));

    const months = rollUpCash(counted);
    const thirtyDaysAgo = Date.now() - 30 * 86_400_000;

    return {
      // Whichever currency the money actually arrived in, not the
      // subscriptions' reporting currency: cash is cash.
      currency: charges.find((charge) => charge.status === 'succeeded')?.currency ?? 'usd',
      allTimeMinor: months.reduce((total, month) => total + month.netMinor, 0),
      last30Minor: counted
        .filter((charge) => Date.parse(charge.at) >= thirtyDaysAgo)
        .reduce((total, charge) => total + charge.grossMinor - charge.refundedMinor, 0),
      months,
      charges: counted.length,
      since: counted[counted.length - 1]?.at ?? counted[0]?.at ?? null,
      truncated: charges.length >= MAX_CHARGES,
      mode: stripeMode(process.env.STRIPE_SECRET_KEY),
    };
  });
}

/**
 * The multiple behind the board's valuation figure.
 *
 * Read here rather than in revenue-math.ts so that module stays unit testable
 * without a process environment. An unparseable value falls back to the default
 * rather than to zero: a misconfigured variable should not silently value the
 * company at nothing, which is a number somebody would believe.
 */
export function valuationMultiple(): number {
  const raw = Number.parseFloat(process.env.COMPANY_VALUATION_ARR_MULTIPLE ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_VALUATION_ARR_MULTIPLE;
}

/** Stripe puts the payer's address on the expanded customer, not on the charge. */
function chargeEmail(charge: Stripe.Charge): string | null {
  const customer = charge.customer;
  if (customer && typeof customer !== 'string' && !customer.deleted && customer.email) {
    return customer.email;
  }
  return charge.billing_details?.email ?? charge.receipt_email ?? null;
}
