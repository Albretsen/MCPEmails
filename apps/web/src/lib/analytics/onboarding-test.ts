/**
 * The onboarding test read-out: the onb_flow x onb_convert 2x2 (plan section 8,
 * Documents/plans/onboarding-research-20261026.md).
 *
 * Pure arithmetic over growth_onboarding_arms / _daily rows, so the band and
 * its tests agree on what each rate means. Enrolled customer workspaces only:
 * internal accounts see the new flow but are never enrolled.
 *
 * Each key is read on its own margin (flow: control vs new, summed over
 * convert; convert: off vs on, summed over flow), which is what a 2x2 with
 * independent 50/50 splits allows.
 *
 * WHAT DECIDES WHAT. The ship decision is the pre-registered read-out
 * (activation 8 weeks after the start, paid-30 four weeks later). Before
 * that this band only looks for harm and broken plumbing: the sample ratio,
 * assignment coverage, the 24 h first call, and connect failures.
 */

import type { GrowthOnboardingArmRow, GrowthOnboardingDayRow } from './growth-types';

export type OnboardingExperimentRow = {
  key: string;
  status: string;
  started_at: string | null;
  concluded_at: string | null;
  winner_variant_id: string | null;
};

export type OnbKey = 'flow' | 'convert';

export const ARM_NAMES: Record<OnbKey, [control: string, variant: string]> = {
  flow: ['control', 'new'],
  convert: ['off', 'on'],
};

export const ARM_LABELS: Record<string, string> = {
  control: 'Today',
  new: 'Setup dialog',
  off: 'Off',
  on: 'Flow B',
};

/** Bars, from the plan. Move them here if they turn out wrong. */
export const ONB_BARS = {
  /** Enrolled share of new customer workspaces since the start. */
  coverage: 0.98,
  /** A sample ratio this unlikely under 50/50 means assignment is broken. */
  srmP: 0.001,
  /** Called harm when the variant is this likely to be worse than control. */
  harm: 0.05,
  /** onb_convert ships at this chance of beating control on paid-30. */
  ship: 0.8,
  /** Below this many matured workspaces per arm a check waits. */
  minPerArm: 30,
} as const;

/** Read-outs, counted from the start: 8 weeks (+1 day for the 24 h metric), then 4 more weeks for paid-30. */
export const READOUT_DAYS = { activation: 57, paid: 85 } as const;

export type Totals = Omit<GrowthOnboardingArmRow, 'flow' | 'convert' | 'first_assigned_at'>;

const ZERO: Totals = {
  assigned: 0,
  mature_1d: 0,
  inbox_1d: 0,
  value_1d: 0,
  mature_3d: 0,
  draft_3d: 0,
  mature_7d: 0,
  habit_7d: 0,
  mature_30d: 0,
  paid_30d: 0,
  paid_any: 0,
  connect_ws: 0,
  connect_failed_ws: 0,
  completed: 0,
};

/** Sum the rows in one arm of one key. PostgREST returns bigint as number or string. */
export function armTotals(rows: GrowthOnboardingArmRow[], key: OnbKey, arm: string): Totals {
  const out = { ...ZERO };
  for (const row of rows) {
    if (row[key] !== arm) continue;
    for (const k of Object.keys(ZERO) as (keyof Totals)[]) out[k] += Number(row[k]) || 0;
  }
  return out;
}

export type Ratio = { num: number; den: number };

export const ratio = (r: Ratio): number | null => (r.den > 0 ? r.num / r.den : null);

/** Standard normal CDF (Abramowitz and Stegun 7.1.26, error under 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/**
 * Chance that B's true rate is above A's, with flat Beta(1, 1) priors and a
 * normal approximation of the two posteriors. Null without data in both arms.
 */
export function chanceBeats(a: Ratio, b: Ratio): number | null {
  if (a.den <= 0 || b.den <= 0) return null;
  const post = ({ num, den }: Ratio) => {
    const alpha = num + 1;
    const beta = den - num + 1;
    const n = alpha + beta;
    return { mean: alpha / n, variance: (alpha * beta) / (n * n * (n + 1)) };
  };
  const pa = post(a);
  const pb = post(b);
  return normalCdf((pb.mean - pa.mean) / Math.sqrt(pa.variance + pb.variance));
}

/** p-value of a 50/50 split given these counts (chi-square, 1 degree of freedom). */
export function sampleRatioP(a: number, b: number): number | null {
  const n = a + b;
  if (n <= 0) return null;
  const chi = ((a - b) * (a - b)) / n;
  return 2 * (1 - normalCdf(Math.sqrt(chi)));
}

export type Metric = {
  key: string;
  label: string;
  /** Applies to this onb key; flow-only rows are blank for convert and vice versa. */
  of: (t: Totals) => Ratio;
  /** Lower is better (failures). */
  lowerIsBetter?: boolean;
  primaryFor?: OnbKey;
};

