/**
 * The onboarding band: is the new setup better, and where do people drop out
 * of it. Arithmetic is src/lib/analytics/onboarding-test.ts. The plumbing
 * checks (50/50 split, coverage, harm) only show when one fails.
 *
 * Aggregates only. No account or address is on this page.
 */

import type { GrowthOnboardingArmRow, GrowthOnboardingStepRow } from '@/lib/analytics/growth-types';
import {
  ARM_NAMES,
  ONB_BARS,
  READOUT_DAYS,
  addDays,
  armTotals,
  compare,
  ratio,
  type Comparison,
  type OnbKey,
  type ReleaseState,
  type Verdict as OnbVerdict,
} from '@/lib/analytics/onboarding-test';
import { formatCount, formatPercent } from '../../charts';
import { FunnelSteps, Tile } from '../../kiosk/primitives';
import { BigStats, type BigStat } from './big-stats';
import { Verdict } from './panels';

/** One headline per test: its deciding metric and when that metric first has data. */
const HEADLINE: Record<OnbKey, { title: string; metric: string; label: string; matures: number }> = {
  flow: { title: "Setup dialog vs today's flow", metric: 'value_1d', label: 'first call in 24 h', matures: 1 },
  convert: { title: 'Flow B vs no Flow B', metric: 'paid_30d', label: 'paid within 30 days', matures: 30 },
};

/** The chance of being better, said in words. */
function reading({ control, variant, better }: Comparison): BigStat['word'] {
  const fewest = Math.min(control.den, variant.den);
  if (fewest < ONB_BARS.minPerArm) return { text: `Too few to tell (${fewest} of ${ONB_BARS.minPerArm})`, tone: 'quiet' };
  if (better === null) return { text: '', tone: 'quiet' };
  if (better >= 0.95) return { text: 'Better', tone: 'good' };
  if (better >= ONB_BARS.ship) return { text: 'Likely better', tone: 'good' };
  if (better <= ONB_BARS.harm) return { text: 'Worse', tone: 'bad' };
  if (better <= 1 - ONB_BARS.ship) return { text: 'Likely worse', tone: 'warn' };
  return { text: 'No clear difference', tone: 'quiet' };
}

function headline(rows: GrowthOnboardingArmRow[], key: OnbKey, started: string | null): BigStat {
  const { title, metric, label, matures } = HEADLINE[key];
  const x = compare(rows, key).find((c) => c.metric.key === metric)!;
  const [c, v] = ARM_NAMES[key];
  const n = `${formatCount(armTotals(rows, key, v).assigned)} vs ${formatCount(armTotals(rows, key, c).assigned)} workspaces`;
  const share = (r: { num: number; den: number }) => {
    const value = ratio(r);
    return value === null ? 'n/a' : formatPercent(value, 0);
  };
  if (x.control.den + x.variant.den === 0) {
    return {
      label: title,
      value: 'No data yet',
      note: `${label}${started ? `, first numbers ${addDays(started, matures)}` : ''} · ${n}`,
    };
  }
  return {
    label: title,
    value: `${share(x.variant)} vs ${share(x.control)}`,
    note: `${label} · ${n}`,
    word: reading(x),
  };
}

export function OnboardingTestTile({
  verdict,
  state,
  rows,
}: {
  verdict: OnbVerdict;
  state: ReleaseState;
  rows: GrowthOnboardingArmRow[];
}) {
  const tone = verdict.level === 'ok' ? 'good' : verdict.level === 'down' ? 'bad' : verdict.level === 'degraded' ? 'warn' : 'default';
  const started = state.kind === 'running' ? state.startedAt : null;
  const enrolled = rows.reduce((s, r) => s + (Number(r.assigned) || 0), 0);
  // A healthy wait needs no explanation beyond when the answer comes.
  const reason =
    started && verdict.headline === 'Too early'
      ? `Answer on ${addDays(started, READOUT_DAYS.activation)} (activation) and ${addDays(started, READOUT_DAYS.paid)} (paid).`
      : verdict.reason;
  return (
    <Tile
      label="Is the new setup better?"
      aside={started ? `${formatCount(enrolled)} enrolled since ${started.slice(0, 10)}` : 'not running'}
      tone={tone}
    >
      <Verdict level={verdict.level} headline={verdict.headline} reason={reason} />
      {enrolled > 0 && <BigStats stats={[headline(rows, 'flow', started), headline(rows, 'convert', started)]} />}
      {state.kind === 'off' || state.kind === 'stuck' ? <p className="bd-note">{state.detail}</p> : null}
    </Tile>
  );
}

const STEP_LABELS: [category: string, label: string][] = [
  ['step_inbox', 'Inbox'],
  ['step_add_to_ai', 'Add to AI'],
  ['step_first_prompt', 'First prompt'],
  ['step_wait', 'Waiting for the call'],
  ['step_it_works', 'It works'],
];

export function OnboardingStepsTile({ steps, assignedNew }: { steps: GrowthOnboardingStepRow[]; assignedNew: number }) {
  const count = (pred: (r: GrowthOnboardingStepRow) => boolean) =>
    steps.filter(pred).reduce((s, r) => s + (Number(r.workspaces) || 0), 0);
  const values = [
    { label: 'Saw the dialog', value: assignedNew },
    ...STEP_LABELS.map(([category, label]) => ({
      label,
      value: count((r) => r.flow === 'new' && r.stage === 'onboarding_step_viewed' && r.category === category),
    })),
    { label: 'Finished', value: count((r) => r.flow === 'new' && r.stage === 'onboarding_completed' && r.category === null) },
  ];
  const funnel = values.map((step, i) => ({
    ...step,
    note: i > 0 && assignedNew > 0 ? formatPercent(step.value / assignedNew, 0) : undefined,
  }));
  return (
    <Tile label="Where people stop" aside="setup dialog, workspaces">
      <FunnelSteps steps={funnel} />
    </Tile>
  );
}
