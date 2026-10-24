/**
 * The arithmetic behind the kiosk's money numbers.
 *
 * Kept separate from the fetching so it can be unit tested without a Stripe
 * key: importing `@/lib/stripe/client` throws when `STRIPE_SECRET_KEY` is
 * unset, which is exactly the situation a test runner is in.
 *
 * SHARED, NOT KIOSK-ONLY. /admin/growth's money section reads the same
 * `summarizeSubscriptions` through the same fetchers in kiosk-revenue.ts. That
 * is the point: a wall board and an operator page that disagree about MRR
 * would cost more trust than either one is worth. Change a rule here and both
 * move together.
 *
 * WHY STRIPE IS THE SOURCE OF TRUTH FOR MONEY. Nothing in Postgres knows what
 * a subscription costs. `user_billing` stores the plan id, the status and the
 * period end, but no amount, no interval and no discount, so any MRR derived
 * from it would be a lookup in our own price table pretending to be a fact
 * about what a customer is actually being charged. Stripe knows the real
 * price, the real interval and the real coupon, which matters here more than
 * usual: our comped accounts are live subscriptions carrying a 100% off
 * coupon, and against the price table they would each read as full revenue.
 * Priced from Stripe they correctly contribute nothing.
 *
 * WHAT IS DELIBERATELY NOT MODELLED: expansion and contraction. Net new MRR
 * here is new minus churned, not new plus expansion minus contraction minus
 * churn. Doing it properly needs a stored MRR history to diff against, and
 * with a customer count in single digits an upgrade is visible on the tile
 * anyway. When the history exists, this is the function to revisit.
 *
 * EVERY FIGURE IS IN USD, NET OF VAT. Subscriptions in other currencies are
 * converted at the monthly rate in fx.ts (live ones at the current month,
 * ended ones at the month they ended), and a VAT-inclusive price counts only
 * its net share (`taxInclusiveRatio`). Before the EUR launch the board picked
 * one currency and dropped the rest, which would have hidden every EU
 * customer from MRR on day one.
 */

import { monthOf, toUsdMinor } from './fx.ts';

/** A Stripe subscription reduced to the facts the money math needs. */
export type SubscriptionFacts = {
  id: string;
  /** Raw Stripe status. */
  status: string;
  /** Unix seconds the subscription was created. */
  createdAt: number;
  /** Unix seconds it actually stopped billing, null while it is still live. */
  endedAt: number | null;
  /**
   * Live, but already scheduled to stop. Despite the name this is NOT only
   * Stripe's `cancel_at_period_end`: see `scheduledToStop` for the second shape.
   */
  cancelAtPeriodEnd: boolean;
  /**
   * Unix seconds the customer (or we) pressed cancel, null if nobody has. Set
   * as soon as a cancellation is scheduled, long before billing stops.
   */
  canceledAt: number | null;
  /** ISO 4217, lowercase, as Stripe reports it. */
  currency: string;
  /** List price per month in minor units, before any coupon. */
  grossMonthlyMinor: number;
  /** Coupon reductions, already normalised to a month. */
  discount: DiscountFacts;
  /**
   * Share of what the customer pays that is ours rather than the tax
   * authority's, 0..1. Below 1 only for a VAT-inclusive price, where the
   * amount includes the tax: the latest invoice's `total_excluding_tax /
   * total`. Missing means 1, which is right for every tax-exclusive price
   * (the tax is added on top and never touched our list price). See
   * `taxInclusiveRatio` for how kiosk-revenue.ts fills it.
   */
  taxInclusiveRatio?: number;
  /** Plan and interval as a person would say it, or 'Other'. */
  planLabel: string;
  /** One of our own accounts rather than a customer's. */
  internal: boolean;
  /**
   * Live but paused (Stripe pause_collection, and the paid period has ended):
   * not MRR, not churn. Its own level on the board. See `pausedNow`.
   */
  paused?: boolean;
};

/** One rail row: how many customers, and their net monthly money. */
export type Movement = { customers: number; mrrMinor: number };

