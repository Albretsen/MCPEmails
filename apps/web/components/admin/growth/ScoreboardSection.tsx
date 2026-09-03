/**
 * The scoreboard: four numbers that are the business, then what moved.
 *
 * WHAT IT REPLACES AND WHY. Until this revision the page opened with a strip of
 * six equal cards: MRR, workspaces at the inbox ceiling, new workspaces,
 * activations, active 7d and active 28d. Six cards of identical weight is not a
 * hierarchy, it is a list, and the operator's verdict on it was that the page
 * was a terrible overview. Two specific faults:
 *
 *   - The ceiling count sat in the top row wearing the same size as MRR. It is
 *     a driver, not a headline. It belongs under "The path to paid", where the
 *     rest of the paywall population already lives, and it is still there.
 *   - Levels and movements were mixed. "MRR $23" and "new workspaces this week"
 *     answer different questions and were rendered identically, so neither
 *     could be read quickly.
 *
 * THE SHAPE, which is the standard inverted pyramid and is deliberate: four
 * large cards carrying LEVELS (what the business is, right now), then one
 * strip of small cards carrying MOVEMENTS (what changed in the window), then
 * the rest of the page carrying causes. Nothing here is stated that is not
 * explained in full further down; this section is allowed to be terse.
 *
 * MRR MOVEMENTS ARE BROKEN OUT rather than netted. A single "net new MRR"
 * figure hides whether a flat month was quiet or was one signup cancelling one
 * churn, and those are not the same month. New, churned and at-risk are
 * therefore three separate facts under the money card.
 */

import {
  fetchDailyMetrics,
  fetchPeopleCounts,
} from '@/lib/analytics/growth-queries';
import { fetchCashCollected, fetchCheckoutFunnel, fetchRecurringRevenue } from '@/lib/analytics/kiosk-revenue';
import { agoLabel } from '@/lib/analytics/growth-records';
import { MetricCard } from '../MetricCard';
import { formatCount, formatMoney, NO_DATA, ratio } from '../charts';
import { StatBlock, StatCard } from './shared';

const SPARK_DAYS = 30;

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

