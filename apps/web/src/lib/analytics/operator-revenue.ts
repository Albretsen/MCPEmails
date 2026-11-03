/**
 * The account-level money reads for /admin/growth.
 *
 * SPLIT OF RESPONSIBILITY, AND WHY IT IS A SPLIT
 * `revenue-math.ts` owns the arithmetic and `kiosk-revenue.ts` owns the headline
 * roll-up (MRR, ARR, ARPA, at risk, net new). Both are consumed here rather
 * than re-implemented: two modules computing MRR independently is how a
 * dashboard ends up showing two different MRRs on two pages, and the number
 * that must never be arguable is this one.
 *
 * What this file adds is the part the kiosk deliberately must not have: WHO is
 * paying. The wall board is reachable with a shared token and hangs in a room,
 * so it is aggregates only. The operator page already names accounts in the
 * roster, behind an ADMIN_EMAILS session, and at one paying customer a revenue
 * panel that cannot say which customer is close to useless.
 *
 * It also adds CASH, which is a different question from MRR and, at this size,
 * the more important one. The first sale was a year up front: $48 arrived in
 * August and the MRR it created is $4. A page that showed only one of those
 * would either claim the business earns twelve times what it does, or hide the
 * only money that has ever actually landed. Both are shown, labelled.
 *
 * NOTHING THROWS. Same contract as growth-queries.ts: every export returns a
 * `GrowthResult`, and `@/lib/stripe/client` is imported dynamically because it
 * throws at import time on an unset `STRIPE_SECRET_KEY` and that throw would
 * take down the whole page rather than one panel.
 */

import type Stripe from 'stripe';
import { basePlanItem, getPlanByStripePriceId, planDisplayName } from '@/lib/stripe/plans';
import { isInternalAccount } from '@/lib/analytics/internal-accounts';
import { GROWTH_TAGS, cachedSection, type GrowthResult } from '@/lib/analytics/growth-queries';
import {
  monthlyFromInterval,
  netMonthlyMinor,
  scheduledToStop,
  taxInclusiveRatio,
  type CurrencyOptions,
  type SubscriptionFacts,
} from '@/lib/analytics/revenue-math';
import { rollUpCash, stripeMode, type CashMonth } from '@/lib/analytics/cash-math';
import { chargesInUsd, monthOf, toUsdMinor } from '@/lib/analytics/fx';
import { SUBSCRIPTION_EXPAND, couponAmountOff, loadCurrencyOptions, pricedItems } from '@/lib/analytics/kiosk-revenue';

// Re-exported because this is where the page looks for them.
export { rollUpCash, stripeMode };
export type { CashMonth };

/** Matches the ceiling in kiosk-revenue.ts: the account holds fewer than twenty. */
const MAX_SUBSCRIPTIONS = 500;

/** Two years of charges covers the cash chart and costs one request. */
const CASH_DAYS = 730;

/**
 * Statuses that mean the subscription is over. Kept in step with `LIVE_STATUSES`
 * in revenue-math.ts: anything not live and not trialing is history.
 */
const ENDED_STATUSES = new Set(['canceled', 'incomplete_expired', 'paused']);

/** One subscription, named. */
export type RevenueCustomerRow = {
  subscriptionId: string;
  /** Null when Stripe holds no email, which happens on an API-created customer. */
  email: string | null;
  /** "Personal yearly", or the price nickname when no plan claims the price. */
  planLabel: string;
  /** Raw Stripe status, rendered as-is. An unknown one must not become "active". */
  status: string;
  /** The currency the amounts on this row are in, as billed. */
  currency: string;
  /** What one interval costs after coupons, in minor units. */
  netPerIntervalMinor: number;
  /** 'month' | 'year' | whatever Stripe reported. */
  interval: string;
  /** Net normalised to a month, the figure that feeds MRR. Net of any VAT. */
  monthlyMinor: number;
  /**
   * `monthlyMinor` in USD at the rate of the month it was last billing in,
   * the figure the MRR card sums. Null when fx.ts has no rate.
   */
  monthlyUsdMinor: number | null;
  /**
   * Coupon reductions, unformatted. Deliberately not a ready-made string: the
   * page's one money formatter lives in `components/admin/charts/format.ts`,
   * and a second copy here to build "$5.00 off" is how two figures on the same
   * screen come to round differently.
   */
  discountPercentOff: number;
  discountAmountMinor: number;
  /** Discounted to nothing. A real person, no money: counted, never revenue. */
  isComped: boolean;
  /** One of our own accounts. Excluded from every revenue figure. */
  isInternal: boolean;
  startedAt: string | null;
  /** When the current period ends: for a yearly plan, the renewal date. */
  renewsAt: string | null;
  cancelAtPeriodEnd: boolean;
  endedAt: string | null;
};