export type Movements = {
  /** Started paying inside the window and still on track to renew. */
  new: Movement;
  /** Billing ended inside the window. */
  stopped: Movement;
  /** Still paying, scheduled to stop at period end. */
  leaving: Movement;
  /** Still paying, card failing, not scheduled to stop. */
  failing: Movement;
};

export type DiscountFacts = {
  /** Total percentage off, 0..100. */
  percentOff: number;
  /** Flat reduction per month in minor units. */
  amountOffMonthlyMinor: number;
};

export const NO_DISCOUNT: DiscountFacts = { percentOff: 0, amountOffMonthlyMinor: 0 };

/**
 * Statuses that represent a subscription we are currently billing on.
 *
 * `past_due` and `unpaid` are in: the app still entitles them through the
 * dunning grace period, and dropping them from MRR the moment a card bounces
 * would show a collapse in revenue that has not happened yet. They are
 * reported separately as money at risk instead.
 *
 * `trialing` is out: a trial has not committed to anything. `incomplete` and
 * `incomplete_expired` are out because they never paid at all, which is what
 * an abandoned Stripe checkout leaves behind. `paused` is out by definition.
 */
const LIVE_STATUSES = new Set(['active', 'past_due', 'unpaid']);

/**
 * Whether a live subscription is already scheduled to stop billing.
 *
 * TWO SHAPES, AND THE BOARD ONLY KNEW ONE. Stripe's own dashboard and customer
 * portal now schedule "cancel at end of period" by setting `cancel_at` to the
 * period end and leaving `cancel_at_period_end` FALSE. Verified live on
 * 2026-09-23: both customers who cancelled in September carry
 * `cancel_at: <period end>, cancel_at_period_end: false`, and a board reading
 * only the boolean showed "Set to stop: 0" while Stripe's list said
 * "Cancels Oct 14" and "Cancels Oct 21". Either field means the same thing here.
 */
export function scheduledToStop(subscription: {
  cancel_at_period_end: boolean | null;
  cancel_at: number | null;
}): boolean {
  return subscription.cancel_at_period_end === true || subscription.cancel_at != null;
}

/**
 * True while a pause is running: pause_collection is set, the paid period it
 * starts after (metadata mcpe_pause_from) has ended, and Stripe has not
 * resumed collection yet. A pause that is only scheduled is still MRR: that
 * month is paid. Mirrors pauseState in src/lib/billing/pause.ts, kept here so
 * the money math has no billing imports.
 */
export function pausedNow(
  subscription: {
    pause_collection?: { behavior?: string | null; resumes_at?: number | null } | null;
    metadata?: Record<string, string> | null;
  },
  nowSeconds: number,
): boolean {
  const pc = subscription.pause_collection;
  if (!pc?.behavior) return false;
  if (pc.resumes_at != null && nowSeconds >= pc.resumes_at) return false;
  const from = Number(subscription.metadata?.mcpe_pause_from ?? '');
  return !Number.isFinite(from) || from === 0 || from <= nowSeconds;
}

/** Statuses where the money is live but not arriving. */
const AT_RISK_STATUSES = new Set(['past_due', 'unpaid']);

/** One currency's share of live MRR, for "of which EUR". */
export type CurrencyShare = {
  currency: string;
  /** Live paying subscriptions billed in it. */
  customers: number;
  /** Net MRR in that currency's own minor units, before conversion. */
  mrrMinor: number;
  /** The same money in USD minor units; null when fx.ts has no rate for it. */
  mrrUsdMinor: number | null;
};

