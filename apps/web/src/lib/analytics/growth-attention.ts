/**
 * "What needs attention this week": the computed to-do list on /admin/growth.
 *
 * WHY THIS EXISTS. Every other panel on that page reports a number and leaves
 * the reader to decide whether it is bad. That works for someone who opens the
 * page daily and knows what normal looks like; it fails for someone who opens
 * it weekly, which is the only reader this page has. Two versions of the page
 * were judged not worth opening, and both of them made the reader do this
 * derivation by eye, every time, from twenty numbers.
 *
 * THE RULES ARE THRESHOLDS IN CODE, NOT JUDGEMENT. Every item below is
 * produced by a comparison against a named constant, states the number that
 * triggered it, and states the population that number was counted over. A list
 * that occasionally said something the numbers do not support would be worse
 * than no list at all, because it is the one part of the page a reader is
 * invited to act on without checking.
 *
 * AN EMPTY LIST IS A RESULT, NOT AN ABSENCE. `checksRun` and `checksBlocked`
 * come back with the items so the page can say "17 checks ran, none tripped"
 * rather than rendering nothing, which reads as a panel that failed to load.
 * A rule whose data did not load returns BLOCKED and is counted, so a Stripe
 * outage cannot quietly turn "money at risk" into "nothing to do".
 *
 * PURE, NO I/O, testable with `node --test`. Same convention as revenue-math.ts
 * and growth-records.ts: relative imports carry an explicit `.ts` so the plain
 * strip-types runner can follow the module graph without a bundler.
 *
 * The money formatter is imported from the charts folder rather than written
 * again here, for the reason operator-revenue.ts gives about building a "$5.00
 * off" string locally: two formatters on one screen eventually round in two
 * directions.
 */

import type { CashCollected, CheckoutFunnel } from './kiosk-revenue.ts';
import type { GmailCapProjection } from './growth-metrics.ts';
import type { GrowthErrorRow, GrowthLifecycleRow, GrowthUpgradePressureRow } from './growth-types.ts';
import type { HealthLevel } from './health-math.ts';
import type { RevenueSummary } from './revenue-math.ts';
import { daysBetween } from './growth-records.ts';
import { formatCount, formatMoney, formatPercent } from '../../../components/admin/charts/format.ts';

/**
 * 'act' is something to do this week. 'watch' is something to know about and
 * probably not act on yet. There is no 'critical': the alarm for the product
 * actually being down is the health banner, which shouts on its own, and a
 * third severity here would only compete with it.
 */
export type AttentionSeverity = 'act' | 'watch';

export type AttentionItem = {
  /** Stable id, used as the React key and to keep the sort deterministic. */
  id: string;
  severity: AttentionSeverity;
  /** One sentence. Contains the number that triggered the rule. */
  title: string;
  /** Who it was counted over and across what window. Never omitted. */
  population: string;
};

export type AttentionReport = {
  items: AttentionItem[];
  /** Rules that had the data they needed and reached a verdict. */
  checksRun: number;
  /** Rules skipped because the read they depend on failed. */
  checksBlocked: number;
};

/**
 * The subset of `SystemHealth` these rules read. Declared structurally rather
 * than imported whole so this module never pulls in kiosk-health.ts, which
 * constructs a Supabase client at import time and would take the test runner
 * with it.
 */
export type AttentionHealth = {
  level: HealthLevel;
  reason: string;
  monitor: { openIncidents: number };
};

/** Same trick for the incident rows: only the fields the rule actually reads. */
export type AttentionIncident = {
  status: 'open' | 'resolved';
  failureClass: string;
  lastFailureAt: string;
};

/**
 * Everything the rules are allowed to look at. `null` means that read failed,
 * which is a different fact from a zero and is reported as a blocked check.
 */
export type AttentionInput = {
  revenue: RevenueSummary | null;
  checkout: CheckoutFunnel | null;
  cash: CashCollected | null;
  gmail: GmailCapProjection | null;
  pressure: GrowthUpgradePressureRow | null;
  lifecycle: GrowthLifecycleRow | null;
  health: AttentionHealth | null;
  incidents: AttentionIncident[] | null;
  errors: GrowthErrorRow[] | null;
  /** The reporting window the movement figures were counted over. */
  windowDays: number;
};

/**
 * Every number a rule compares against, in one block so the list can be read
 * as a policy rather than reverse-engineered from thirteen call sites.
 *
 * The counts are all deliberately small, because the business is: at six
 * paying customers a threshold of "ten churned subscriptions" would never fire
 * once before the company either worked or did not.
 */
