/**
 * Retention: the question this product actually has to answer.
 *
 * The old page reported four rolling return percentages, which is a lot of
 * arithmetic for very little insight at this scale. Two blunt counts do more
 * work: how many workspaces used the product once and never came back, and how
 * many were genuinely using it and have since gone quiet.
 *
 * The curve and the cohort grid sit underneath, because the only reference
 * point an early product has for "is retention improving?" is its own earlier
 * cohorts.
 */

import {
  fetchCohortRetention,
  fetchEngagementBands,
  fetchLifecycleCounts,
  fetchRetentionCurve,
} from '@/lib/analytics/growth-queries';
import { CohortHeatmap, LineChart, ratio } from '../charts';
import { MixBars, SectionError, Section, StatCard } from './shared';

const COHORT_WEEKS = 12;
const WEEK_FORMAT = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export async function RetentionSection() {
  const [lifecycleResult, curveResult, cohortResult, bandsResult] = await Promise.all([
    fetchLifecycleCounts(),
    fetchRetentionCurve(COHORT_WEEKS),
    fetchCohortRetention(COHORT_WEEKS),
    fetchEngagementBands(28),
  ]);

  if (!lifecycleResult.ok) return <SectionError title="Retention" message={lifecycleResult.error} />;
  const lifecycle = lifecycleResult.data;

  const curve = curveResult.ok ? [...curveResult.data].sort((a, b) => a.week_index - b.week_index) : [];

  // Group cells into one row per cohort week. A week that has not elapsed yet
  // stays null, never 0: "has not happened" and "nobody came back" are
  // completely different findings and must not look the same.
  const cohortRows = cohortResult.ok
    ? Object.values(
        cohortResult.data.reduce<Record<string, { key: string; label: string; size: number; values: (number | null)[] }>>((accumulator, cell) => {
          const row = (accumulator[cell.cohort_week] ??= {
            key: cell.cohort_week,
            label: WEEK_FORMAT.format(new Date(`${cell.cohort_week}T00:00:00Z`)),
            size: cell.cohort_size,
            values: Array.from({ length: COHORT_WEEKS }, () => null),
          });
          if (cell.week_index < COHORT_WEEKS) row.values[cell.week_index] = cell.retained;
          return accumulator;
        }, {}),
      ).sort((a, b) => b.key.localeCompare(a.key))
    : [];

  return (
    <Section
      title="Retention"
      blurb="Measured from value activation, the first successful call that touched a mailbox. Connecting an inbox and never using it is not retention worth counting."
    >
      <section className="growth-stat-grid" aria-label="Retention counts" style={{ marginBottom: 18 }}>
        <StatCard
          label="Value activated"
          value={lifecycle.value_activated}
          detail="Workspaces that ever performed a mailbox operation"
        />
        <StatCard
          label="One and done"
          value={lifecycle.one_and_done}
          detail={`${ratio(lifecycle.one_and_done, lifecycle.value_activated)} of activated workspaces used it on exactly one day`}
        />
        <StatCard
          label="At risk"
          value={lifecycle.at_risk}
          detail="Used it more than once, silent for 14 days or more"
        />
        {/* Deliberately NOT expressed as a share of value-activated workspaces.
            This count includes workspaces that only ever made a connectivity
            call, so dividing it by the 56 that reached a mailbox mixes two
            populations and produced a 96 percent "retention" figure sitting
            next to 19 one-and-done workspaces. */}
        <StatCard
          label="Active in last 28 days"
          value={lifecycle.active_28d}
          detail="Any successful call, including workspaces that never touched a mailbox"
        />
      </section>

      <div className="growth-split">
        <div className="growth-panel">
          {curveResult.ok ? (
            <LineChart
              title="Retention curve, percent still using a mailbox"
              data={curve.map((point) => ({
                label: `W${point.week_index}`,
                values: [point.eligible ? Math.round((point.retained / point.eligible) * 100) : 0],
              }))}
              series={[{ key: 'retained', name: 'Still active (%)' }]}
              unit="percent"
              footnote="Denominator is the workspaces whose Nth week has fully elapsed, so the tail is not depressed by cohorts that have not had time to return."
            />
          ) : (
            <div className="growth-error"><strong>Curve unavailable.</strong><code>{curveResult.error}</code></div>
          )}
          <p className="growth-note">
            Week N counts workspaces that used a mailbox in the Nth week after activating. A workspace only
            enters the denominator once that whole week has elapsed, so the tail is not artificially depressed
            by cohorts that have not had time to return.
          </p>
        </div>

        <div className="growth-panel">
          {cohortResult.ok ? (
            <CohortHeatmap
              title="Retention by signup week"
              subtitle="Rows are signup weeks, columns are weeks since. Week 0 is the signup week itself."
              rows={cohortRows.map(({ label, size, values }) => ({ label, size, values }))}
            />
          ) : (
            <div className="growth-error"><strong>Cohorts unavailable.</strong><code>{cohortResult.error}</code></div>
          )}
          <p className="growth-note">
            Each row is a signup week, each column a week since. Blank cells are weeks that have not happened
            yet, which is not the same thing as zero.
          </p>
        </div>
      </div>

      {bandsResult.ok && (
        <div style={{ marginTop: 18 }}>
          <MixBars
            title="Active days per workspace, last 28 days"
            unit="workspaces"
            rows={bandsResult.data
              .filter((band) => band.metric === 'active_days')
              .map((band) => ({ name: `${band.band} day(s)`, count: band.workspaces }))}
          />
          <p className="growth-note">
            Habit, in one line. A workspace sitting in the single-day band for a whole month is not retained,
            whatever the aggregate active count says.
          </p>
        </div>
      )}
    </Section>
  );
}