export type RevenueSummary = {
  /**
   * Currency every figure below is denominated in. Always 'usd' now: other
   * currencies are converted, see the module note.
   */
  currency: string;
  /** Normalised monthly recurring revenue, minor units, external accounts. */
  mrrMinor: number;
  /** `mrrMinor * 12`. Not a forecast, just the same number said annually. */
  arrMinor: number;
  /** Live subscriptions actually paying something. */
  payingCustomers: number;
  /** Live subscriptions fully discounted to nothing. Real people, no money. */
  compedCustomers: number;
  /** MRR divided by paying customers, 0 when nobody pays. */
  arpaMinor: number;
  /** Money on subscriptions Stripe cannot collect right now. */
  atRiskMinor: number;
  atRiskCustomers: number;
  /** Live, paying, and already set to stop at the end of the period. */
  leavingMinor: number;
  leavingCustomers: number;
  /**
   * Live but paused: not in MRR or paying customers, and not churn. The
   * figure is what they pay per month once billing resumes.
   */
  pausedCustomers: number;
  pausedMinor: number;
  /** Subscriptions that started inside the window, and what they were worth. */
  newMrrMinor: number;
  newCustomers: number;
  /** Subscriptions that stopped inside the window, and what they took with them. */
  churnedMrrMinor: number;
  churnedCustomers: number;
  /** `newMrrMinor - churnedMrrMinor`. See the module note on expansion. */
  netNewMrrMinor: number;
  /**
   * Customers who pressed cancel inside the window, whether billing has
   * already stopped or is scheduled to. This is the number a founder means by
   * "two people cancelled"; `churned*` is when the money actually leaves.
   */
  cancelledCustomers: number;
  cancelledMrrMinor: number;
  /**
   * Everyone who paid us at any point in the window: the churn denominator.
   * Paying at the start plus everyone new, so a window that starts with zero
   * customers still has an honest base instead of a division by zero.
   */
  churnBaseCustomers: number;
  churnBaseMrrMinor: number;
  /** cancelled / base, 0..1, null when nobody paid in the window. */
  customerChurnRate: number | null;
  revenueChurnRate: number | null;
  /**
   * The movement rail's rows, with every customer on at most one of them.
   * The fields above overlap on purpose (a cancel scheduled inside the window
   * is both "cancelled" and "leaving"), and a rail that listed them side by
   * side counted the same people twice. See `disjointMovements`.
   */
  movements: Movements;
  /** Where the money sits, biggest first. */
  byPlan: { label: string; customers: number; mrrMinor: number }[];
  /** Our own live subscriptions, excluded from every figure above. */
  internalCustomers: number;
  /**
   * Live paying money per billing currency, biggest USD share first. Native
   * and converted, so the board can say "of which EUR" without redoing FX.
   */
  byCurrency: CurrencyShare[];
  /**
   * Currencies held by live paying subscriptions that fx.ts has no rate for.
   * Non empty means the headline understates the true total and the tile says
   * so, rather than adding francs to dollars and calling the result revenue.
   */
  otherCurrencies: string[];
};

/**
 * Convert a recurring charge to a monthly figure.
 *
 * Yearly prices are divided by twelve rather than counted in the month they
 * land: our first customer bought a year up front, and a board that showed
 * their whole payment as one month's MRR would report a number thirty times
 * the truth and then appear to lose it all the following month.
 */
export function monthlyFromInterval(
  amountMinor: number,
  interval: string,
  intervalCount = 1,
): number {
  const count = Number.isFinite(intervalCount) && intervalCount > 0 ? intervalCount : 1;
  const months =
    interval === 'year' ? 12 * count
    : interval === 'month' ? count
    : interval === 'week' ? (12 * count) / 52
    : interval === 'day' ? (12 * count) / 365
    : count;
  if (!Number.isFinite(amountMinor) || months <= 0) return 0;
  return amountMinor / months;
}

/**
 * List price less coupons, less any VAT included in it, floored at zero.
 * Stripe never bills a negative. In the subscription's own currency.
 */
export function netMonthlyMinor(facts: SubscriptionFacts): number {
  const afterPercent = facts.grossMonthlyMinor * (1 - clampPercent(facts.discount.percentOff) / 100);
  const afterFlat = afterPercent - Math.max(0, facts.discount.amountOffMonthlyMinor);
  return Math.max(0, Math.round(afterFlat * clampRatio(facts.taxInclusiveRatio)));
}

function clampRatio(ratio: number | undefined): number {
  if (ratio == null || !Number.isFinite(ratio)) return 1;
  return Math.min(1, Math.max(0, ratio));
}