export type RevenueDetail = {
  /**
   * Which Stripe account these numbers came from. `.env.local` holds a test key
   * and only Vercel production holds the live one, so a locally rendered page
   * must say so: a test-mode figure that looks like revenue is worse than none.
   */
  mode: 'live' | 'test' | 'unknown';
  /** Currency of the cash figures: always 'usd', converted per charge. */
  currency: string;
  /** Every subscription Stripe returned, newest first, live and dead. */
  customers: RevenueCustomerRow[];
  /** Cash by UTC month, oldest first. */
  cash: CashMonth[];
  cashLast30Minor: number;
  cashAllTimeMinor: number;
  /** True when Stripe had more objects than the ceiling, so totals are floors. */
  truncated: boolean;
  /** Charge currencies left out of the cash figures for want of a rate. */
  otherCurrencies: string[];
};

/**
 * Subscriptions and cash, in one cached read.
 *
 * Both come from the same refresh so the customer table and the cash chart can
 * never disagree about which subscription existed when.
 */
export async function fetchRevenueDetail(): Promise<GrowthResult<RevenueDetail>> {
  return cachedSection<RevenueDetail>(['revenue_detail'], GROWTH_TAGS.revenue, async () => {
    const { stripe } = await import('@/lib/stripe/client');
    const since = Math.floor(Date.now() / 1000) - CASH_DAYS * 24 * 60 * 60;

    const [subscriptions, charges] = await Promise.all([
      stripe.subscriptions
        .list({
          status: 'all',
          limit: 100,
          expand: SUBSCRIPTION_EXPAND,
        })
        .autoPagingToArray({ limit: MAX_SUBSCRIPTIONS }),
      stripe.charges.list({ limit: 100, created: { gte: since } }),
    ]);
    const options = await loadCurrencyOptions(stripe, subscriptions);
    const now = Math.floor(Date.now() / 1000);

    const customers = subscriptions
      .map((subscription) => toCustomerRow(subscription, options, now))
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));

    // A charge from one of our own accounts is not income. Same rule as
    // everywhere else on the page; it matters here because the live 100% off
    // test purchases would otherwise show up as cash that never arrived.
    // Converted to USD per charge, at the month it landed in (fx.ts).
    const { rows: cashCharges, otherCurrencies } = chargesInUsd(
      charges.data
        .filter((charge) => charge.status === 'succeeded')
        .filter((charge) => !isInternalAccount(chargeEmail(charge))),
    );

    const cash = rollUpCash(cashCharges);
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    return {
      mode: stripeMode(process.env.STRIPE_SECRET_KEY),
      currency: 'usd',
      customers,
      cash,
      cashLast30Minor: cashCharges
        .filter((charge) => Date.parse(charge.at) >= thirtyDaysAgo)
        .reduce((total, charge) => total + charge.grossMinor - charge.refundedMinor, 0),
      cashAllTimeMinor: cash.reduce((total, month) => total + month.netMinor, 0),
      truncated: subscriptions.length >= MAX_SUBSCRIPTIONS || charges.has_more,
      otherCurrencies,
    };
  });
}

