/**
 * The onboarding band: the onb_flow x onb_convert test, from before the start
 * to the read-out. Arithmetic is src/lib/analytics/onboarding-test.ts.
 *
 * Aggregates only. No account or address is on this page.
 */

import type { GrowthOnboardingArmRow, GrowthOnboardingStepRow } from '@/lib/analytics/growth-types';
import {
  ARM_LABELS,
  ARM_NAMES,
  ONB_BARS,
  READOUT_DAYS,
  addDays,
  compare,
  ratio,
  type Check,
  type OnbKey,
  type Ratio,
  type ReleaseState,
  type Verdict as OnbVerdict,
} from '@/lib/analytics/onboarding-test';
import { formatCount, formatPercent } from '../../charts';
import { FunnelSteps, Tile } from '../../kiosk/primitives';
import { Verdict } from './panels';

const STATE_WORDS = { pass: 'Pass', fail: 'Fail', wait: 'Waiting' } as const;

const pct = (r: Ratio) => {
  const value = ratio(r);
  return value === null ? '' : formatPercent(value, 1);
};

export function OnboardingVerdictTile({
  verdict,
  checks,
  state,
  baseline,
  days,
}: {
  verdict: OnbVerdict;
  checks: Check[];
  state: ReleaseState;
  baseline: Ratio;
  days: number;
}) {
  const tone = verdict.level === 'ok' ? 'good' : verdict.level === 'down' ? 'bad' : verdict.level === 'degraded' ? 'warn' : 'default';
  const started = state.kind === 'running' ? state.startedAt : null;
  return (
    <Tile label="Is the test healthy?" aside="customers only" tone={tone}>
      <Verdict level={verdict.level} headline={verdict.headline} reason={verdict.reason} />
      {state.kind === 'running' && (
        <table className="bd-table">
          <tbody>
            {checks.map((check) => (
              <tr key={check.key}>
                <th scope="row" className="bd-cell-text" title={check.detail}>
                  {check.question}
                </th>
                <td className="bd-cell-text" title={check.detail}>
                  {STATE_WORDS[check.state]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <table className="bd-table">
        <tbody>
          <tr>
            <th scope="row" className="bd-cell-text">Baseline, first call in 24 h</th>
            <td title={`${formatCount(baseline.num)} of ${formatCount(baseline.den)} customer workspaces, last ${days}d`}>
              {pct(baseline) || 'n/a'}
            </td>
          </tr>
          {started && (
            <>
              <tr>
                <th scope="row" className="bd-cell-text">Started</th>
                <td>{started.slice(0, 10)}</td>
              </tr>
              <tr>
                <th scope="row" className="bd-cell-text">Activation read-out</th>
                <td>{addDays(started, READOUT_DAYS.activation)}</td>
              </tr>
              <tr>
                <th scope="row" className="bd-cell-text">Paid-30 read-out</th>
                <td>{addDays(started, READOUT_DAYS.paid)}</td>
              </tr>
            </>
          )}
        </tbody>
      </table>
      <p className="bd-note">
        {state.kind === 'running'
          ? checks
              .filter((c) => c.state !== 'pass')
              .map((c) => `${c.question} ${c.detail}.`)
              .join(' ') || 'Hover a check for its numbers.'
          : `${state.kind === 'off' || state.kind === 'stuck' ? `${state.detail} ` : ''}The baseline is every customer workspace, enrolled or not.`}
      </p>
    </Tile>
  );
}

/** Which metrics each key's table shows. The flow table carries all; convert only what it moves. */
const ROWS: Record<OnbKey, string[]> = {
  flow: ['value_1d', 'inbox_1d', 'draft_3d', 'habit_7d', 'connect_failed', 'paid_any'],
  convert: ['paid_30d', 'paid_any', 'value_1d', 'habit_7d'],
};

function ArmTable({ rows, which }: { rows: GrowthOnboardingArmRow[]; which: OnbKey }) {
  const [c, v] = ARM_NAMES[which];
  const comparisons = compare(rows, which).filter((x) => ROWS[which].includes(x.metric.key));
  comparisons.sort((a, b) => ROWS[which].indexOf(a.metric.key) - ROWS[which].indexOf(b.metric.key));
  const n = (arm: string) => rows.filter((r) => r[which] === arm).reduce((s, r) => s + (Number(r.assigned) || 0), 0);
  return (
    <table className="bd-table">
      <thead>
        <tr>
          <th scope="col">onb_{which}</th>
          <th scope="col">
            {ARM_LABELS[c]} ({formatCount(n(c))})
          </th>
          <th scope="col">
            {ARM_LABELS[v]} ({formatCount(n(v))})
          </th>
          <th scope="col">Chance {ARM_LABELS[v]} is better</th>
        </tr>
      </thead>
      <tbody>
        {comparisons.map(({ metric, control, variant, better }) => (
          <tr key={metric.key} className={control.den + variant.den === 0 ? 'is-quiet' : undefined}>
            <th scope="row" className="bd-cell-text">
              {metric.primaryFor === which ? <b>{metric.label}</b> : metric.label}
            </th>
            <td title={`${control.num} of ${control.den}`}>{pct(control)}</td>
            <td title={`${variant.num} of ${variant.den}`}>{pct(variant)}</td>
            <td>{better === null ? '' : formatPercent(better, 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OnboardingArmsTile({ rows }: { rows: GrowthOnboardingArmRow[] }) {
  const enrolled = rows.reduce((s, r) => s + (Number(r.assigned) || 0), 0);
  return (
    <Tile label="Arms" aside={`${formatCount(enrolled)} enrolled, all time`}>
      {enrolled === 0 ? (
        <p className="kiosk-empty">
          Nobody enrolled yet. Internal accounts see the setup dialog but are never enrolled.
        </p>
      ) : (
        <div className="bd-scroll">
          <ArmTable rows={rows} which="flow" />
          <ArmTable rows={rows} which="convert" />
        </div>
      )}
      <p className="bd-note">
        Each rate counts only workspaces old enough for it (24 h, 3, 7 or 30 days). Bold rows are each key&apos;s
        primary metric. Chances are Bayesian with flat priors; the plan ships Flow B at{' '}
        {formatPercent(ONB_BARS.ship, 0)} on paid within 30 days, and calls harm below{' '}
        {formatPercent(ONB_BARS.harm, 0)}. Week-1 activity excludes automation runs. Refunds are not counted here.
      </p>
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

const FLOW_B: [stage: string, label: string][] = [
  ['second_inbox_prompt_shown', 'Second inbox card shown'],
  ['second_inbox_prompt_clicked', 'Second inbox card clicked'],
  ['plan_summary_shown', 'Plan summary shown'],
  ['plan_summary_clicked', 'Plan summary clicked'],
  ['plan_summary_dismissed', 'Plan summary dismissed'],
  ['usage_meter_shown', 'Usage meter shown'],
  ['grace_end_note_shown', 'Grace-end note shown'],
];

export function OnboardingStepsTile({ steps, assignedNew }: { steps: GrowthOnboardingStepRow[]; assignedNew: number }) {
  const count = (pred: (r: GrowthOnboardingStepRow) => boolean) =>
    steps.filter(pred).reduce((s, r) => s + (Number(r.workspaces) || 0), 0);
  const funnel = [
    { label: 'Enrolled in the dialog', value: assignedNew },
    ...STEP_LABELS.map(([category, label]) => ({
      label,
      value: count((r) => r.flow === 'new' && r.stage === 'onboarding_step_viewed' && r.category === category),
    })),
    { label: 'Finished', value: count((r) => r.flow === 'new' && r.stage === 'onboarding_completed' && r.category === null) },
  ];
  // Where the dialog was closed (X, Skip or Escape) without finishing.
  const exits = STEP_LABELS.map(([category, label]) => ({
    label: `Closed on ${label}`,
    value: count((r) => r.flow === 'new' && r.stage === 'onboarding_exited' && r.category === category),
  }));
  const flowB = FLOW_B.map(([stage, label]) => ({
    label,
    value: count((r) => r.convert === 'on' && r.stage === stage && r.category === null),
  }));
  return (
    <Tile label="Setup dialog, step by step" aside="enrolled, workspaces">
      <FunnelSteps steps={funnel} />
      <table className="bd-table">
        <tbody>
          {[...exits, ...flowB].map((row) => (
            <tr key={row.label} className={row.value === 0 ? 'is-quiet' : undefined}>
              <th scope="row" className="bd-cell-text">{row.label}</th>
              <td>{formatCount(row.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="bd-note">
        A step counts once it was seen. A chat link opens straight on the inbox step, so later steps can be
        smaller without anyone leaving. Closed on counts workspaces that closed the dialog on that step
        (recorded from 2026-10-28); someone who leaves for their AI app and never comes back to the tab is in
        neither. Flow B rows are workspaces in onb_convert = on, across both flows.
      </p>
    </Tile>
  );
}
