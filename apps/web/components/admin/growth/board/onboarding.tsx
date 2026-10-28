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
  armTotals,
  compare,
  ratio,
  type Check,
  type Comparison,
  type OnbKey,
  type Ratio,
  type ReleaseState,
  type Verdict as OnbVerdict,
} from '@/lib/analytics/onboarding-test';
import { formatCount, formatPercent } from '../../charts';
import { FunnelSteps, Tile } from '../../kiosk/primitives';
import { CheckList, HowCounted } from './checks';
import { Verdict } from './panels';

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
  rows,
}: {
  verdict: OnbVerdict;
  checks: Check[];
  state: ReleaseState;
  baseline: Ratio;
  days: number;
  rows: GrowthOnboardingArmRow[];
}) {
  const tone = verdict.level === 'ok' ? 'good' : verdict.level === 'down' ? 'bad' : verdict.level === 'degraded' ? 'warn' : 'default';
  const started = state.kind === 'running' ? state.startedAt : null;
  // The checks wait on the smallest arm, so say how far along it is.
  const smallest = Math.min(
    ...(['flow', 'convert'] as OnbKey[]).flatMap((key) => ARM_NAMES[key].map((arm) => armTotals(rows, key, arm).mature_1d)),
  );
  return (
    <Tile label="Is the test healthy?" aside="customers only" tone={tone}>
      <Verdict level={verdict.level} headline={verdict.headline} reason={verdict.reason} />
      {state.kind === 'running' && (
        <>
          <CheckList checks={checks} />
          {checks.some((c) => c.state === 'wait') && (
            <p className="bd-note">
              Smallest arm: {formatCount(smallest)} of {ONB_BARS.minPerArm} workspaces a day old.
            </p>
          )}
        </>
      )}
      <ul className="gb-chips">
        <li title={`${formatCount(baseline.num)} of ${formatCount(baseline.den)} customer workspaces, last ${days}d`}>
          First call in 24 h, everyone: <b>{pct(baseline) || 'n/a'}</b>
        </li>
        {started && (
          <>
            <li>
              Started <b>{started.slice(0, 10)}</b>
            </li>
            <li>
              Activation read-out <b>{addDays(started, READOUT_DAYS.activation)}</b>
            </li>
            <li>
              Paid read-out <b>{addDays(started, READOUT_DAYS.paid)}</b>
            </li>
          </>
        )}
      </ul>
      {state.kind !== 'running' && (
        <p className="bd-note">
          {state.kind === 'off' || state.kind === 'stuck' ? `${state.detail} ` : ''}The baseline is every customer
          workspace, enrolled or not.
        </p>
      )}
    </Tile>
  );
}

/** Which metrics each key's table shows. The flow table carries all; convert only what it moves. */
const ROWS: Record<OnbKey, string[]> = {
  flow: ['value_1d', 'inbox_1d', 'draft_3d', 'habit_7d', 'connect_failed', 'paid_any'],
  convert: ['paid_30d', 'paid_any', 'value_1d', 'habit_7d'],
};

const TITLES: Record<OnbKey, string> = {
  flow: "Setup dialog vs today's flow",
  convert: 'Flow B vs no Flow B',
};

/** The chance of being better, said in words. Too few workspaces says so instead of a number. */
function reading({ control, variant, better }: Comparison): { word: string; tone: string } {
  const fewest = Math.min(control.den, variant.den);
  if (fewest < ONB_BARS.minPerArm) return { word: `Too few to tell (${fewest} of ${ONB_BARS.minPerArm})`, tone: 'quiet' };
  if (better === null) return { word: '', tone: 'quiet' };
  if (better >= 0.95) return { word: 'Better', tone: 'good' };
  if (better >= ONB_BARS.ship) return { word: 'Likely better', tone: 'good' };
  if (better <= ONB_BARS.harm) return { word: 'Worse', tone: 'bad' };
  if (better <= 1 - ONB_BARS.ship) return { word: 'Likely worse', tone: 'warn' };
  return { word: 'No clear difference', tone: 'quiet' };
}

function Rate({ r }: { r: Ratio }) {
  return (
    <>
      {pct(r)} <span className="gb-arm-n">{r.num}/{r.den}</span>
    </>
  );
}