export const METRICS: Metric[] = [
  { key: 'value_1d', label: 'First call on a real inbox in 24 h', of: (t) => ({ num: t.value_1d, den: t.mature_1d }), primaryFor: 'flow' },
  { key: 'inbox_1d', label: 'Inbox connected in 24 h', of: (t) => ({ num: t.inbox_1d, den: t.mature_1d }) },
  { key: 'draft_3d', label: 'A draft in 3 days', of: (t) => ({ num: t.draft_3d, den: t.mature_3d }) },
  { key: 'habit_7d', label: 'Active on 2+ days in week 1', of: (t) => ({ num: t.habit_7d, den: t.mature_7d }) },
  { key: 'paid_30d', label: 'Paid within 30 days', of: (t) => ({ num: t.paid_30d, den: t.mature_30d }), primaryFor: 'convert' },
  { key: 'paid_any', label: 'Paid so far (immature)', of: (t) => ({ num: t.paid_any, den: t.assigned }) },
  {
    key: 'connect_failed',
    label: 'Tried to connect, never succeeded',
    of: (t) => ({ num: t.connect_failed_ws, den: t.connect_ws }),
    lowerIsBetter: true,
  },
];

export type Comparison = {
  metric: Metric;
  control: Ratio;
  variant: Ratio;
  /** Chance the variant is better (for lowerIsBetter: lower). */
  better: number | null;
};

export function compare(rows: GrowthOnboardingArmRow[], key: OnbKey): Comparison[] {
  const [c, v] = ARM_NAMES[key];
  const ct = armTotals(rows, key, c);
  const vt = armTotals(rows, key, v);
  return METRICS.map((metric) => {
    const control = metric.of(ct);
    const variant = metric.of(vt);
    const beats = chanceBeats(control, variant);
    return { metric, control, variant, better: beats === null ? null : metric.lowerIsBetter ? 1 - beats : beats };
  });
}

export type ReleaseState =
  | { kind: 'off'; reason: string; detail: string }
  | { kind: 'stuck'; reason: string; detail: string }
  | { kind: 'running'; startedAt: string | null }
  | { kind: 'concluded'; winners: Partial<Record<OnbKey, string>> };

/**
 * Where the release is. Enrolment needs BOTH the experiment row `running` and
 * ONBOARDING_EXPERIMENT_PUBLIC=1 (src/lib/onboarding/variant.ts).
 */
export function releaseState(experiments: OnboardingExperimentRow[], publicEnrollment: boolean): ReleaseState {
  const flow = experiments.find((e) => e.key === 'onb_flow');
  const convert = experiments.find((e) => e.key === 'onb_convert');
  if (!flow || !convert) {
    return { kind: 'stuck', reason: 'An experiment row is missing.', detail: 'Seeded by migration 20261026152301.' };
  }
  if (flow.status === 'concluded' && convert.status === 'concluded') {
    return {
      kind: 'concluded',
      winners: { flow: flow.winner_variant_id ?? undefined, convert: convert.winner_variant_id ?? undefined },
    };
  }
  const running = [flow, convert].filter((e) => e.status === 'running');
  if (running.length === 0) {
    return {
      kind: 'off',
      reason: "Customers get today's first run.",
      detail: `onb_flow is ${flow.status}, onb_convert is ${convert.status}, ONBOARDING_EXPERIMENT_PUBLIC is ${publicEnrollment ? '1' : 'unset'}. Starting the test takes both rows running in Experiments and the variable set to 1 on Vercel. Internal accounts get the setup dialog and are never enrolled.`,
    };
  }
  if (!publicEnrollment) {
    return {
      kind: 'stuck',
      reason: 'Running, but nobody is enrolled.',
      detail: `${running.map((e) => e.key).join(' and ')} ${running.length > 1 ? 'are' : 'is'} running but ONBOARDING_EXPERIMENT_PUBLIC is not 1 on Vercel.`,
    };
  }
  const starts = running.map((e) => e.started_at).filter((s): s is string => Boolean(s)).sort();
  return { kind: 'running', startedAt: starts[0] ?? null };
}

/** Days strictly after the start day (the start day is partial), up to yesterday. */
export function coverage(daily: GrowthOnboardingDayRow[], startedAt: string | null, today: string): Ratio {
  if (!startedAt) return { num: 0, den: 0 };
  const startDay = startedAt.slice(0, 10);
  let num = 0;
  let den = 0;
  for (const row of daily) {
    if (row.day <= startDay || row.day >= today) continue;
    den += Number(row.created) || 0;
    num += (Number(row.flow_control) || 0) + (Number(row.flow_new) || 0);
  }
  return { num, den };
}