export const ATTENTION_THRESHOLDS = {
  /**
   * Free workspaces standing at the inbox ceiling that have ALREADY used a
   * mailbox. Ten rather than one because at one this fires forever and stops
   * being read; the population it counts has been in the dozens all year.
   */
  ceilingActivated: 10,
  /** Days with no completed checkout before the quiet is worth a line. */
  quietSaleDays: 30,
  /** Abandoned checkouts before the count is a finding rather than noise. */
  abandonedCheckouts: 3,
  /** Share of activated people who used it once and never came back. */
  oneAndDoneShare: 0.5,
  /** Below this denominator the share above is not computed at all. */
  oneAndDoneMinimum: 30,
  /** Share of all failures owned by a single tool and error code. */
  errorShare: 1 / 3,
  /** And the floor that share needs, so three failures cannot be "a third". */
  errorFloor: 50,
} as const;

/** A rule that could not reach a verdict because its data did not load. */
const BLOCKED = Symbol('blocked');
type RuleOutcome = AttentionItem | null | typeof BLOCKED;

type Rule = (input: AttentionInput, now: number) => RuleOutcome;

/**
 * Build the list.
 *
 * `now` is a parameter rather than a read of the clock so every date-dependent
 * rule stays testable, the same convention `gmailCapProjection` and `streak`
 * follow.
 *
 * Items come back sorted 'act' before 'watch', and stable within a severity in
 * the order the rules are declared below. That order is itself a claim: money
 * that has stopped arriving is above a funnel that is leaking, which is above
 * a measurement caveat.
 */
export function attentionReport(input: AttentionInput, now: number = Date.now()): AttentionReport {
  const items: AttentionItem[] = [];
  let checksRun = 0;
  let checksBlocked = 0;

  for (const rule of RULES) {
    const outcome = rule(input, now);
    if (outcome === BLOCKED) {
      checksBlocked += 1;
      continue;
    }
    checksRun += 1;
    if (outcome) items.push(outcome);
  }

  const bySeverity = (item: AttentionItem) => (item.severity === 'act' ? 0 : 1);
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => bySeverity(a.item) - bySeverity(b.item) || a.index - b.index)
    .map((entry) => entry.item);

  return { items: ordered, checksRun, checksBlocked };
}

/* ------------------------------------------------------------------- rules */

/**
 * Stripe is in test mode.
 *
 * First in the list on purpose. It does not describe the business at all; it
 * says the four largest numbers on the page are not real money, and every rule
 * below it is then reading fiction. This is a live condition rather than a
 * hypothetical: `.env.local` holds a test key, so any locally rendered copy of
 * this page trips it.
 */
const stripeModeRule: Rule = ({ cash }) => {
  if (!cash) return BLOCKED;
  if (cash.mode === 'live') return null;
  return {
    id: 'stripe-mode',
    severity: 'act',
    title:
      cash.mode === 'test'
        ? 'Money on this page is Stripe TEST data, not revenue.'
        : 'Stripe mode could not be determined, so the money figures are unverified.',
    population: 'Every MRR, ARR and cash figure above, from the key this deployment holds.',
  };
};

/** The product is not answering. The health banner shouts; this makes it a task. */
const healthRule: Rule = ({ health }) => {
  if (!health) return BLOCKED;
  if (health.level === 'ok') return null;
  if (health.level === 'unknown') {
    return {
      id: 'health-unknown',
      severity: 'watch',
      title: 'Service health could not be classified.',
      population: `Live call window and the synthetic monitor. ${health.reason}`,
    };
  }
  return {
    id: 'health-degraded',
    severity: 'act',
    title: health.level === 'down' ? 'The product is failing calls right now.' : 'The product is degraded right now.',
    population: health.reason,
  };
};

/** An incident the monitor opened and has not seen recover. */
const openIncidentRule: Rule = ({ health, incidents }) => {
  if (!health) return BLOCKED;
  const open = health.monitor.openIncidents;
  if (open <= 0) return null;
  const newest = (incidents ?? []).find((incident) => incident.status === 'open');
  return {
    id: 'open-incident',
    severity: 'act',
    title: `${formatCount(open)} monitor ${open === 1 ? 'incident is' : 'incidents are'} still open.`,
    population: newest
      ? `Synthetic monitor, every 5 minutes. Newest: ${newest.failureClass} at the ${newest.lastFailureAt.slice(0, 16).replace('T', ' ')} UTC run.`
      : 'Synthetic monitor, every 5 minutes.',
  };
};