/** Percentage change, or null when there is nothing honest to compare against. */
function delta(current: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/** Packs a nullable delta into the shape StatBlock expects, dropping nulls. */
function tone(percent: number | null, goodDirection: 'up' | 'down') {
  return percent === null ? undefined : { percent, goodDirection };
}

export async function ScoreboardSection({ days }: { days: number }) {
  // Two windows, so every movement can be compared with the one before it.
  // Capped at 90 because `activity_log` is purged at 90: asking for more would
  // return real workspace counts beside zeroed activity, and a delta computed
  // against that is a fabrication.
  const requested = Math.min(days * 2, 90);
  const comparable = requested >= days * 2;

  const [dailyResult, peopleResult, revenueResult, cashResult, checkoutResult] = await Promise.all([
    fetchDailyMetrics(requested),
    fetchPeopleCounts(days),
    fetchRecurringRevenue(days),
    fetchCashCollected(),
    fetchCheckoutFunnel(),
  ]);

  const rows = dailyResult.ok ? dailyResult.data : [];
  const current = rows.slice(-days);
  const previous = comparable ? rows.slice(-days * 2, -days) : null;
  const latest = rows.at(-1);
  const priorSameDay = comparable ? rows.at(-1 - days) : undefined;

  const money = revenueResult.ok ? revenueResult.data : null;
  const cash = cashResult.ok ? cashResult.data : null;
  const checkout = checkoutResult.ok ? checkoutResult.data : null;
  const people = peopleResult.ok ? peopleResult.data : null;
  const windowLabel = `${days}d`;

  const newWorkspaces = sum(current.map((row) => row.new_workspaces));
  const activations = sum(current.map((row) => row.value_activations));

  return (
    <>
      {/* ------------------------------------------------ LEVELS: the four */}
      <section className="growth-hero-grid" aria-label="The business, right now">
        {/* Money first, and stated as MRR rather than as what was billed. The
            first sale was a year up front: billed-this-month would have shown
            $48 in August and nothing for the eleven months after. */}
        <StatCard
          label="MRR"
          value={money ? formatMoney(money.mrrMinor, money.currency) : NO_DATA}
          detail={
            money
              ? money.payingCustomers === 0
                ? 'No paying subscription is live'
                : `${formatMoney(money.arrMinor, money.currency)} a year at this rate`
              : 'Stripe unavailable'
          }
          explain={
            <>
              Monthly recurring revenue, priced from <strong>Stripe</strong> rather than from our own plan
              table: a yearly subscription contributes a twelfth of its net amount per month, and a
              100%-off comp contributes nothing. Nothing in the database can tell those apart, which is how
              this page once reported five paid workspaces while the real paying count was zero.
            </>
          }
          delta={money && money.netNewMrrMinor !== 0
            ? tone(delta(money.mrrMinor, money.mrrMinor - money.netNewMrrMinor), 'up')
            : undefined}
        />

        {/* Cash, beside MRR and never instead of it. The two disagree on
            purpose: MRR is forward looking and normalised, cash is what
            actually reached the bank, and for a customer who bought a year up
            front those differ by a factor of twelve. */}
        <StatCard
          label="Cash collected"
          value={cash ? formatMoney(cash.allTimeMinor, cash.currency) : NO_DATA}
          detail={
            cash
              ? cash.mode === 'test'
                ? 'TEST MODE: these are not real dollars'
                : `${formatMoney(cash.last30Minor, cash.currency)} in the last 30 days`
              : 'Stripe unavailable'
          }
          explain={
            <>
              Every succeeded charge that has ever landed, net of refunds, excluding our own accounts.
              This is the bank-account number and it is <strong>not</strong> MRR: an annual plan arrives
              here whole, on one afternoon, and then contributes nothing for eleven months. Bounded by a
              two-year read and a paging ceiling, which is more history than the account has.
            </>
          }
        />

        <StatCard
          label="Paying customers"
          value={money?.payingCustomers ?? NO_DATA}
          detail={
            money
              ? money.payingCustomers > 0
                ? `${formatMoney(money.arpaMinor, money.currency)} each per month`
                : 'Nobody pays us yet'
              : 'Stripe unavailable'
          }
          explain={
            <>
              Live Stripe subscriptions actually paying something, our own accounts and fully-discounted
              comps excluded. A comp is a real person and no money, so it is counted separately and
              reported under Revenue rather than folded in here.
            </>
          }
        />

        <StatCard
          label="People"
          value={people?.total_users ?? NO_DATA}
          detail={
            people
              ? `${formatCount(people.activated_users)} have reached a mailbox, ${formatCount(people.active_users_7d)} active this week`
              : 'Unavailable'
          }
          explain={
            <>
              Humans who have ever signed up, all time, with our own accounts excluded. Counted as people
              rather than as workspaces because that is the question actually being asked; the two are
              still very nearly the same number, and everything below this strip counts workspaces.
            </>
          }
          delta={people && people.total_users_prior > 0
            ? tone(delta(people.total_users, people.total_users_prior), 'up')
            : undefined}
        />
      </section>

      {/* -------------------------------------------- MOVEMENTS: the strip */}
      {/* Broken out, not netted: a flat month that was quiet and a flat month
          that was one sale cancelling one churn are not the same month. */}
      <section className="growth-stat-grid is-six growth-movement" aria-label={`What moved in the last ${days} days`}>
        <StatCard
          label={`New MRR (${windowLabel})`}
          value={money ? formatMoney(money.newMrrMinor, money.currency) : NO_DATA}
          detail={money
            ? money.newCustomers === 0
              ? 'No subscription started'
              : `${money.newCustomers} subscription${money.newCustomers === 1 ? '' : 's'} started`
            : 'Stripe unavailable'}
          explain="Recurring revenue from subscriptions that started inside the window, normalised to a month. Not expansion: nobody has changed tier yet, and when somebody does this figure will need splitting."
        />

        <StatCard
          label={`Churned MRR (${windowLabel})`}
          value={money ? formatMoney(money.churnedMrrMinor, money.currency) : NO_DATA}
          detail={money
            ? money.churnedMrrMinor === 0
              ? 'Nobody has left'
              : `${money.churnedCustomers} gone, net ${formatMoney(money.netNewMrrMinor, money.currency)}`
            : 'Stripe unavailable'}
          explain="Recurring revenue on subscriptions that ended inside the window. Read it next to New MRR rather than on its own: the net of the two is what the MRR card above actually moved by."
        />

        <StatCard
          label="Money at risk"
          value={money ? formatMoney(money.atRiskMinor + money.leavingMinor, money.currency) : NO_DATA}
          detail={money
            ? money.atRiskCustomers + money.leavingCustomers === 0
              ? 'Every card is good'
              : `${money.atRiskCustomers} failing, ${money.leavingCustomers} set to leave`
            : 'Stripe unavailable'}
          explain={
            <>
              MRR on subscriptions Stripe cannot collect right now, plus MRR already set to stop at the end
              of its period. Still counted in the headline above, deliberately: the app entitles a failing
              card through dunning, so dropping it on the first bounce would paint a collapse that has not
              happened.
            </>
          }
        />

        <MetricCard metricKey="new_workspaces" label="New workspaces">
          <StatBlock
            label={`New workspaces (${windowLabel})`}
            value={newWorkspaces}
            detail={checkout?.lastCompletedAt ? `Last sale ${agoLabel(checkout.lastCompletedAt)}` : 'Signups in the window'}
            explain="Workspaces created in the window and not since deleted. A signup count, not a surviving-account count: a workspace that never connected an inbox still counts."
            spark={rows.slice(-SPARK_DAYS).map((row) => row.new_workspaces)}
            delta={previous ? tone(delta(newWorkspaces, sum(previous.map((row) => row.new_workspaces))), 'up') : undefined}
          />
        </MetricCard>

        <MetricCard metricKey="value_activations" label="Value activations">
          <StatBlock
            label={`Activated (${windowLabel})`}
            value={activations}
            detail={newWorkspaces > 0 ? `${ratio(activations, newWorkspaces)} of signups` : 'First mailbox operation'}
            explain="Workspaces that reached their first successful call touching a real mailbox: a success with an inbox attached that was not just inbox_list. Connecting an inbox and never using it does not count. The ratio compares two counts over the same window, not one cohort followed through, so it moves when either changes."
            spark={rows.slice(-SPARK_DAYS).map((row) => row.value_activations)}
            delta={previous ? tone(delta(activations, sum(previous.map((row) => row.value_activations))), 'up') : undefined}
          />
        </MetricCard>

        <MetricCard metricKey="active_28d" label="Active workspaces, 28 day">
          <StatBlock
            label="Active (28d)"
            value={latest?.active_28d ?? 0}
            detail={`${formatCount(latest?.active_7d ?? 0)} of them in the last 7 days`}
            explain="Distinct workspaces with a successful MCP tool call in the trailing 28 days. Any successful call counts, including a bare inbox_list, so it is a looser bar than value activation. The 28 day figure moves slowly and is the more trustworthy of the two at this volume."
            spark={rows.slice(-SPARK_DAYS).map((row) => row.active_28d)}
            delta={priorSameDay ? tone(delta(latest?.active_28d ?? 0, priorSameDay.active_28d), 'up') : undefined}
          />
        </MetricCard>
      </section>

      {/* One line, and only when a query failed. A missing section on a metrics
          page reads as a zero, which is a dangerous thing to imply about
          revenue; this says so in words instead. */}
      <FailureNote
        failures={[
          { source: 'Product metrics', error: dailyResult.ok ? null : dailyResult.error },
          { source: 'People counts', error: peopleResult.ok ? null : peopleResult.error },
          { source: 'Stripe subscriptions', error: revenueResult.ok ? null : revenueResult.error },
          { source: 'Stripe charges', error: cashResult.ok ? null : cashResult.error },
          { source: 'Checkout funnel', error: checkoutResult.ok ? null : checkoutResult.error },
        ]}
      />
    </>
  );
}

function FailureNote({ failures }: { failures: { source: string; error: string | null }[] }) {
  const broken = failures.filter((entry): entry is { source: string; error: string } => entry.error !== null);
  if (broken.length === 0) return null;
  return (
    <ul className="growth-flags" aria-label="Scoreboard read failures">
      {broken.map((entry) => (
        <li key={entry.source} className="is-bad">
          <strong>{entry.source}</strong> could not be read, so the cards above that depend on it show no
          number rather than a zero. <code>{entry.error}</code>
        </li>
      ))}
    </ul>
  );
}