/* ------------------------------------------------- Stripe price and tax */

/** The parts of a Stripe price the amount and tax rules read. */
export type PriceShape = {
  currency: string;
  unit_amount: number | null;
  tax_behavior?: string | null;
  currency_options?: CurrencyOptions | null;
};

/** `Price.currency_options`: the same price in other currencies. */
export type CurrencyOptions = Record<string, { unit_amount: number | null; tax_behavior?: string | null }>;

/**
 * What one unit of a price costs in the subscription's currency.
 *
 * A EUR subscriber on a multi-currency price still has `price.currency` USD
 * and `price.unit_amount` in cents: the euro amount lives in
 * `currency_options.eur`, which Stripe only returns when asked for. Reading
 * `unit_amount` alone would book 900 cents as 900 euro cents. Returns null
 * when the price is in another currency and no option for this one is known,
 * so the caller can fall back to pricing it in the price's own currency.
 */
export function priceInCurrency(
  price: PriceShape,
  currency: string,
  options: CurrencyOptions | null | undefined = price.currency_options,
): { unitAmount: number | null; taxBehavior: string | null } | null {
  if (price.currency === currency) {
    return { unitAmount: price.unit_amount, taxBehavior: price.tax_behavior ?? null };
  }
  const option = options?.[currency];
  if (!option) return null;
  return { unitAmount: option.unit_amount, taxBehavior: option.tax_behavior ?? price.tax_behavior ?? null };
}

/** The parts of a Stripe invoice the VAT share is read from. */
export type InvoiceTaxShape = {
  total: number;
  total_excluding_tax: number | null;
  total_taxes?: { amount: number; tax_behavior: string }[] | null;
};

/**
 * The share of a VAT-inclusive subscription that is ours, from its latest
 * invoice: `total_excluding_tax / total`.
 *
 * Inclusive when the price says so (`tax_behavior: 'inclusive'`, on the price
 * or on its currency option) or when the invoice itself carries inclusive tax.
 * Undefined, which the math reads as 1, for a tax-exclusive price: there the
 * invoice total is list price PLUS tax, and the same division would wrongly
 * shave the tax off money we actually keep.
 *
 * Also undefined when the invoice is missing or unexpanded, so an inclusive
 * price with no invoice read yet counts gross. That overstates by the VAT rate
 * until its first invoice, which is the direction a reader can see coming. An
 * inclusive price whose latest invoice collected no tax (a customer outside a
 * registered country, or a legacy subscription before `automatic_tax` is on)
 * reads 1, which is the truth: none of it went to a tax authority.
 */