/**
 * Money Stripe cannot collect.
 *
 * Reported as an amount and a count, never as a rate: at six customers a
 * "16.7% of MRR at risk" is one card declining.
 */
const atRiskRule: Rule = ({ revenue }) => {
  if (!revenue) return BLOCKED;
  if (revenue.atRiskMinor <= 0) return null;
  return {
    id: 'mrr-at-risk',
    severity: 'act',
    title: `${formatMoney(revenue.atRiskMinor, revenue.currency)} of MRR is on subscriptions Stripe cannot collect.`,
    population: `${formatCount(revenue.atRiskCustomers)} live subscription(s) in past_due or unpaid, from Stripe, now.`,
  };
};

/** Live, paying, and already told to stop at the end of the period. */
const leavingRule: Rule = ({ revenue }) => {
  if (!revenue) return BLOCKED;
  if (revenue.leavingMinor <= 0) return null;
  return {
    id: 'mrr-leaving',
    severity: 'act',
    title: `${formatMoney(revenue.leavingMinor, revenue.currency)} of MRR is set to stop at the end of its period.`,
    population: `${formatCount(revenue.leavingCustomers)} live subscription(s) with cancel_at_period_end, from Stripe, now.`,
  };
};

/**
 * Churn outran new business inside the window.
 *
 * Stated as both figures rather than as the net, for the reason the ledger
 * above it is split at all: a net of zero cannot tell a quiet month from one
 * sale cancelling one churn, and only one of those is a problem.
 */
const churnRule: Rule = ({ revenue, windowDays }) => {
  if (!revenue) return BLOCKED;
  if (revenue.churnedMrrMinor <= 0 || revenue.churnedMrrMinor <= revenue.newMrrMinor) return null;
  return {
    id: 'churn-outran-new',
    severity: 'act',
    title: `Churned MRR (${formatMoney(revenue.churnedMrrMinor, revenue.currency)}) beat new MRR (${formatMoney(revenue.newMrrMinor, revenue.currency)}).`,
    population: `${formatCount(revenue.churnedCustomers)} ended and ${formatCount(revenue.newCustomers)} started, from Stripe, last ${formatCount(windowDays)} days.`,
  };
};

/** Nobody has bought anything for a while, or ever. */
const quietSaleRule: Rule = ({ checkout }, now) => {
  if (!checkout) return BLOCKED;
  if (!checkout.lastCompletedAt) {
    return checkout.checkoutStarted > 0
      ? {
          id: 'never-sold',
          severity: 'act',
          title: 'No checkout has ever completed.',
          population: `${formatCount(checkout.checkoutStarted)} external workspace(s) have started one, all time.`,
        }
      : null;
  }
  const days = daysBetween(checkout.lastCompletedAt, now);
  if (days === null || days < ATTENTION_THRESHOLDS.quietSaleDays) return null;
  return {
    id: 'quiet-sale',
    severity: 'watch',
    title: `No completed checkout in ${formatCount(days)} days.`,
    population: 'External workspaces, from the billing event stream, all time.',
  };
};

/**
 * People standing at the inbox ceiling who have actually used a mailbox.
 *
 * The `at_ceiling_activated` column and not `at_ceiling`: a free workspace
 * that hit the cap without ever reading a message is not a thwarted customer,
 * it is someone who left. This is the only number on the page that names a
 * population which is both reachable and demonstrably interested.
 */
const ceilingRule: Rule = ({ pressure }) => {
  if (!pressure) return BLOCKED;
  if (pressure.at_ceiling_activated < ATTENTION_THRESHOLDS.ceilingActivated) return null;
  return {
    id: 'inbox-ceiling',
    severity: 'act',
    title: `${formatCount(pressure.at_ceiling_activated)} free workspaces have used a mailbox and cannot connect another.`,
    population: `Live free workspaces the inbox cap applies to (${formatCount(pressure.capped_workspaces)} in total), now. Grandfathered and comped accounts are excluded and can never be charged.`,
  };
};

/** Checkouts opened and never finished: money left on Stripe's page. */
const abandonedRule: Rule = ({ checkout }) => {
  if (!checkout) return BLOCKED;
  if (checkout.abandoned < ATTENTION_THRESHOLDS.abandonedCheckouts) return null;
  if (checkout.abandoned <= checkout.checkoutCompleted) return null;
  return {
    id: 'abandoned-checkouts',
    severity: 'watch',
    title: `${formatCount(checkout.abandoned)} checkouts were started and never finished, against ${formatCount(checkout.checkoutCompleted)} completed.`,
    population: 'Distinct external workspaces, from the billing event stream, all time.',
  };
};