/** The primary metric over every customer workspace in the window, enrolled or not. */
export function baseline(daily: GrowthOnboardingDayRow[]): Ratio {
  let num = 0;
  let den = 0;
  for (const row of daily) {
    num += Number(row.value_1d) || 0;
    den += Number(row.mature_1d) || 0;
  }
  return { num, den };
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);
}

export type CheckState = 'pass' | 'fail' | 'wait';

export type Check = { key: string; question: string; state: CheckState; detail: string };

const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const chance = (value: number | null) => (value === null ? 'n/a' : `${Math.round(value * 100)}%`);

/** The harm and plumbing checks, judged while the test runs. */
export function onboardingChecks(
  rows: GrowthOnboardingArmRow[],
  daily: GrowthOnboardingDayRow[],
  startedAt: string | null,
  today: string,
): Check[] {
  const checks: Check[] = [];

  for (const key of ['flow', 'convert'] as OnbKey[]) {
    const [c, v] = ARM_NAMES[key];
    const a = armTotals(rows, key, c).assigned;
    const b = armTotals(rows, key, v).assigned;
    const p = sampleRatioP(a, b);
    checks.push({
      key: `srm_${key}`,
      question: `Is onb_${key} split 50/50?`,
      state: a + b < 2 * ONB_BARS.minPerArm || p === null ? 'wait' : p < ONB_BARS.srmP ? 'fail' : 'pass',
      detail: `${a} ${ARM_LABELS[c]} vs ${b} ${ARM_LABELS[v]}${p === null ? '' : `, p = ${p < 0.001 ? '<0.001' : p.toFixed(3)}`}`,
    });
  }

  const cov = coverage(daily, startedAt, today);
  const covRate = ratio(cov);
  checks.push({
    key: 'coverage',
    question: 'Is every new workspace enrolled?',
    state: cov.den === 0 || covRate === null ? 'wait' : covRate >= ONB_BARS.coverage ? 'pass' : 'fail',
    detail: `${cov.num} of ${cov.den} new customer workspaces since the first full day (${pct(covRate)}, bar ${pct(ONB_BARS.coverage)})`,
  });

  for (const key of ['flow', 'convert'] as OnbKey[]) {
    const first = compare(rows, key).find((x) => x.metric.key === 'value_1d')!;
    const enough = first.control.den >= ONB_BARS.minPerArm && first.variant.den >= ONB_BARS.minPerArm;
    checks.push({
      key: `harm_${key}`,
      question: key === 'flow' ? 'Does the setup dialog cost first calls?' : 'Does Flow B cost first calls?',
      state: !enough || first.better === null ? 'wait' : first.better < ONB_BARS.harm ? 'fail' : 'pass',
      detail: `24 h first call ${pct(ratio(first.control))} vs ${pct(ratio(first.variant))}, ${chance(first.better)} chance it is better`,
    });
  }

  const failed = compare(rows, 'flow').find((x) => x.metric.key === 'connect_failed')!;
  const enough = failed.control.den >= ONB_BARS.minPerArm && failed.variant.den >= ONB_BARS.minPerArm;
  checks.push({
    key: 'connect',
    question: 'Do more connects fail in the setup dialog?',
    state: !enough || failed.better === null ? 'wait' : failed.better < ONB_BARS.harm ? 'fail' : 'pass',
    detail: `${pct(ratio(failed.control))} vs ${pct(ratio(failed.variant))} of those who tried never connected`,
  });

  return checks;
}

export type Verdict = { level: 'ok' | 'degraded' | 'down' | 'unknown'; headline: string; reason: string };

export function onboardingVerdict(state: ReleaseState, checks: Check[]): Verdict {
  if (state.kind === 'off') return { level: 'unknown', headline: 'Not released', reason: state.reason };
  if (state.kind === 'stuck') return { level: 'degraded', headline: 'Half switched on', reason: state.reason };
  if (state.kind === 'concluded') {
    const flow = state.winners.flow ? ARM_LABELS[state.winners.flow] ?? state.winners.flow : 'n/a';
    const convert = state.winners.convert ? ARM_LABELS[state.winners.convert] ?? state.winners.convert : 'n/a';
    return { level: 'ok', headline: 'Concluded', reason: `Everyone gets the winners: flow ${flow}, conversion ${convert}.` };
  }
  const failed = checks.filter((c) => c.state === 'fail');
  if (failed.length > 0) {
    const harm = failed.some((c) => c.key.startsWith('harm') || c.key.startsWith('srm'));
    return { level: harm ? 'down' : 'degraded', headline: 'Look closer', reason: `Failing: ${failed.map((c) => c.question).join(' ')}` };
  }
  if (checks.some((c) => c.state === 'wait')) {
    return { level: 'unknown', headline: 'Too early', reason: `Checks wait for ${ONB_BARS.minPerArm} matured workspaces per arm.` };
  }
  return { level: 'ok', headline: 'Running clean', reason: 'No harm and no broken plumbing. Ship decisions wait for the read-out.' };
}