/** Reduce one Stripe subscription to the named row the table renders. */
export function toCustomerRow(
  subscription: Stripe.Subscription,
  currencyOptions?: Map<string, CurrencyOptions>,
  nowSeconds = Math.floor(Date.now() / 1000),
): RevenueCustomerRow {
  const items = subscription.items.data;
  // The plan's own item, not whichever comes first: a Business subscription
  // also carries the per-mailbox add-on, which is not a plan.
  const price = basePlanItem(items)?.price;
  const interval = price?.recurring?.interval ?? 'month';
  const intervalCount = price?.recurring?.interval_count ?? 1;
  // Amounts in the subscription's own currency, the same resolution
  // subscriptionFacts uses, so a EUR row is never priced at the USD figure.
  const priced = pricedItems(subscription, currencyOptions);
  const currency = priced.currency;

  // Summed across items so an add-on is priced whole, matching subscriptionFacts.
  const grossPerIntervalMinor = priced.items.reduce(
    (total, { item, unitAmount }) => total + unitAmount * (item.quantity ?? 1),
    0,
  );
  const grossMonthlyMinor = priced.items.reduce(
    (total, { item, unitAmount }) =>
      total
      + monthlyFromInterval(
        unitAmount * (item.quantity ?? 1),
        item.price.recurring?.interval ?? interval,
        item.price.recurring?.interval_count ?? intervalCount,
      ),
    0,
  );

  const { percentOff, amountOffMinor, amountOffMonthlyMinor } = discountOf(subscription, interval, intervalCount, currency);
  const ratio = taxInclusiveRatio(priced.taxInclusive, subscription.latest_invoice);
  const facts: SubscriptionFacts = {
    id: subscription.id,
    status: subscription.status,
    createdAt: subscription.created,
    endedAt: subscription.ended_at,
    cancelAtPeriodEnd: scheduledToStop(subscription),
    canceledAt: subscription.canceled_at,
    currency,
    grossMonthlyMinor,
    discount: { percentOff, amountOffMonthlyMinor },
    ...(ratio === undefined ? {} : { taxInclusiveRatio: ratio }),
    billingInterval: interval,
    planLabel: planLabel(price),
    internal: false,
  };
  const monthlyMinor = netMonthlyMinor(facts);

  const monthlyUsdMinor = monthlyMinor === 0
    ? 0
    : toUsdMinor(monthlyMinor, currency, monthOf(subscription.ended_at ?? nowSeconds));

  // Per-interval net, derived from the monthly net so the table's amount and
  // the MRR card can never round in different directions.
  const netPerIntervalMinor = grossMonthlyMinor > 0
    ? Math.round((monthlyMinor / grossMonthlyMinor) * grossPerIntervalMinor)
    : 0;

  const email = customerEmail(subscription.customer);
  return {
    subscriptionId: subscription.id,
    email,
    planLabel: facts.planLabel,
    status: subscription.status,
    currency,
    netPerIntervalMinor,
    interval,
    monthlyMinor,
    monthlyUsdMinor: monthlyUsdMinor === null ? null : Math.round(monthlyUsdMinor),
    discountPercentOff: percentOff,
    discountAmountMinor: amountOffMinor,
    isComped: monthlyMinor <= 0,
    isInternal: isInternalAccount(email),
    startedAt: isoOrNull(subscription.created),
    renewsAt: isoOrNull(periodEnd(subscription)),
    cancelAtPeriodEnd: scheduledToStop(subscription),
    endedAt: isoOrNull(subscription.ended_at),
  };
}

/** True when Stripe considers the subscription finished. */
export function hasEnded(row: RevenueCustomerRow): boolean {
  return ENDED_STATUSES.has(row.status);
}

/**
 * Current period end.
 *
 * Stripe moved this from the subscription onto the subscription item; the
 * pinned API version writes the new shape while older objects still carry the
 * old field. Both are read so a renewal date never renders as unknown purely
 * because of which API version wrote the object.
 */
function periodEnd(subscription: Stripe.Subscription): number | null {
  // The plan's own item, as toCustomerRow prices it; the add-on shares the
  // period today, but the renewal shown is the plan's.
  const item = basePlanItem(subscription.items.data) as { current_period_end?: number } | undefined;
  const legacy = (subscription as unknown as { current_period_end?: number }).current_period_end;
  return item?.current_period_end ?? legacy ?? null;
}

/**
 * Coupons, normalised the same way kiosk-revenue.ts normalises them: a flat
 * `amount_off` comes off each invoice, so on a yearly plan it is a twelfth of
 * that per month. Both the raw and the monthly figure are returned: the monthly
 * one prices MRR, the raw one is what a person reads on the row.
 */
function discountOf(
  subscription: Stripe.Subscription,
  interval: string,
  intervalCount: number,
  currency: string,
): { percentOff: number; amountOffMinor: number; amountOffMonthlyMinor: number } {
  let percentOff = 0;
  let amountOffMinor = 0;
  let amountOffMonthlyMinor = 0;
  for (const discount of subscription.discounts ?? []) {
    if (typeof discount === 'string') continue;
    const coupon = discount.source?.coupon;
    if (!coupon || typeof coupon === 'string') continue;
    if (coupon.percent_off) percentOff += coupon.percent_off;
    // In the row's currency, or not at all, as kiosk-revenue.ts values it.
    const amountOff = couponAmountOff(coupon, currency);
    if (amountOff) {
      amountOffMinor += amountOff;
      amountOffMonthlyMinor += monthlyFromInterval(amountOff, interval, intervalCount);
    }
  }
  return { percentOff, amountOffMinor, amountOffMonthlyMinor };
}

/**
 * The plan as a person would say it, resolved through the canonical price table
 * so a renamed tier renames here and a subscription still billing on a price
 * retired in the 2026-08-19 repricing is named rather than lumped into "Other".
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

function chargeEmail(charge: Stripe.Charge): string | null {
  return charge.billing_details?.email ?? charge.receipt_email ?? null;
}

function isoOrNull(unixSeconds: number | null | undefined): string | null {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString();
}