/**
 * People who reached a mailbox once and never came back.
 *
 * Not computed at all below a denominator of 30, which is the same instinct
 * `ratio()` encodes: a share over a handful of people is a sentence about
 * three individuals wearing the clothes of a trend.
 */
const oneAndDoneRule: Rule = ({ lifecycle }) => {
  if (!lifecycle) return BLOCKED;
  const activated = lifecycle.value_activated;
  if (activated < ATTENTION_THRESHOLDS.oneAndDoneMinimum) return null;
  const share = lifecycle.one_and_done / activated;
  if (share < ATTENTION_THRESHOLDS.oneAndDoneShare) return null;
  return {
    id: 'one-and-done',
    severity: 'watch',
    title: `${formatPercent(share)} of everyone who reached a mailbox used it on exactly one day.`,
    population: `${formatCount(lifecycle.one_and_done)} of ${formatCount(activated)} value-activated workspaces, all time, that day now past.`,
  };
};

/** Google's cap on the unverified OAuth client: the one hard calendar deadline. */
const gmailCapRule: Rule = ({ gmail }) => {
  if (!gmail) return BLOCKED;
  if (gmail.level === 'ok') return null;
  const when = gmail.projectedExhaustion ? `full around ${gmail.projectedExhaustion}` : 'not currently filling';
  return {
    id: 'gmail-cap',
    severity: gmail.level === 'danger' ? 'act' : 'watch',
    title: `Gmail OAuth cap: ${formatCount(gmail.used)} of ${formatCount(gmail.cap)} slots used, ${when}.`,
    population: `Distinct Gmail grants ever, deleted inboxes included, at ${gmail.ratePerMonth} per month. Verification plus the CASA assessment take weeks and the cap does not pause for them.`,
  };
};

/**
 * One tool and error code owning a third or more of every failure.
 *
 * A broad, shallow error rate is the health check's business. This rule is
 * looking for the other shape: a single call that is reliably broken and is
 * being averaged into invisibility by 165,000 successful ones.
 */
const errorConcentrationRule: Rule = ({ errors, windowDays }) => {
  if (!errors) return BLOCKED;
  const total = errors.reduce((sum, row) => sum + row.failures, 0);
  if (total < ATTENTION_THRESHOLDS.errorFloor) return null;
  const worst = errors.reduce<GrowthErrorRow | null>(
    (best, row) => (!best || row.failures > best.failures ? row : best),
    null,
  );
  if (!worst || worst.failures / total < ATTENTION_THRESHOLDS.errorShare) return null;
  return {
    id: 'error-concentration',
    severity: 'watch',
    title: `${worst.tool_name} (${worst.error_code ?? 'no code'}) is ${formatPercent(worst.failures / total)} of all failures.`,
    population: `${formatCount(worst.failures)} of ${formatCount(total)} failed calls, every workspace including ours, last ${formatCount(windowDays)} days.`,
  };
};

/**
 * The headline understates the truth.
 *
 * Two separate ways that happens, reported as one line because the action is
 * the same: stop quoting the number as a total. `truncated` means Stripe held
 * more objects than the read's ceiling; `otherCurrencies` means live
 * subscriptions exist that the MRR figure does not add up, deliberately,
 * rather than converting francs into dollars and calling the result revenue.
 */
const floorRule: Rule = ({ revenue, cash }) => {
  if (!revenue || !cash) return BLOCKED;
  const reasons: string[] = [];
  if (cash.truncated) reasons.push('the charge history hit its read ceiling');
  if (revenue.otherCurrencies.length > 0) {
    reasons.push(`live subscriptions exist in ${revenue.otherCurrencies.join(', ').toUpperCase()}`);
  }
  if (reasons.length === 0) return null;
  return {
    id: 'figures-are-floors',
    severity: 'watch',
    title: `The money figures are floors, not totals: ${reasons.join(', and ')}.`,
    population: 'Stripe subscriptions and charges, external accounts only.',
  };
};

/**
 * Declaration order is the tie-break inside a severity, so this list is the
 * page's priority order and is meant to be read as one.
 */
const RULES: Rule[] = [
  stripeModeRule,
  healthRule,
  openIncidentRule,
  atRiskRule,
  leavingRule,
  churnRule,
  ceilingRule,
  abandonedRule,
  quietSaleRule,
  oneAndDoneRule,
  gmailCapRule,
  errorConcentrationRule,
  floorRule,
];

/** How many rules exist at all, for the "n checks ran" line. */
export const ATTENTION_CHECK_COUNT = RULES.length;