function ArmTable({ rows, which }: { rows: GrowthOnboardingArmRow[]; which: OnbKey }) {
  const [c, v] = ARM_NAMES[which];
  const comparisons = compare(rows, which).filter((x) => ROWS[which].includes(x.metric.key));
  comparisons.sort((a, b) => ROWS[which].indexOf(a.metric.key) - ROWS[which].indexOf(b.metric.key));
  const measured = comparisons.filter((x) => x.control.den + x.variant.den > 0);
  const pending = comparisons.filter((x) => x.control.den + x.variant.den === 0);
  return (
    <div className="gb-arm">
      <h3 className="gb-arm-title">
        {TITLES[which]}
        <span>
          {formatCount(armTotals(rows, which, v).assigned)} vs {formatCount(armTotals(rows, which, c).assigned)} workspaces
        </span>
      </h3>
      {measured.length > 0 && (
        <table className="bd-table">
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">{ARM_LABELS[c]}</th>
              <th scope="col">{ARM_LABELS[v]}</th>
              <th scope="col">{ARM_LABELS[v]} is</th>
            </tr>
          </thead>
          <tbody>
            {measured.map((x) => {
              const { word, tone } = reading(x);
              return (
                <tr key={x.metric.key}>
                  <th scope="row" className="bd-cell-text">
                    {x.metric.label}
                    {x.metric.primaryFor === which && <span className="gb-arm-tag">decides</span>}
                  </th>
                  <td>
                    <Rate r={x.control} />
                  </td>
                  <td>
                    <Rate r={x.variant} />
                  </td>
                  <td
                    className={`bd-cell-text gb-arm-read is-${tone}`}
                    title={x.better === null ? undefined : `${formatPercent(x.better, 0)} chance ${ARM_LABELS[v]} is better`}
                  >
                    {word}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {pending.length > 0 && (
        <p className="bd-note">
          No workspace old enough yet for:{' '}
          {pending.map((x) => x.metric.label + (x.metric.primaryFor === which ? ' (decides)' : '')).join(', ')}.
        </p>
      )}
    </div>
  );
}

export function OnboardingArmsTile({ rows }: { rows: GrowthOnboardingArmRow[] }) {
  const enrolled = rows.reduce((s, r) => s + (Number(r.assigned) || 0), 0);
  return (
    <Tile label="Results so far" aside={`${formatCount(enrolled)} enrolled, all time`}>
      {enrolled === 0 ? (
        <p className="kiosk-empty">
          Nobody enrolled yet. Internal accounts see the setup dialog but are never enrolled.
        </p>
      ) : (
        <div className="bd-scroll gb-arms">
          <ArmTable rows={rows} which="flow" />
          <ArmTable rows={rows} which="convert" />
        </div>
      )}
      <HowCounted>
        Each rate counts only workspaces old enough for it (24 h, 3, 7 or 30 days), shown as share and count. The
        row marked decides is that test&apos;s primary metric. The verdict word is a Bayesian chance with flat
        priors (hover it for the number): likely better at {formatPercent(ONB_BARS.ship, 0)}, worse at{' '}
        {formatPercent(ONB_BARS.harm, 0)} or below, and nothing is said under {ONB_BARS.minPerArm} workspaces per
        arm. The plan ships Flow B at {formatPercent(ONB_BARS.ship, 0)} on paid within 30 days. Week-1 activity
        excludes automation runs. Refunds are not counted here.
      </HowCounted>
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

function CountList({ title, rows, empty }: { title: string; rows: { label: string; value: number }[]; empty: string }) {
  const shown = rows.filter((row) => row.value > 0);
  return (
    <div className="gb-arm">
      <h3 className="gb-arm-title">{title}</h3>
      {shown.length === 0 ? (
        <p className="bd-note">{empty}</p>
      ) : (
        <table className="bd-table">
          <tbody>
            {shown.map((row) => (
              <tr key={row.label}>
                <th scope="row" className="bd-cell-text">{row.label}</th>
                <td>{formatCount(row.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function OnboardingStepsTile({ steps, assignedNew }: { steps: GrowthOnboardingStepRow[]; assignedNew: number }) {
  const count = (pred: (r: GrowthOnboardingStepRow) => boolean) =>
    steps.filter(pred).reduce((s, r) => s + (Number(r.workspaces) || 0), 0);
  const values = [
    { label: 'Enrolled in the dialog', value: assignedNew },
    ...STEP_LABELS.map(([category, label]) => ({
      label,
      value: count((r) => r.flow === 'new' && r.stage === 'onboarding_step_viewed' && r.category === category),
    })),
    { label: 'Finished', value: count((r) => r.flow === 'new' && r.stage === 'onboarding_completed' && r.category === null) },
  ];
  // Each rung says what share of the enrolled reached it.
  const funnel = values.map((step, i) => ({
    ...step,
    note: i > 0 && assignedNew > 0 ? formatPercent(step.value / assignedNew, 0) : undefined,
  }));
  // Where the dialog was closed (X, Skip or Escape) without finishing.
  const exits = STEP_LABELS.map(([category, label]) => ({
    label,
    value: count((r) => r.flow === 'new' && r.stage === 'onboarding_exited' && r.category === category),
  }));
  const flowB = FLOW_B.map(([stage, label]) => ({
    label,
    value: count((r) => r.convert === 'on' && r.stage === stage && r.category === null),
  }));
  return (
    <Tile label="Setup dialog, step by step" aside="workspaces">
      <FunnelSteps steps={funnel} />
      <CountList title="Closed the dialog on" rows={exits} empty="Nobody has closed it yet." />
      <CountList title="Flow B" rows={flowB} empty="No Flow B prompt shown yet." />
      <HowCounted>
        A step counts once it was seen; the share is of everyone enrolled in the dialog. A chat link opens straight
        on the inbox step, so later steps can be smaller without anyone leaving. Closed on counts workspaces that
        closed the dialog with X, Skip or Escape on that step (recorded from 2026-10-28); someone who leaves for
        their AI app and never comes back to the tab is in neither. Flow B rows are workspaces with Flow B, across
        both flows.
      </HowCounted>
    </Tile>
  );
}
