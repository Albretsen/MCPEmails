/**
 * Records, streaks and the next round number.
 *
 * THE ARGUMENT FOR PUTTING THIS ON A METRICS PAGE. Everything else here answers
 * "how are we doing", which is a question about levels and rates and which, at
 * this size, mostly answers "about the same as last week". None of it gives a
 * genuinely good day anywhere to land. At sixty signups a week the difference
 * between an ordinary Tuesday and the best day this product has ever had is
 * four people, and no chart above makes that visible, because a bar chart of
 * daily signups renders both bars at nearly the same height.
 *
 * So this section is the one place where the series is read for its SHAPE
 * rather than its level: the longest run, the highest day, the distance to the
 * next round number. It is the enjoyable part of the page and it is still made
 * entirely of counted facts. Nothing here is estimated, smoothed or scored, and
 * the one forecast on it (days to the next milestone at the recent pace) says
 * out loud that it is arithmetic on a pace and refuses to answer when the pace
 * is zero.
 *
 * WHERE EACH NUMBER MAY HONESTLY REACH BACK TO, which is the only real trap in
 * here. `growth_user_signup_days` reads `users.created_at` and the durable
 * `onboarding_value_activated_at`, so signup records are genuinely all-time and
 * are labelled that way. `growth_daily_metrics` reads `activity_log`, which a
 * pg_cron job purges at 90 days, so the busiest product day is the busiest of
 * the last quarter and says so. Those two labels are not interchangeable and
 * must not be made uniform for tidiness.
 */

import {
  fetchDailyMetrics,
  fetchPeopleCounts,
  fetchUserSignupDays,
} from '@/lib/analytics/growth-queries';
import { fetchCashCollected, fetchRecurringRevenue } from '@/lib/analytics/kiosk-revenue';
import {
  agoLabel,
  daysBetween,
  daysToTarget,
  formatDayKey,
  nextMilestone,
  recordDay,
  streak,
  type DayCount,
} from '@/lib/analytics/growth-records';
import { formatCount, formatMoney, NO_DATA } from '../charts';
import { Section, SectionError } from './shared';

/**
 * A year of daily signups. Long enough for "all time" to be true today (the
 * first user arrived well inside it) and short enough to stay one cheap RPC.
 * The fetcher's own ceiling is 400 days; if the product ever outgrows this the
 * honest fix is to raise it here, not to relabel the tiles.
 */
const HISTORY_DAYS = 365;

/** The purge horizon on `activity_log`, and therefore the reach of call records. */
const ACTIVITY_DAYS = 90;

/** The trailing stretch the milestone pace is measured over. */
const PACE_DAYS = 28;

