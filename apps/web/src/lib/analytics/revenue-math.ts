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
 */

/** A Stripe subscription reduced to the facts the money math needs. */
export type SubscriptionFacts = {
  id: string;
  /** Raw Stripe status. */
  status: string;
  /** Unix seconds the subscription was created. */
  createdAt: number;
  /** Unix seconds it actually stopped billing, null while it is still live. */
  endedAt: number | null;
  /** Live, but already scheduled to stop at the end of the current period. */
  cancelAtPeriodEnd: boolean;
  /** ISO 4217, lowercase, as Stripe reports it. */
  currency: string;
  /** List price per month in minor units, before any coupon. */
  grossMonthlyMinor: number;
  /** Coupon reductions, already normalised to a month. */
  discount: DiscountFacts;
  /** Plan and interval as a person would say it, or 'Other'. */
  planLabel: string;
  /** One of our own accounts rather than a customer's. */
  internal: boolean;
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

/** Statuses where the money is live but not arriving. */
const AT_RISK_STATUSES = new Set(['past_due', 'unpaid']);

export type RevenueSummary = {
  /** Currency every figure below is denominated in. */
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
  /** Subscriptions that started inside the window, and what they were worth. */
  newMrrMinor: number;
  newCustomers: number;
  /** Subscriptions that stopped inside the window, and what they took with them. */
  churnedMrrMinor: number;
  churnedCustomers: number;
  /** `newMrrMinor - churnedMrrMinor`. See the module note on expansion. */
  netNewMrrMinor: number;
  /** Where the money sits, biggest first. */
  byPlan: { label: string; customers: number; mrrMinor: number }[];
  /** Our own live subscriptions, excluded from every figure above. */
  internalCustomers: number;
  /**
   * Currencies held by live subscriptions other than the reported one. Non
   * empty means the headline understates the true total and the tile says so,
   * rather than adding francs to dollars and calling the result revenue.
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

/** List price less coupons, floored at zero. Stripe never bills a negative. */
export function netMonthlyMinor(facts: SubscriptionFacts): number {
  const afterPercent = facts.grossMonthlyMinor * (1 - clampPercent(facts.discount.percentOff) / 100);
  const afterFlat = afterPercent - Math.max(0, facts.discount.amountOffMonthlyMinor);
  return Math.max(0, Math.round(afterFlat));
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

  const currency = primaryCurrency(live);
  const inCurrency = live.filter((sub) => sub.currency === currency);
  const otherCurrencies = [...new Set(live.filter((sub) => sub.currency !== currency).map((sub) => sub.currency))].sort();

  const priced = inCurrency.map((sub) => ({ sub, monthly: netMonthlyMinor(sub) }));
  const paying = priced.filter((row) => row.monthly > 0);

  const mrrMinor = Math.round(sum(paying.map((row) => row.monthly)));
  const atRisk = paying.filter((row) => AT_RISK_STATUSES.has(row.sub.status));
  const leaving = paying.filter((row) => row.sub.cancelAtPeriodEnd);
  const fresh = paying.filter((row) => row.sub.createdAt >= windowStart);

  // Churn is measured on when billing actually stopped, not on when someone
  // pressed cancel. A subscription cancelled at period end has a `canceled_at`
  // in the past and keeps paying until `ended_at`, and counting it as lost on
  // the click would book the loss weeks before it happens.
  const churned = external
    .filter((sub) => sub.endedAt !== null && sub.endedAt >= windowStart && sub.endedAt <= nowSeconds)
    .filter((sub) => sub.currency === currency)
    .map((sub) => ({ sub, monthly: netMonthlyMinor(sub) }))
    .filter((row) => row.monthly > 0);

  const churnedMrrMinor = Math.round(sum(churned.map((row) => row.monthly)));
  const newMrrMinor = Math.round(sum(fresh.map((row) => row.monthly)));

  return {
    currency,
    mrrMinor,
    arrMinor: mrrMinor * 12,
    payingCustomers: paying.length,
    compedCustomers: priced.length - paying.length,
    arpaMinor: paying.length > 0 ? Math.round(mrrMinor / paying.length) : 0,
    atRiskMinor: Math.round(sum(atRisk.map((row) => row.monthly))),
    atRiskCustomers: atRisk.length,
    leavingMinor: Math.round(sum(leaving.map((row) => row.monthly))),
    leavingCustomers: leaving.length,
    newMrrMinor,
    newCustomers: fresh.length,
    churnedMrrMinor,
    churnedCustomers: churned.length,
    netNewMrrMinor: newMrrMinor - churnedMrrMinor,
    byPlan: groupByPlan(paying),
    internalCustomers: subscriptions.filter((sub) => sub.internal && LIVE_STATUSES.has(sub.status)).length,
    otherCurrencies,
  };
}

/**
 * The currency the board reports in: whichever one holds the most live money.
 *
 * Defaults to USD when there are no live subscriptions at all, so an empty
 * account still renders "$0" rather than a blank where the symbol should be.
 */
function primaryCurrency(live: SubscriptionFacts[]): string {
  const totals = new Map<string, number>();
  for (const sub of live) {
    totals.set(sub.currency, (totals.get(sub.currency) ?? 0) + netMonthlyMinor(sub));
  }
  let best = 'usd';
  let bestTotal = -1;
  for (const [currency, total] of totals) {
    if (total > bestTotal) {
      best = currency;
      bestTotal = total;
    }
  }
  return best;
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

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/* --------------------------------------------------------------- valuation */

/**
 * The default ARR multiple behind the board's valuation figure.
 *
 * Four, chosen 2026-09-01 and deliberately a round number rather than a
 * modelled one. Small bootstrapped B2B SaaS changes hands on the acquisition
 * marketplaces at roughly three to five times ARR, and at this size the honest
 * precision of the estimate is "one significant figure": a 4.2x would imply a
 * confidence that four paying customers cannot support.
 *
 * Overridable with `COMPANY_VALUATION_ARR_MULTIPLE` so the number can be moved
 * without a deploy. See `valuationMultiple()` in kiosk-revenue.ts for the
 * parsing, which is kept out of this module because reading an environment
 * variable is the one thing that would stop it being unit testable without a
 * process.
 */
export const DEFAULT_VALUATION_ARR_MULTIPLE = 4;

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