export function taxInclusiveRatio(
  inclusivePrice: boolean,
  invoice: InvoiceTaxShape | string | null | undefined,
): number | undefined {
  if (!invoice || typeof invoice === 'string') return undefined;
  const invoiceInclusive = (invoice.total_taxes ?? []).some(
    (tax) => tax.tax_behavior === 'inclusive' && tax.amount > 0,
  );
  if (!inclusivePrice && !invoiceInclusive) return undefined;
  if (!(invoice.total > 0) || invoice.total_excluding_tax == null) return undefined;
  return clampRatio(invoice.total_excluding_tax / invoice.total);
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

/**
 * Roll a set of subscriptions up into the numbers the board shows.
 *
 * `nowSeconds` and `windowDays` are parameters rather than reads of the clock
 * so the window arithmetic is testable.
 */
export function summarizeSubscriptions(
  subscriptions: SubscriptionFacts[],
  { nowSeconds, windowDays }: { nowSeconds: number; windowDays: number },
): RevenueSummary {
  const windowStart = nowSeconds - windowDays * 86_400;
  const external = subscriptions.filter((sub) => !sub.internal);
  const live = external.filter((sub) => LIVE_STATUSES.has(sub.status));

  // Every row is priced once, in USD, at the rate of the month it was last
  // billing in: now for a live subscription, the month it ended otherwise.
  // A fully comped row needs no rate (nothing times anything is nothing), so
  // an unknown currency can only ever hide money, never a comped customer.
  const price = (sub: SubscriptionFacts) => {
    const native = netMonthlyMinor(sub);
    const usd = native === 0 ? 0 : toUsdMinor(native, sub.currency, monthOf(sub.endedAt ?? nowSeconds));
    return { sub, native, monthly: usd };
  };
  const converted = (rows: { sub: SubscriptionFacts; native: number; monthly: number | null }[]) =>
    rows.filter((row): row is { sub: SubscriptionFacts; native: number; monthly: number } => row.monthly !== null);

  const livePriced = live.map(price);
  const otherCurrencies = [...new Set(livePriced.filter((row) => row.monthly === null).map((row) => row.sub.currency))].sort();
  const pricedAll = converted(livePriced);
  // A paused subscription is live (Stripe keeps it `active`) but bills
  // nothing until it resumes, so it is not MRR and not a paying customer.
  const paused = pricedAll.filter((row) => row.sub.paused === true);
  const priced = pricedAll.filter((row) => row.sub.paused !== true);
  const paying = priced.filter((row) => row.monthly > 0);

  const mrrMinor = Math.round(sum(paying.map((row) => row.monthly)));
  const atRisk = paying.filter((row) => AT_RISK_STATUSES.has(row.sub.status));
  const leaving = paying.filter((row) => row.sub.cancelAtPeriodEnd);
  const fresh = paying.filter((row) => row.sub.createdAt >= windowStart);

  // Churn is measured on when billing actually stopped, not on when someone
  // pressed cancel. A subscription cancelled at period end has a `canceled_at`
  // in the past and keeps paying until `ended_at`, and counting it as lost on
  // the click would book the loss weeks before it happens.
  //
  // Only `canceled` is churn. `incomplete_expired` also carries an `ended_at`,
  // but it is an abandoned checkout that never paid, and counting it booked
  // lost revenue from people who were never customers.
  const churned = converted(
    external
      .filter((sub) => sub.status === 'canceled')
      .filter((sub) => sub.endedAt !== null && sub.endedAt >= windowStart && sub.endedAt <= nowSeconds)
      .map(price),
  ).filter((row) => row.monthly > 0);

  const churnedMrrMinor = Math.round(sum(churned.map((row) => row.monthly)));
  const newMrrMinor = Math.round(sum(fresh.map((row) => row.monthly)));

  // The churn base: every external subscription that was billing at some
  // point in the window. Live ones, plus ones that ended inside it. Only
  // `canceled` counts as having ended from paying: `incomplete_expired` is an
  // abandoned checkout that never paid anything.
  const base = converted(
    external
      .filter((sub) =>
        LIVE_STATUSES.has(sub.status)
        || (sub.status === 'canceled' && sub.endedAt !== null && sub.endedAt >= windowStart))
      .map(price),
  ).filter((row) => row.monthly > 0);
  const cancelled = base.filter(
    (row) => row.sub.canceledAt !== null && row.sub.canceledAt >= windowStart && row.sub.canceledAt <= nowSeconds,
  );
  const baseMrrMinor = Math.round(sum(base.map((row) => row.monthly)));
  const movements = disjointMovements(paying, churned, windowStart);
  const cancelledMrrMinor = Math.round(sum(cancelled.map((row) => row.monthly)));

  return {
    currency: 'usd',
    mrrMinor,
    arrMinor: mrrMinor * 12,
    payingCustomers: paying.length,
    compedCustomers: priced.length - paying.length,
    arpaMinor: paying.length > 0 ? Math.round(mrrMinor / paying.length) : 0,
    atRiskMinor: Math.round(sum(atRisk.map((row) => row.monthly))),
    atRiskCustomers: atRisk.length,
    leavingMinor: Math.round(sum(leaving.map((row) => row.monthly))),
    leavingCustomers: leaving.length,
    pausedCustomers: paused.length,
    pausedMinor: Math.round(sum(paused.map((row) => row.monthly))),
    newMrrMinor,
    newCustomers: fresh.length,
    churnedMrrMinor,
    churnedCustomers: churned.length,
    netNewMrrMinor: newMrrMinor - churnedMrrMinor,
    cancelledCustomers: cancelled.length,
    cancelledMrrMinor,
    churnBaseCustomers: base.length,
    churnBaseMrrMinor: baseMrrMinor,
    customerChurnRate: base.length > 0 ? cancelled.length / base.length : null,
    revenueChurnRate: baseMrrMinor > 0 ? cancelledMrrMinor / baseMrrMinor : null,
    movements,
    byPlan: groupByPlan(paying),
    internalCustomers: subscriptions.filter((sub) => sub.internal && LIVE_STATUSES.has(sub.status)).length,
    byCurrency: groupByCurrency(livePriced.filter((row) => row.native > 0)),
    otherCurrencies,
  };
}

/**
 * Put each customer on exactly one movement row.
 *
 * Precedence, first match wins: billing stopped, set to stop, card failing,
 * new. A customer who signed up this month and already scheduled a cancel is
 * "set to stop", not also "new"; a failing card that is also set to stop is
 * leaving either way, so it is not double counted as "card failing". Ended
 * subscriptions are never live, so `stopped` cannot meet the other three.
 */
function disjointMovements(
  paying: { sub: SubscriptionFacts; monthly: number }[],
  churned: { sub: SubscriptionFacts; monthly: number }[],
  windowStart: number,
): Movements {
  const row = (rows: { monthly: number }[]): Movement => ({
    customers: rows.length,
    mrrMinor: Math.round(sum(rows.map((r) => r.monthly))),
  });
  const leaving = paying.filter((r) => r.sub.cancelAtPeriodEnd);
  const failing = paying.filter((r) => !r.sub.cancelAtPeriodEnd && AT_RISK_STATUSES.has(r.sub.status));
  const fresh = paying.filter(
    (r) => !r.sub.cancelAtPeriodEnd && !AT_RISK_STATUSES.has(r.sub.status) && r.sub.createdAt >= windowStart,
  );
  return { new: row(fresh), stopped: row(churned), leaving: row(leaving), failing: row(failing) };
}

/**
 * Live paying money per billing currency, native and converted. Rows with no
 * rate are kept here with a null USD figure: this is the one place they are
 * still counted, so "of which XYZ" never loses a customer either.
 */
function groupByCurrency(rows: { sub: SubscriptionFacts; native: number; monthly: number | null }[]): CurrencyShare[] {
  const byCode = new Map<string, { customers: number; native: number; usd: number | null }>();
  for (const { sub, native, monthly } of rows) {
    const entry = byCode.get(sub.currency) ?? { customers: 0, native: 0, usd: 0 };
    entry.customers += 1;
    entry.native += native;
    entry.usd = entry.usd === null || monthly === null ? null : entry.usd + monthly;
    byCode.set(sub.currency, entry);
  }
  return [...byCode.entries()]
    .map(([currency, entry]) => ({
      currency,
      customers: entry.customers,
      mrrMinor: Math.round(entry.native),
      mrrUsdMinor: entry.usd === null ? null : Math.round(entry.usd),
    }))
    .sort((a, b) => (b.mrrUsdMinor ?? -1) - (a.mrrUsdMinor ?? -1) || a.currency.localeCompare(b.currency));
}

function groupByPlan(rows: { sub: SubscriptionFacts; monthly: number }[]) {
  const byLabel = new Map<string, { label: string; customers: number; mrrMinor: number }>();
  for (const { sub, monthly } of rows) {
    const entry = byLabel.get(sub.planLabel) ?? { label: sub.planLabel, customers: 0, mrrMinor: 0 };
    entry.customers += 1;
    entry.mrrMinor += monthly;
    byLabel.set(sub.planLabel, entry);
  }
  return [...byLabel.values()]
    .map((entry) => ({ ...entry, mrrMinor: Math.round(entry.mrrMinor) }))
    .sort((a, b) => b.mrrMinor - a.mrrMinor || a.label.localeCompare(b.label));
}

/**
 * The plan mix, trimmed to what a wall tile can hold WITHOUT LOSING ANYBODY.
 *
 * The subscriber tile used to print the first three plans in a sentence and
 * stop. With four tiers each sold monthly and yearly there are up to eight
 * groups, so on 2026-09-07 the board was reading "Pro monthly 2, Personal
 * monthly 5, Pro yearly 1" under a headline of 10: two subscribers had simply
 * fallen off the end of the string, and nothing said so.
 *
 * The rule here is that the rows must always add up to the headline. When
 * there are more groups than rows, the tail collapses into one "Other plans"
 * row carrying its own count rather than being dropped, so the column still
 * sums to the number above it and the operator can see that something is
 * hidden. Groups arrive sorted by MRR, so the tail is always the cheapest end.
 */
export function planSplit(
  byPlan: { label: string; customers: number }[],
  maxRows: number,
): { label: string; customers: number }[] {
  const rows = Math.max(1, Math.floor(maxRows));
  if (byPlan.length <= rows) return byPlan.map(({ label, customers }) => ({ label, customers }));
  const shown = byPlan.slice(0, rows - 1).map(({ label, customers }) => ({ label, customers }));
  const rest = byPlan.slice(rows - 1);
  return [
    ...shown,
    { label: `Other ${rest.length} plans`, customers: sum(rest.map((plan) => plan.customers)) },
  ];
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/* --------------------------------------------------------------- valuation */

/**
 * The default ARR multiple behind the board's valuation figure.
 *
 * Three, moved down from four on 2026-09-07 and deliberately a round number
 * rather than a modelled one. Small bootstrapped B2B SaaS changes hands on the
 * acquisition marketplaces at roughly three to five times ARR, and at this size
 * the honest precision of the estimate is "one significant figure": a 3.2x would
 * imply a confidence that a handful of paying customers cannot support. Three is
 * the bottom of that band, which is the right end to sit at while the revenue is
 * this young.
 *
 * Overridable with `COMPANY_VALUATION_ARR_MULTIPLE` so the number can be moved
 * without a deploy. See `valuationMultiple()` in kiosk-revenue.ts for the
 * parsing, which is kept out of this module because reading an environment
 * variable is the one thing that would stop it being unit testable without a
 * process.
 */
export const DEFAULT_VALUATION_ARR_MULTIPLE = 3;

export type Valuation = {
  /** ARR times the multiple, minor units. */
  valuationMinor: number;
  /** The multiple actually applied, after clamping. */
  multiple: number;
  /** The ARR it was derived from, so the tile can show its own working. */
  arrMinor: number;
};

/**
 * ARR times a multiple, and nothing more.
 *
 * WHAT THIS IS NOT: a valuation. It is one arithmetic convention applied to one
 * month of recurring revenue, and the board says so in words beside it, because
 * a large currency figure on a wall is the single easiest number in this
 * building to mistake for a fact. It moves the instant MRR moves and it carries
 * every one of MRR's caveats: comps contribute nothing, yearly plans are shown
 * at a twelfth per month, and a failing card is still counted until dunning
 * gives up.
 *
 * ZERO ARR GIVES ZERO, not a floor. A business with no recurring revenue is
 * worth nothing on this convention, and inventing a floor for it would be the
 * one edit here that turns an arithmetic aid into a flattering lie.
 *
 * The multiple is clamped to a sane band so a fat-fingered environment
 * variable produces an obviously wrong small number rather than a nine figure
 * headline nobody questions on a Monday morning.
 */
export function valuationFromArr(arrMinor: number, multiple: number): Valuation {
  const safeMultiple = Number.isFinite(multiple) ? Math.min(20, Math.max(0, multiple)) : DEFAULT_VALUATION_ARR_MULTIPLE;
  const safeArr = Number.isFinite(arrMinor) && arrMinor > 0 ? arrMinor : 0;
  return {
    valuationMinor: Math.round(safeArr * safeMultiple),
    multiple: safeMultiple,
    arrMinor: safeArr,
  };
}