export async function RecordsSection() {
  const [signupResult, dailyResult, peopleResult, revenueResult, cashResult] = await Promise.all([
    fetchUserSignupDays(HISTORY_DAYS),
    fetchDailyMetrics(ACTIVITY_DAYS),
    fetchPeopleCounts(PACE_DAYS),
    fetchRecurringRevenue(PACE_DAYS),
    fetchCashCollected(),
  ]);

  // The signup series is the spine of this section: four of the six tiles are
  // computed from it. Losing it is worth failing the whole section over, where
  // losing any of the others just empties one tile.
  if (!signupResult.ok) return <SectionError title="Records" message={signupResult.error} />;

  const signupDays = signupResult.data;
  const signups: DayCount[] = signupDays.map((row) => ({ day: row.day, count: row.new_users }));
  const activations: DayCount[] = signupDays.map((row) => ({ day: row.day, count: row.activated_users }));

  const signupStreak = streak(signups);
  const bestSignupDay = recordDay(signups);
  const bestActivationDay = recordDay(activations);

  const daily = dailyResult.ok ? dailyResult.data : [];
  const busiestDay = recordDay(daily.map((row) => ({ day: row.day, count: row.calls })));
  const callsInWindow = daily.reduce((total, row) => total + row.calls, 0);

  const people = peopleResult.ok ? peopleResult.data : null;
  const money = revenueResult.ok ? revenueResult.data : null;
  const cash = cashResult.ok ? cashResult.data : null;

  // People, not workspaces, to match the scoreboard headline it walks towards.
  const userMilestone = people ? nextMilestone(people.total_users) : null;
  const usersPerDay = people ? people.new_users / PACE_DAYS : 0;
  const userEta = userMilestone ? daysToTarget(userMilestone.remaining, usersPerDay) : null;

  // MRR in whole units, because the ladder is a ladder of round dollars and
  // "$2,500 to go" out of minor units would be twenty five dollars.
  const mrrWhole = money ? money.mrrMinor / 100 : null;
  const mrrMilestone = mrrWhole === null ? null : nextMilestone(mrrWhole);

  const firstCharge = cash?.since ?? null;
  const daysTrading = firstCharge ? daysBetween(firstCharge) : null;

  return (
    <Section
      id="records"
      title="Records"
      explain={
        <>
          The series read for its shape rather than its level: the longest run, the highest day, and the
          distance to the next round number. Every figure is counted, not modelled. Signup records are
          genuinely all-time because they come from durable timestamps; anything counting tool calls
          reaches back {ACTIVITY_DAYS} days only, because <code>activity_log</code> is purged at {ACTIVITY_DAYS}{' '}
          and a record cannot be claimed over data that no longer exists.
        </>
      }
    >
      <section className="growth-record-grid" aria-label="Records and streaks">
        <RecordTile
          label="Signup streak"
          value={signupStreak.current === 0 ? 'Broken' : `${signupStreak.current} days`}
          detail={
            signupStreak.current === 0
              ? 'No signup on the last completed day'
              : signupStreak.todayCounts
                ? 'Running, today already counts'
                : 'Running, today has not landed yet'
          }
          foot={
            signupStreak.longest > 0
              ? `Best run: ${signupStreak.longest} days, to ${formatDayKey(signupStreak.longestEndedOn) ?? NO_DATA}`
              : 'No run recorded yet'
          }
          tone={signupStreak.current >= signupStreak.longest && signupStreak.longest > 0 ? 'good' : 'default'}
        />

        <RecordTile
          label="Best day for signups"
          value={bestSignupDay ? formatCount(bestSignupDay.count) : NO_DATA}
          detail={bestSignupDay ? (formatDayKey(bestSignupDay.day) ?? '') : 'Nobody has signed up yet'}
          foot={bestSignupDay ? `${agoLabel(`${bestSignupDay.day}T12:00:00Z`) ?? ''}, all time` : 'All time'}
        />

        <RecordTile
          label="Best day for activations"
          value={bestActivationDay ? formatCount(bestActivationDay.count) : NO_DATA}
          detail={bestActivationDay ? (formatDayKey(bestActivationDay.day) ?? '') : 'Nobody has reached a mailbox yet'}
          foot="People whose first mailbox operation was that day, all time"
        />

        <RecordTile
          label="Busiest day"
          value={busiestDay ? formatCount(busiestDay.count) : NO_DATA}
          detail={busiestDay ? `${formatDayKey(busiestDay.day) ?? ''}, tool calls` : dailyResult.ok ? 'No call recorded' : 'Unavailable'}
          foot={`${formatCount(callsInWindow)} calls in the last ${ACTIVITY_DAYS} days`}
        />

        {/* The two milestone tiles are the only forward-looking things on the
            page. The pace is stated beside the estimate so it can be argued
            with, and no estimate appears at all when the pace is zero. */}
        <RecordTile
          label="Next people milestone"
          value={userMilestone ? formatCount(userMilestone.target) : NO_DATA}
          detail={
            userMilestone && people
              ? `${formatCount(userMilestone.remaining)} to go, from ${formatCount(people.total_users)}`
              : 'Unavailable'
          }
          foot={
            userEta === null
              ? `No arrival date: ${PACE_DAYS} day pace is zero`
              : `About ${formatCount(userEta)} days at ${usersPerDay.toFixed(1)} a day`
          }
          meter={userMilestone?.percent ?? null}
        />

        <RecordTile
          label="Next MRR milestone"
          value={mrrMilestone && money ? formatMoney(mrrMilestone.target * 100, money.currency) : NO_DATA}
          detail={
            mrrMilestone && money
              ? `${formatMoney(Math.round(mrrMilestone.remaining * 100), money.currency)} to go`
              : 'Stripe unavailable'
          }
          foot={
            daysTrading === null
              ? 'No charge has ever succeeded'
              : `${formatCount(daysTrading)} days since the first dollar, ${formatCount(cash?.charges ?? 0)} charges`
          }
          meter={mrrMilestone?.percent ?? null}
        />
      </section>
    </Section>
  );
}

/**
 * One record.
 *
 * Its own primitive rather than a `StatCard`: these carry a third line (the
 * context that makes a record a record) and an optional meter, and neither
 * belongs on the cards above, where a fourth line would push the movement strip
 * out of one screen.
 */
function RecordTile({
  label,
  value,
  detail,
  foot,
  meter,
  tone = 'default',
}: {
  label: string;
  value: string;
  detail: string;
  foot: string;
  /** 0 to 100, or null for a tile with nothing to fill. */
  meter?: number | null;
  tone?: 'default' | 'good';
}) {
  return (
    <div className={`growth-record${tone === 'good' ? ' is-good' : ''}`}>
      <div className="growth-record-label">{label}</div>
      <div className="growth-record-value">{value}</div>
      <div className="growth-record-detail">{detail}</div>
      {typeof meter === 'number' && (
        <div className="growth-record-meter" aria-hidden="true">
          <span style={{ width: `${Math.max(2, Math.min(100, meter))}%` }} />
        </div>
      )}
      <div className="growth-record-foot">{foot}</div>
    </div>
  );
}
