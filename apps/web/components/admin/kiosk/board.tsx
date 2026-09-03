/**
 * The kiosk board: one screen of numbers, refreshed on a timer, read from
 * across a room.
 *
 * WHY EACH VIEW IS ONE COMPONENT rather than a Suspense boundary per section
 * like /admin/growth. That page is opened by a person who is waiting for it, so
 * streaming each panel as its query lands is the right trade. This one is
 * unattended: nobody is watching the moment it loads, and a board that paints
 * in nine stages every five minutes is a board that spends its life visibly
 * reassembling itself. One `Promise.all`, one paint, and the previous frame
 * stays on screen until the new one is complete.
 *
 * WHAT IS DELIBERATELY MISSING FROM EVERY VIEW: the Active accounts roster. It
 * is the only part of /admin/growth that names workspaces and owner email
 * addresses, and this screen hangs on a wall where anyone in the room can read
 * it, reachable with a shared token rather than an operator login. Everything
 * here is an aggregate.
 *
 * THE SHAPE IS FIXED AND THAT IS THE POINT. Every view renders exactly ten
 * tiles in the same spans: four headline numbers, two panels of seven and five
 * columns, four supporting tiles. The stylesheet's one-screen guarantee is a
 * grid template with four rows, so a view that invented its own layout would be
 * the view that quietly starts needing a scroll on the panel nobody can scroll.
 * A new view fills the ten slots or it does not ship.
 *
 * PEOPLE, NOT WORKSPACES, since 2026-09-01. The headline counts used to be
 * workspaces because the two were interchangeable; they are still very nearly
 * so (324 users own 325 workspaces), but the question the room asks is the
 * human one and a workspace count would have started answering it wrongly, with
 * no visible change, the first time somebody made a second workspace. See
 * growth_people_counts in the migration for what "active" means and whose
 * activity it is.
 */

import {
  fetchAcquisitionChannels,
  fetchActivationFunnel,
  fetchClientMix,
  fetchDailyMetrics,
  fetchEngagementBands,
  fetchErrorBreakdown,
  fetchGmailCapSummary,
  fetchLifecycleCounts,
  fetchPeopleCounts,
  fetchProviderMix,
  fetchRetentionCurve,
  fetchRevenueCounts,
  fetchUpgradePressure,
  fetchUsageVolume,
  fetchUserSignupDays,
  gmailCapProjection,
} from '@/lib/analytics/growth-queries';
import { GMAIL_OAUTH_USER_CAP } from '@/lib/analytics/growth-types';
import type {
  GmailCapSummaryRow,
  GrowthPeopleCountsRow,
  GrowthUserSignupDayRow,
} from '@/lib/analytics/growth-types';
import {
  fetchCashCollected,
  fetchCheckoutFunnel,
  fetchRecurringRevenue,
  valuationMultiple,
} from '@/lib/analytics/kiosk-revenue';
import type { CashCollected, CheckoutFunnel } from '@/lib/analytics/kiosk-revenue';
import { valuationFromArr, type RevenueSummary } from '@/lib/analytics/revenue-math';
import { fetchRecentIncidents } from '@/lib/analytics/kiosk-health';
import type { MonitorIncident } from '@/lib/analytics/kiosk-health';
import { NO_DATA, formatCount, formatMoney, formatPercent, ratio } from '../charts';
import {
  BarList,
  BigNumber,
  EventList,
  FactRow,
  FunnelSteps,
  Gauge,
  GroupedColumns,
  Tile,
  TileError,
} from './primitives';
import { KioskHealthTile } from './KioskHealth';
import {
  attemptRate,
  CHART_WEEKS,
  DAILY_DAYS,
  FUNNEL_DAYS,
  KIOSK_WINDOW_DAYS,
  prettyChannel,
  prettyProvider,
  signupWeeks,
  sum,
  sumBy,
  trend,
  type KioskViewId,
} from './shared';

// Re-exported because detail.tsx and the page have imported it from here since
// the board shipped, and moving a constant is not worth breaking two call
// sites over.
export { KIOSK_WINDOW_DAYS };

/**
 * The dispatcher.
 *
 * A plain switch rather than a lookup table of components: each board has a
 * different (empty) prop shape today and the table would have to be typed as
 * `any` to hold them, which would let a typo in a view id render nothing at all
 * on a screen nobody is watching.
 */
export async function KioskBoard({ view }: { view: KioskViewId }) {
  switch (view) {
    case 'money':
      return <MoneyBoard />;
    case 'growth':
      return <GrowthBoard />;
    case 'stickiness':
      return <StickinessBoard />;
    case 'uptime':
      return <UptimeBoard />;
    default:
      return <PulseBoard />;
  }
}

/* ========================================================== PULSE (default) */

/**
 * How are we doing.
 *
 * The view the panel sits on and returns to. Four headline numbers that
 * together describe the whole business (how many people, how many of them use
 * it, how many pay, what that is worth), the eight week trend, and the ladder
 * to a paying customer. Everything below is supporting.
 */
async function PulseBoard() {
  const days = KIOSK_WINDOW_DAYS;

  const [
    people, signups, daily, lifecycle, counts, funnel, bands,
    gmail, providers, usage, recurring, checkout, cash,
  ] = await Promise.all([
    fetchPeopleCounts(days),
    fetchUserSignupDays(DAILY_DAYS),
    fetchDailyMetrics(days),
    fetchLifecycleCounts(),
    fetchRevenueCounts(),
    fetchActivationFunnel(FUNNEL_DAYS),
    fetchEngagementBands(days),
    fetchGmailCapSummary(),
    fetchProviderMix(),
    fetchUsageVolume(days),
    fetchRecurringRevenue(days),
    fetchCheckoutFunnel(),
    fetchCashCollected(),
  ]);

  const money = counts.ok ? counts.data : null;
  const mrr = recurring.ok ? recurring.data : null;
  const volume = usage.ok ? usage.data : null;
  const life = lifecycle.ok ? lifecycle.data : null;
  const rows = daily.ok ? daily.data : [];

  // Feeds the long-run baseline in the live health tile, and nothing else.
  const calls = sum(rows, 'calls');
  const successes = sum(rows, 'successes');
  const throttled = sum(rows, 'rate_limited');

  return (
    <>
      {/* ---- Row 2: the four numbers the business turns on ---- */}

      <SignedUpTile people={people.ok ? people.data : null} error={people.ok ? null : people.error} days={days}
        signups={signups.ok ? signups.data : null} />

      <ActiveUsersTile people={people.ok ? people.data : null} error={people.ok ? null : people.error} days={days} />

      <SubscribersTile recurring={recurring} money={money} />

      <RevenueTile recurring={recurring} money={money} cash={cash.ok ? cash.data : null} />

      {/* ---- Row 3: the two panels worth standing still for ---- */}

      <SignupsChartTile signups={signups} span={7} />

      {funnel.ok ? (
        <Tile label="Road to a paying customer" aside="workspaces, all accounts" span={5}>
          <FunnelSteps
            steps={milestoneSteps(
              funnel.data,
              { returning: returningWorkspaces(bands.ok ? bands.data : []), oneAndDone: life?.one_and_done ?? null },
              checkout.ok ? checkout.data : null,
              mrr,
            )}
          />
        </Tile>
      ) : (
        <TileError label="Road to a paying customer" message={funnel.error} span={5} />
      )}

      {/* ---- Row 4: the supporting strip ---- */}

      {gmail.ok ? <GmailTile summary={gmail.data} /> : (
        <TileError label="Gmail OAuth headroom" message={gmail.error} span={3} className="kiosk-strip" />
      )}

      {/* LIVE, not 28 days. The tile that used to be here divided 28 days of
          successes by 28 days of calls, which is a fair summary of a quarter
          and useless as an alarm: an endpoint that has answered nothing since
          breakfast still reads 99% on it, in calm grey, because twenty eight
          days of history cannot move in a morning. The long-run figure is
          still worth having and is now a fact under the headline; the headline
          is the last hour, refreshed on its own 45 second clock rather than the
          board's five minute one. */}
      <KioskHealthTile baselineRate={attemptRate(successes, calls, throttled)} baselineDays={days} />

      <WorkDoneTile volume={volume} ok={usage.ok} days={days} />

      <ProvidersTile providers={providers} />
    </>
  );
}

/* ================================================================== MONEY */

/**
 * What have we earned.
 *
 * THE THREE MONEY NUMBERS ARE NOT THE SAME NUMBER AND ARE MEANT TO DISAGREE.
 * MRR is forward looking and normalised: a year bought up front shows as a
 * twelfth per month. Cash is what actually reached the bank, which for that
 * same customer was the whole year in one August afternoon. Valuation is MRR
 * run through one arithmetic convention. On 2026-09-01 they read $4/mo, $43
 * and $192, and every one of those is correct. A board showing only one of them
 * either claims the business earns twelve times what it recurringly does, or
 * hides every dollar that has ever arrived.
 */
async function MoneyBoard() {
  const days = KIOSK_WINDOW_DAYS;

  const [recurring, cash, checkout, counts, pressure] = await Promise.all([
    fetchRecurringRevenue(days),
    fetchCashCollected(),
    fetchCheckoutFunnel(),
    fetchRevenueCounts(),
    fetchUpgradePressure(),
  ]);

  const mrr = recurring.ok ? recurring.data : null;
  const money = counts.ok ? counts.data : null;
  const collected = cash.ok ? cash.data : null;

  return (
    <>
      <RevenueTile recurring={recurring} money={money} cash={collected} />

      <ValuationTile mrr={mrr} error={recurring.ok ? null : recurring.error} />

      <CashTile cash={cash} />

      <SubscribersTile recurring={recurring} money={money} />

      {/* Cash by month, not by week. Four customers pay on four different days
          of the month, so a weekly cash chart is four spikes and a lot of
          nothing; a month is the smallest bucket in which this business has a
          shape at all. */}
      {cash.ok ? (
        <Tile
          label="Cash by month"
          aside={collected && collected.mode === 'test' ? 'TEST MODE' : 'net of refunds'}
          span={7}
          tone={collected && collected.mode === 'test' ? 'warn' : 'default'}
        >
          {collected && collected.months.length > 0 ? (
            <GroupedColumns
              buckets={collected.months.slice(-CHART_WEEKS).map((month) => ({
                label: MONTH_LABEL.format(new Date(`${month.month}T00:00:00Z`)),
                values: [Math.round(month.netMinor / 100)],
              }))}
              series={[{ name: `Cash (${(collected.currency ?? 'usd').toUpperCase()})`, color: 'var(--kiosk-good)' }]}
            />
          ) : (
            <p className="kiosk-empty">No charge has ever succeeded.</p>
          )}
        </Tile>
      ) : (
        <TileError label="Cash by month" message={cash.error} span={7} />
      )}

      {/* The rung to read first is "abandoned". It is the only step where
          somebody had already decided to pay us and did not, which makes it the
          one number on this view with a fix attached rather than a strategy. */}
      {checkout.ok ? (
        <Tile
          label="Where the money is lost"
          aside={checkout.data.lastCompletedAt ? `last sale ${daysAgo(checkout.data.lastCompletedAt)}` : 'no sale yet'}
          span={5}
        >
          <FunnelSteps steps={checkoutSteps(checkout.data, mrr)} />
        </Tile>
      ) : (
        <TileError label="Where the money is lost" message={checkout.error} span={5} />
      )}

      {/* ---- strip ---- */}

      {recurring.ok && mrr ? (
        <Tile label="Which tier pays" aside={`${formatMoney(mrr.arrMinor, mrr.currency)}/yr`} span={3} className="kiosk-strip">
          <BarList
            rows={mrr.byPlan.map((plan) => ({ name: plan.label, count: plan.customers }))}
            emptyLabel="No paid subscription is live"
            color="var(--kiosk-good)"
          />
        </Tile>
      ) : (
        <TileError label="Which tier pays" message={recurring.ok ? 'Stripe returned no subscriptions.' : recurring.error} span={3} className="kiosk-strip" />
      )}

      {/* The population the INBOX paywall is actually in front of. The
          activated subset is the number worth acting on: a workspace that hit
          the ceiling without ever performing a mailbox operation is blocked by
          onboarding, not by price. */}
      {pressure.ok ? (
        <Tile
          label="At the inbox ceiling"
          aside={`${pressure.data.grandfathered_workspaces} exempt`}
          span={3}
          className="kiosk-strip"
          tone={pressure.data.at_ceiling_activated > 0 ? 'goal' : 'default'}
        >
          <BigNumber
            value={pressure.data.at_ceiling}
            caption={<><strong>{pressure.data.at_ceiling_activated}</strong> of them have used a mailbox</>}
          />
          <FactRow
            facts={[
              { label: 'Capped', value: pressure.data.capped_workspaces },
              { label: 'Paid', value: pressure.data.paid_workspaces },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="At the inbox ceiling" message={pressure.error} span={3} className="kiosk-strip" />
      )}

      {/* MONEY AT RISK IS STILL IN MRR. The app entitles a failing card through
          dunning, so dropping it on the first bounce would paint a collapse
          that has not happened. It is reported here instead, which is the only
          honest place for it. */}
      {recurring.ok && mrr ? (
        <Tile
          label="Money at risk"
          aside={mrr.atRiskCustomers + mrr.leavingCustomers === 0 ? 'nothing' : 'walk over'}
          span={3}
          className="kiosk-strip"
          tone={mrr.atRiskMinor > 0 ? 'bad' : mrr.leavingMinor > 0 ? 'warn' : 'good'}
        >
          <BigNumber
            value={formatMoney(mrr.atRiskMinor + mrr.leavingMinor, mrr.currency)}
            suffix="/mo"
            caption={riskCaption(mrr)}
          />
          <FactRow
            facts={[
              { label: 'Card failing', value: mrr.atRiskCustomers },
              { label: 'Leaving', value: mrr.leavingCustomers },
              { label: 'Comped', value: mrr.compedCustomers },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Money at risk" message={recurring.ok ? 'Stripe returned no subscriptions.' : recurring.error} span={3} className="kiosk-strip" />
      )}

      {counts.ok ? (
        <Tile label="Still to convert" aside="free plans" span={3} className="kiosk-strip">
          <BigNumber
            value={counts.data.free_workspaces}
            caption={
              checkout.ok
                ? <><strong>{checkout.data.pricingViewed}</strong> have looked at the plans</>
                : 'Free workspaces with no paid subscription'
            }
          />
          <FactRow
            facts={[
              { label: 'Comped', value: counts.data.comped_workspaces },
              { label: 'Ours', value: counts.data.internal_workspaces },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Still to convert" message={counts.error} span={3} className="kiosk-strip" />
      )}
    </>
  );
}

/* ================================================================= GROWTH */

/**
 * Who is arriving.
 *
 * The only view whose four headline numbers are all about the top of the
 * funnel, which is the point: on Pulse the arrival numbers have to share a row
 * with the money, and when arrivals are the question that is the wrong trade.
 */
async function GrowthBoard() {
  const days = KIOSK_WINDOW_DAYS;

  const [people, signups, channels, providers, clients, gmail, funnel] = await Promise.all([
    fetchPeopleCounts(days),
    fetchUserSignupDays(DAILY_DAYS),
    fetchAcquisitionChannels(days),
    fetchProviderMix(),
    fetchClientMix(),
    fetchGmailCapSummary(),
    fetchActivationFunnel(FUNNEL_DAYS),
  ]);

  const head = people.ok ? people.data : null;
  const peopleError = people.ok ? null : people.error;

  return (
    <>
      <SignedUpTile people={head} error={peopleError} days={days} signups={signups.ok ? signups.data : null} />

      {head ? (
        <Tile label={`New this ${days}d`} aside="people" span={3} tone={head.new_users > head.prev_new_users ? 'good' : 'default'}>
          <BigNumber
            value={head.new_users}
            trend={trend(head.new_users, head.prev_new_users, 'up')}
            caption={<>Previous {days} days: <strong>{formatCount(head.prev_new_users)}</strong></>}
            spark={(signups.ok ? signups.data : []).slice(-30).map((row) => row.new_users)}
          />
        </Tile>
      ) : (
        <TileError label={`New this ${days}d`} message={peopleError ?? 'unavailable'} span={3} />
      )}

      {head ? (
        <Tile label="Reached a mailbox" aside="ever" span={3} tone="good">
          <BigNumber
            value={head.activated_users}
            caption={<>{ratio(head.activated_users, head.total_users)} of everyone who signed up</>}
            spark={(signups.ok ? signups.data : []).slice(-30).map((row) => row.activated_users)}
            sparkColor="var(--kiosk-good)"
          />
        </Tile>
      ) : (
        <TileError label="Reached a mailbox" message={peopleError ?? 'unavailable'} span={3} />
      )}

      <ActiveUsersTile people={head} error={peopleError} days={days} />

      <SignupsChartTile signups={signups} span={7} />

      {/* ATTRIBUTION ONLY EXISTS FROM 2026-08-05 and lands null on a share of
          signups, so "Unknown" is a real row rather than a dropped one: the
          rows have to sum to the signup count or they will eventually be read
          as if they did. */}
      {channels.ok ? (
        <Tile label="Where they come from" aside={`${days}d, first touch`} span={5}>
          <BarList
            rows={channels.data
              .slice()
              .sort((a, b) => b.signups - a.signups)
              .slice(0, 7)
              .map((row) => ({
                name: prettyChannel(row.source),
                count: row.signups,
                // An unattributed row is a gap in our own measurement, not a
                // channel. Greyed so it never reads as the winner.
                color: row.source === 'unattributed' ? 'var(--fg-4)' : undefined,
              }))}
            emptyLabel="No signup in the window"
          />
        </Tile>
      ) : (
        <TileError label="Where they come from" message={channels.error} span={5} />
      )}

      {/* ---- strip ---- */}

      <ProvidersTile providers={providers} />

      {clients.ok ? (
        <Tile label="MCP client on first success" aside="all time" span={3} className="kiosk-strip">
          <BarList
            rows={clients.data
              .slice()
              .sort((a, b) => b.workspaces - a.workspaces)
              .slice(0, 5)
              .map((row) => ({ name: row.client || 'Unknown', count: row.workspaces }))}
            emptyLabel="No client recorded yet"
          />
        </Tile>
      ) : (
        <TileError label="MCP client on first success" message={clients.error} span={3} className="kiosk-strip" />
      )}

      {gmail.ok ? <GmailTile summary={gmail.data} /> : (
        <TileError label="Gmail OAuth headroom" message={gmail.error} span={3} className="kiosk-strip" />
      )}

      {/* The onboarding funnel in workspaces, not people: it comes from the
          activation RPC, which counts workspaces and includes our own. Said in
          the aside rather than silently mixed with the human counts above. */}
      {funnel.ok ? (
        <Tile label="Onboarding" aside="workspaces, all" span={3} className="kiosk-strip">
          <FunnelSteps
            steps={[
              { label: 'Created a workspace', value: stageOf(funnel.data, 'signup') },
              { label: 'Connected an inbox', value: stageOf(funnel.data, 'inbox_connected') },
              { label: 'Used it', value: stageOf(funnel.data, 'value_activation') },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Onboarding" message={funnel.error} span={3} className="kiosk-strip" />
      )}
    </>
  );
}

/* ============================================================ STICKINESS */

/**
 * Who stays.
 *
 * The view that is allowed to be uncomfortable. Every other board is capable of
 * looking healthy on arrivals alone; this one leads with the count of people
 * who tried the product once and never came back, because that is the number
 * the rest of the wall is best at hiding.
 */
async function StickinessBoard() {
  const days = KIOSK_WINDOW_DAYS;

  const [people, lifecycle, bands, retention, usage, providers] = await Promise.all([
    fetchPeopleCounts(days),
    fetchLifecycleCounts(),
    fetchEngagementBands(days),
    fetchRetentionCurve(8),
    fetchUsageVolume(days),
    fetchProviderMix(),
  ]);

  const head = people.ok ? people.data : null;
  const peopleError = people.ok ? null : people.error;
  const life = lifecycle.ok ? lifecycle.data : null;
  const returning = returningWorkspaces(bands.ok ? bands.data : []);

  return (
    <>
      <ActiveUsersTile people={head} error={peopleError} days={days} />

      {head ? (
        <Tile label="Active this week" aside="7d" span={3} tone="good">
          <BigNumber
            value={head.active_users_7d}
            caption={<>{ratio(head.active_users_7d, head.active_users)} of the {days} day set</>}
          />
        </Tile>
      ) : (
        <TileError label="Active this week" message={peopleError ?? 'unavailable'} span={3} />
      )}

      <Tile label="Came back" aside={`${days}d`} span={3} tone={returning > 0 ? 'good' : 'goal'}>
        <BigNumber
          value={bands.ok ? returning : NO_DATA}
          caption="Workspaces active on two or more separate days"
        />
      </Tile>

      {/* ONE AND DONE IS THE HEADLINE HERE, and it is on the board precisely
          because it is the number nobody wants on a wall. It counts people who
          reached a real mailbox, proved the product works for them, and never
          returned: the only failure mode that cannot be blamed on onboarding. */}
      {life ? (
        <Tile
          label="Tried once and left"
          aside="ever"
          span={3}
          tone={life.one_and_done > life.active_28d ? 'bad' : 'warn'}
        >
          <BigNumber
            value={life.one_and_done}
            caption={<>Of <strong>{formatCount(life.value_activated)}</strong> who ever reached a mailbox</>}
          />
        </Tile>
      ) : (
        <TileError label="Tried once and left" message={lifecycle.ok ? 'unavailable' : lifecycle.error} span={3} />
      )}

      {/* A workspace only enters `eligible` once its whole week has elapsed, so
          the last bar is never a half-lived week pretending to be a cliff. */}
      {retention.ok ? (
        <Tile label="Retention after the first mailbox" aside="external accounts" span={7}>
          {retention.data.length === 0 ? (
            <p className="kiosk-empty">No cohort has aged into a full week yet.</p>
          ) : (
            <GroupedColumns
              buckets={retention.data.map((point) => ({
                label: `W${point.week_index}`,
                values: [point.eligible, point.retained],
              }))}
              series={[
                { name: 'Eligible', color: 'var(--fg-4)' },
                { name: 'Came back', color: 'var(--kiosk-good)' },
              ]}
            />
          )}
        </Tile>
      ) : (
        <TileError label="Retention after the first mailbox" message={retention.error} span={7} />
      )}

      {bands.ok ? (
        <Tile label="How many days people showed up" aside={`${days}d`} span={5}>
          <BarList
            rows={bands.data
              .filter((row) => row.metric === 'active_days')
              .map((row) => ({
                name: `${row.band} ${row.band === '1' ? 'day' : 'days'}`,
                count: row.workspaces,
                // The one-day band is the churn band. Painting it the same
                // colour as the rest would hide the shape of the problem.
                color: row.band === '1' ? 'var(--fg-4)' : 'var(--kiosk-good)',
              }))}
            emptyLabel="No activity in the window"
          />
        </Tile>
      ) : (
        <TileError label="How many days people showed up" message={bands.error} span={5} />
      )}

      {/* ---- strip ---- */}

      {life ? (
        <Tile label="Going quiet" aside="14d silent" span={3} className="kiosk-strip" tone={life.at_risk > 0 ? 'warn' : 'good'}>
          <BigNumber
            value={life.at_risk}
            caption="Used it on two or more days, then stopped"
          />
        </Tile>
      ) : (
        <TileError label="Going quiet" message={lifecycle.ok ? 'unavailable' : lifecycle.error} span={3} className="kiosk-strip" />
      )}

      {head ? (
        <Tile label="Reached a mailbox" aside="ever" span={3} className="kiosk-strip">
          <BigNumber
            value={head.activated_users}
            caption={<>{ratio(head.activated_users, head.total_users)} of <strong>{formatCount(head.total_users)}</strong> signups</>}
          />
        </Tile>
      ) : (
        <TileError label="Reached a mailbox" message={peopleError ?? 'unavailable'} span={3} className="kiosk-strip" />
      )}

      <WorkDoneTile volume={usage.ok ? usage.data : null} ok={usage.ok} days={days} />

      <ProvidersTile providers={providers} />
    </>
  );
}

/* ================================================================= UPTIME */

/**
 * Is it working.
 *
 * The live health tile is normally one of twelve things on a wall, which is
 * correct: an outage is rare and a permanent alarm panel is wallpaper. This
 * view is what somebody switches to during the ten minutes it is not rare, and
 * it is the only one where the live tile gets a headline slot.
 *
 * TWO WITNESSES, one verdict, and they are on the same screen here. The
 * synthetic monitor says whether the public endpoint answers; the error rate
 * says whether real calls are succeeding. A green rate with a failing monitor
 * is a product whose four core paths are broken while its noisy ones still
 * answer; a red rate with a passing monitor is a regression the monitor's four
 * steps happen not to cover. Neither is legible without the other.
 */
async function UptimeBoard() {
  const days = KIOSK_WINDOW_DAYS;

  const [daily, errors, incidents, usage, providers] = await Promise.all([
    fetchDailyMetrics(days),
    fetchErrorBreakdown(days),
    fetchRecentIncidents(8),
    fetchUsageVolume(days),
    fetchProviderMix(),
  ]);

  const rows = daily.ok ? daily.data : [];
  const calls = sum(rows, 'calls');
  const successes = sum(rows, 'successes');
  const failures = sum(rows, 'errors');
  const throttled = sum(rows, 'rate_limited');
  const latestDay = rows.at(-1);
  // The two most recent COMPLETE days. Comparing today against yesterday is
  // the partial-period trap in its purest form: today is a few hours old every
  // morning, so the badge would read as a large decline until roughly dinner
  // time and then correct itself overnight, every single day. Today's own
  // figure is in the caption instead, where "so far" can be said in words.
  const yesterday = rows.at(-2);
  const dayBefore = rows.at(-3);

  return (
    <>
      <KioskHealthTile
        baselineRate={attemptRate(successes, calls, throttled)}
        baselineDays={days}
        span={3}
        className=""
      />

      {daily.ok ? (() => {
        const rate = attemptRate(successes, calls, throttled);
        return (
          <Tile
            label="Success rate"
            aside={`${days}d`}
            span={3}
            tone={rate === null ? 'default' : rate >= 0.99 ? 'good' : rate >= 0.95 ? 'warn' : 'bad'}
          >
            <BigNumber
              value={rate === null ? NO_DATA : formatPercent(rate, 2)}
              caption={<><strong>{formatCount(failures)}</strong> failures in <strong>{formatCount(calls - throttled)}</strong> attempted calls</>}
              spark={rows.slice(-30).map((row) => {
                const dayRate = attemptRate(row.successes, row.calls, row.rate_limited);
                return dayRate === null ? 100 : dayRate * 100;
              })}
              sparkColor="var(--kiosk-good)"
            />
          </Tile>
        );
      })() : (
        <TileError label="Success rate" message={daily.error} span={3} />
      )}

      {daily.ok ? (
        <Tile label="Calls" aside={`${days}d`} span={3}>
          <BigNumber
            value={calls}
            trend={trend(yesterday?.calls ?? 0, dayBefore?.calls ?? null, 'up')}
            caption={
              <>
                <strong>{formatCount(latestDay?.calls ?? 0)}</strong> so far today.
                Badge compares the last two full days.
              </>
            }
            spark={rows.slice(-30).map((row) => row.calls)}
          />
        </Tile>
      ) : (
        <TileError label="Calls" message={daily.error} span={3} />
      )}

      {/* Throttling is not failure and must not be folded into the rate. It used
          to be rare to nonexistent; since the plan-cap rejection logging change
          (2026-09) it can be a large share of a day's calls, and Success rate
          above now excludes it from the denominator for exactly this reason: an
          abuse guard doing its job must not be read as an outage. */}
      {daily.ok ? (
        <Tile label="Failures" aside={`${days}d`} span={3} tone={failures > 0 ? 'warn' : 'good'}>
          <BigNumber
            value={failures}
            caption={throttled > 0
              ? <><strong>{formatCount(throttled)}</strong> rate limited, counted separately</>
              : 'Nothing was rate limited'}
            spark={rows.slice(-30).map((row) => row.errors)}
            sparkColor="var(--kiosk-bad)"
          />
        </Tile>
      ) : (
        <TileError label="Failures" message={daily.error} span={3} />
      )}

      {errors.ok ? (
        <Tile label="What is failing" aside={`${days}d`} span={7}>
          <BarList
            rows={errors.data.slice(0, 6).map((row) => ({
              name: `${row.tool_name}${row.error_code ? ` · ${row.error_code}` : ''}`,
              count: row.failures,
              color: 'var(--kiosk-bad)',
            }))}
            emptyLabel="No failure recorded in the window"
          />
        </Tile>
      ) : (
        <TileError label="What is failing" message={errors.error} span={7} />
      )}

      {/* THE ONLY DURABLE RECORD ON THE BOARD. `activity_log` is purged at 90
          days and the raw run history is noise, but an incident row is a
          deduplicated, human-sized fact about a time the product stopped
          working. An OPEN incident gets the word OPEN and never a date, because
          the one thing a reader must not do with this list is scan a column of
          dates and conclude everything in it is over. */}
      <Tile
        label="Outage log"
        aside={incidentAside(incidents)}
        span={5}
        tone={incidents.some((row) => row.status === 'open') ? 'bad' : 'default'}
      >
        <EventList
          rows={incidents.map((incident) => ({
            key: incident.fingerprint,
            title: incident.failedStep,
            note: `${incident.failureClass.replace(/_/g, ' ')} · ${incident.consecutiveFailures}x`,
            when: incident.status === 'open' ? 'OPEN' : daysAgo(incident.resolvedAt ?? incident.lastFailureAt),
            tone: incident.status === 'open' ? 'bad' : 'default',
          }))}
          emptyLabel="The synthetic monitor has never opened an incident."
        />
      </Tile>

      {/* ---- strip ---- */}

      <WorkDoneTile volume={usage.ok ? usage.data : null} ok={usage.ok} days={days} />

      {daily.ok ? (
        <Tile label="Busiest day" aside={`last ${days}d`} span={3} className="kiosk-strip">
          <BigNumber
            value={Math.max(0, ...rows.map((row) => row.calls))}
            caption={<>Calls in a single UTC day. Median <strong>{formatCount(medianOf(rows.map((row) => row.calls)))}</strong>.</>}
          />
        </Tile>
      ) : (
        <TileError label="Busiest day" message={daily.error} span={3} className="kiosk-strip" />
      )}

      {daily.ok ? (
        <Tile label="Quietest day" aside={`last ${days}d`} span={3} className="kiosk-strip">
          <BigNumber
            value={rows.length === 0 ? NO_DATA : Math.min(...rows.map((row) => row.calls))}
            caption="A genuinely quiet night exists at this volume and is not an outage"
          />
        </Tile>
      ) : (
        <TileError label="Quietest day" message={daily.error} span={3} className="kiosk-strip" />
      )}

      <ProvidersTile providers={providers} />
    </>
  );
}

/* ====================================================== shared tile bodies */

/**
 * CUMULATIVE USERS SIGNED UP.
 *
 * It took this slot from "Active workspaces" on 2026-09-01. The swap is worth
 * stating because losing a live-usage number from the first slot of a wall
 * board is not obviously an improvement.
 *
 * It is, for two reasons. The first is that active usage did not leave the
 * board, it moved one tile to the right and became a count of PEOPLE rather
 * than of workspaces, which is what the room was reading it as anyway. The
 * second is that this is the only number on the board that can only go up, and
 * a wall display needs exactly one of those. Every other headline here is a
 * rolling window that can fall for reasons nobody controls: a quiet week, a
 * holiday, a customer on leave. A board made entirely of numbers that can drop
 * overnight is a board people learn to stop looking at.
 *
 * The trend is against the population that existed at the start of the window,
 * so it reads as growth in the user base rather than as a rate of arrivals; the
 * arrival count itself is in the caption, where it belongs.
 */
function SignedUpTile({
  people,
  error,
  days,
  signups,
}: {
  people: GrowthPeopleCountsRow | null;
  error: string | null;
  days: number;
  signups: GrowthUserSignupDayRow[] | null;
}) {
  if (!people) {
    return <TileError label="Signed up" message={error ?? 'People counts unavailable.'} span={3} />;
  }
  return (
    <Tile label="Signed up" aside="all time" span={3} tone="good">
      <BigNumber
        value={people.total_users}
        trend={trend(people.total_users, people.total_users_prior, 'up')}
        caption={
          <>
            <strong>{formatCount(people.new_users)}</strong> arrived in the last {days} days
            {people.internal_users > 0 ? `, ${people.internal_users} of ours excluded` : ''}
          </>
        }
        // The running total, not the daily arrivals: this tile's headline is a
        // cumulative number and a spark of the daily count under it would be a
        // second, different metric wearing the first one's label.
        spark={(signups ?? []).slice(-30).map((row) => row.cumulative_users)}
      />
    </Tile>
  );
}

/**
 * ACTIVE USERS.
 *
 * It replaced "Value activations" on 2026-09-01. That tile counted first-ever
 * mailbox operations inside a 28 day window, which is a good onboarding metric
 * and a bad headline: it can only ever describe people who arrived recently, so
 * it says nothing at all about whether anybody who signed up in June still
 * uses the product. This says exactly that, and the activation count it
 * displaced is still on the board, on the Growth view, where an onboarding
 * number belongs.
 *
 * "Active" is a successful call by a workspace the person OWNS. `activity_log`
 * records a workspace rather than the human who made the call, so the owner is
 * the finest grain honestly available; at 324 users and 325 workspaces the
 * difference is currently nil and the definition is stated so it stays honest
 * when it is not.
 */
function ActiveUsersTile({
  people,
  error,
  days,
}: {
  people: GrowthPeopleCountsRow | null;
  error: string | null;
  days: number;
}) {
  if (!people) {
    return <TileError label="Active users" message={error ?? 'People counts unavailable.'} span={3} />;
  }
  return (
    <Tile label="Active users" aside={`${days}d`} span={3} tone={people.active_users > 0 ? 'good' : 'warn'}>
      <BigNumber
        value={people.active_users}
        trend={trend(people.active_users, people.prev_active_users, 'up')}
        caption={<><strong>{formatCount(people.active_users_7d)}</strong> in the last 7 days</>}
      />
      <FactRow
        facts={[
          { label: 'Of everyone', value: ratio(people.active_users, people.total_users) },
          { label: 'Reached a mailbox', value: people.activated_users },
        ]}
      />
    </Tile>
  );
}

/**
 * The narrowed shape of a `GrowthResult` once the tile only cares whether it
 * has a summary. Written out rather than imported so a tile can be handed
 * either a real result or a pre-unwrapped one without a cast at every call
 * site; every consumer below still has to check `ok` before reading `data`.
 */
type MoneyResult = { ok: boolean; data?: RevenueSummary; error?: string };

/**
 * THE SUBSCRIBER COUNT.
 *
 * It cannot be derived from anything else on the board. MRR beside it is the
 * money, and money is not people: one Team seat and sixteen Personal ones are
 * the same headline and completely different businesses, and the 2026-08-19
 * repricing was a bet on which of those we would become.
 *
 * COMPS ARE NOT SUBSCRIBERS AND ARE NOT HIDDEN. A comped account is a live
 * subscription on a paid price with a 100% off coupon: a real person using the
 * product, contributing nothing. Counting them here would inflate the only
 * number on the board that is supposed to be uninflatable, so they sit in the
 * aside instead.
 */
function SubscribersTile({
  recurring,
  money,
}: {
  recurring: MoneyResult;
  money: { free_workspaces: number } | null;
}) {
  const mrr = recurring.ok ? recurring.data ?? null : null;
  if (!mrr) {
    return (
      <TileError
        label="Paying subscribers"
        message={recurring.ok ? 'Stripe returned no subscriptions.' : recurring.error ?? 'unavailable'}
        span={3}
      />
    );
  }
  return (
    <Tile
      label="Paying subscribers"
      aside={mrr.compedCustomers > 0 ? `${mrr.compedCustomers} comped` : 'paid plans'}
      span={3}
      tone={mrr.payingCustomers > 0 ? 'good' : 'goal'}
    >
      <BigNumber
        value={mrr.payingCustomers}
        // Derived the same way the MRR trend is: today's count less what
        // arrived and plus what left inside the window. Exact, and exact for
        // the same reason, since a plan change moves money without moving the
        // headcount.
        trend={
          mrr.newCustomers === 0 && mrr.churnedCustomers === 0
            ? null
            : trend(mrr.payingCustomers, mrr.payingCustomers - mrr.newCustomers + mrr.churnedCustomers, 'up')
        }
        caption={subscriberCaption(mrr, money)}
      />
    </Tile>
  );
}

/**
 * THE MONEY TILE, now carrying three numbers instead of one.
 *
 * PRICED FROM STRIPE, NOT FROM OUR PRICE TABLE. A comped account is a live
 * subscription carrying a 100% off coupon, so priced from `plan` it reads as
 * full revenue and priced from Stripe it correctly reads as nothing. Yearly is
 * divided by twelve rather than booked in the month it lands: our first sale
 * was a year up front, and showing $43 of MRR would report thirty times the
 * truth and then appear to lose it all the month after. See revenue-math.ts.
 *
 * WHY VALUATION AND CASH SIT UNDER IT RATHER THAN BESIDE IT. They were asked
 * for on 2026-09-01 and there is no fifth headline slot: the row is four tiles
 * wide and the one-screen rule is a grid template, not a preference. They are
 * facts under the headline instead, which is also the honest hierarchy. MRR is
 * measured, cash is measured, and the valuation is one multiplication applied
 * to the first of those. Giving the derived number the same visual weight as
 * the two real ones would be the tile's only lie. The Money view gives all
 * three a headline each for the two minutes somebody wants that.
 *
 * THE ASIDE IS A TRIAGE SLOT, not a label. A failing card and a subscription
 * already set to stop are the two things worth walking over for, and they say
 * so there in priority order. Payments that are failing stay IN the MRR figure,
 * because the app still entitles them through dunning and dropping them on the
 * first bounce would paint a collapse that has not happened.
 *
 * A FAILED READ IS NOT A ZERO. Stripe being down must read as Stripe being
 * down: zero is a plausible value here, and nothing else would distinguish
 * "nobody has paid" from "the query did not answer".
 */
function RevenueTile({
  recurring,
  money,
  cash,
}: {
  recurring: MoneyResult;
  money: { free_workspaces: number } | null;
  cash: CashCollected | null;
}) {
  const mrr = recurring.ok ? recurring.data ?? null : null;
  if (!mrr) {
    return (
      <TileError
        label="Recurring revenue"
        message={recurring.ok ? 'Stripe returned no subscriptions.' : recurring.error ?? 'unavailable'}
        span={3}
      />
    );
  }
  const valuation = valuationFromArr(mrr.arrMinor, valuationMultiple());
  return (
    <Tile label="Recurring revenue" aside={revenueAside(mrr)} span={3} tone={revenueTone(mrr)}>
      <BigNumber
        value={formatMoney(mrr.mrrMinor, mrr.currency)}
        suffix="/mo"
        // The prior period is derived, not stored: today's MRR less what
        // arrived and left inside the window. That is exact while nobody has
        // upgraded or downgraded, which is true today and is noted in
        // revenue-math.ts as the thing to revisit once it is not.
        trend={mrr.netNewMrrMinor === 0 ? null : trend(mrr.mrrMinor, mrr.mrrMinor - mrr.netNewMrrMinor, 'up')}
        caption={revenueCaption(mrr, money)}
      />
      <FactRow
        facts={[
          { label: `Worth ${valuation.multiple}x ARR`, value: formatMoney(valuation.valuationMinor, mrr.currency) },
          {
            label: 'Cash in',
            value: cash ? formatMoney(cash.allTimeMinor, cash.currency) : NO_DATA,
          },
        ]}
      />
    </Tile>
  );
}

/**
 * THE VALUATION, given a headline of its own on the Money view.
 *
 * It is ARR times a multiple and nothing else, and the tile says so in the
 * aside and again in the caption, because a large currency figure on a wall is
 * the single easiest number in this building to mistake for a fact. It moves
 * the instant MRR moves and carries every one of MRR's caveats.
 *
 * DASHED FRAME, deliberately: `is-goal` is the board's existing convention for
 * a number that is a target or a construction rather than an achievement, and
 * this is the only figure on any view that was arrived at by multiplication.
 */
function ValuationTile({ mrr, error }: { mrr: RevenueSummary | null; error: string | null }) {
  if (!mrr) {
    return <TileError label="Company valuation" message={error ?? 'Stripe returned no subscriptions.'} span={3} />;
  }
  const valuation = valuationFromArr(mrr.arrMinor, valuationMultiple());
  return (
    <Tile label="Company valuation" aside={`${valuation.multiple}x ARR`} span={3} tone="goal">
      <BigNumber
        value={formatMoney(valuation.valuationMinor, mrr.currency)}
        caption={
          <>
            <strong>{formatMoney(mrr.arrMinor, mrr.currency)}</strong> ARR at {valuation.multiple}x. An
            arithmetic convention, not an offer.
          </>
        }
      />
      <FactRow
        facts={[
          { label: 'Per subscriber', value: formatMoney(mrr.arpaMinor, mrr.currency) },
          { label: 'Subscribers', value: mrr.payingCustomers },
        ]}
      />
    </Tile>
  );
}

/**
 * CASH ACTUALLY COLLECTED.
 *
 * The only money figure on the board that is a fact about the past rather than
 * a projection. It differs from ARR and that is correct: a year bought up front
 * arrives once and is recognised twelve times.
 *
 * TEST MODE IS SHOUTED, not footnoted. `.env.local` holds a test key and only
 * Vercel production holds the live one, so a locally rendered board would
 * otherwise show test-mode dollars in the same typeface as real ones, which is
 * worse than showing nothing.
 */
function CashTile({ cash }: { cash: { ok: boolean; data?: CashCollected; error?: string } }) {
  const data = cash.ok ? cash.data ?? null : null;
  if (!data) {
    return <TileError label="Cash collected" message={cash.error ?? 'Stripe returned no charges.'} span={3} />;
  }
  const test = data.mode === 'test';
  return (
    <Tile
      label="Cash collected"
      aside={test ? 'TEST MODE' : data.truncated ? 'at least' : 'all time'}
      span={3}
      tone={test ? 'warn' : data.allTimeMinor > 0 ? 'good' : 'goal'}
    >
      <BigNumber
        value={formatMoney(data.allTimeMinor, data.currency)}
        caption={
          data.charges === 0
            ? 'No charge has ever succeeded.'
            : <><strong>{formatMoney(data.last30Minor, data.currency)}</strong> of it in the last 30 days</>
        }
      />
      <FactRow
        facts={[
          { label: 'Charges', value: data.charges },
          { label: 'Since', value: data.since ? MONTH_LABEL.format(new Date(data.since)) : NO_DATA },
        ]}
      />
    </Tile>
  );
}

/** The eight calendar weeks chart, shared by Pulse and Growth. */
function SignupsChartTile({
  signups,
  span,
}: {
  signups: { ok: boolean; data?: GrowthUserSignupDayRow[]; error?: string };
  span: number;
}) {
  if (!signups.ok || !signups.data) {
    return <TileError label="Signups and activations" message={signups.error ?? 'unavailable'} span={span} />;
  }
  return (
    <Tile label="Signups and activations" aside={`${CHART_WEEKS} calendar weeks`} span={span}>
      <GroupedColumns
        buckets={signupWeeks(signups.data)}
        series={[
          { name: 'Signed up', color: 'var(--kiosk-accent)' },
          { name: 'Reached a mailbox', color: 'var(--kiosk-good)' },
        ]}
      />
    </Tile>
  );
}

/** Billable volume, in the supporting strip of four different views. */
function WorkDoneTile({
  volume,
  ok,
  days,
}: {
  volume: { billable_actions: number; billable_workspaces: number; total_workspaces: number; cap_hit_workspaces: number } | null;
  ok: boolean;
  days: number;
}) {
  return (
    <Tile label="Work done for customers" aside={`${days}d`} span={3} className="kiosk-strip">
      <BigNumber
        value={volume?.billable_actions ?? (ok ? 0 : NO_DATA)}
        caption={volume
          ? <>Billable actions across <strong>{volume.billable_workspaces}</strong> workspaces</>
          : 'Usage volume unavailable'}
      />
      {volume && (
        <FactRow
          facts={[
            { label: 'Estate', value: volume.total_workspaces },
            { label: 'At the cap', value: volume.cap_hit_workspaces },
          ]}
        />
      )}
    </Tile>
  );
}

/** Connected inboxes by provider, in the supporting strip of four views. */
function ProvidersTile({
  providers,
}: {
  providers: { ok: boolean; data?: { provider: string; inboxes: number }[]; error?: string };
}) {
  if (!providers.ok || !providers.data) {
    return <TileError label="Connected inboxes" message={providers.error ?? 'unavailable'} span={3} className="kiosk-strip" />;
  }
  return (
    <Tile
      label="Connected inboxes"
      aside={`${sumBy(providers.data, (row) => row.inboxes)} live`}
      span={3}
      className="kiosk-strip"
    >
      <BarList
        rows={providers.data
          .slice()
          .sort((a, b) => b.inboxes - a.inboxes)
          .slice(0, 5)
          .map((row) => ({ name: prettyProvider(row.provider), count: row.inboxes }))}
        emptyLabel="No inboxes connected"
      />
    </Tile>
  );
}

/**
 * The Gmail cap tile.
 *
 * Its tone is driven by TIME rather than by the bar: Google verification plus
 * the CASA assessment take weeks, and the cap does not pause while they run, so
 * the level turns red when the runway gets shorter than the process, not when
 * the meter looks full. That is why this tile can be red at a little over half.
 * The aside says what to do about it, because a warning nobody can act on is
 * just a colour.
 */
function GmailTile({ summary }: { summary: GmailCapSummaryRow }) {
  const projection = gmailCapProjection(summary);
  const full = projection.projectedExhaustion
    ? MONTH_LABEL.format(new Date(`${projection.projectedExhaustion}-01T00:00:00Z`))
    : 'No growth';
  return (
    <Tile
      label="Gmail OAuth headroom"
      aside={projection.level === 'ok' ? `${projection.remaining} left` : `start verification`}
      span={3}
      className="kiosk-strip"
      tone={projection.level === 'ok' ? 'default' : projection.level === 'warn' ? 'warn' : 'bad'}
    >
      <Gauge value={projection.used} max={GMAIL_OAUTH_USER_CAP} unit="grants" />
      <FactRow
        facts={[
          { label: 'Slots left', value: projection.remaining },
          { label: 'Per month', value: projection.ratePerMonth.toFixed(1) },
          { label: 'Full by', value: full },
        ]}
      />
    </Tile>
  );
}

const MONTH_LABEL = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/* ---------------------------------------------------------------- helpers */

function stageOf(funnel: { stage: string; workspaces: number }[], name: string): number {
  return funnel.find((row) => row.stage === name)?.workspaces ?? 0;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Workspaces that came back at least once.
 *
 * The engagement RPC buckets by active days as '1', '2–3', '4–7', '8+', so
 * everything except the first band is a workspace that returned on a different
 * day. Matching on "not 1" rather than listing the other three keeps this
 * correct if a band is ever added.
 */
function returningWorkspaces(rows: { metric: string; band: string; workspaces: number }[]): number {
  return rows
    .filter((row) => row.metric === 'active_days' && row.band !== '1')
    .reduce((total, row) => total + row.workspaces, 0);
}

/**
 * The milestone ladder, ending at the step that is actually in play.
 *
 * The last three rungs come from outside the activation funnel on purpose: the
 * funnel stops at first value, and the interesting question now is what happens
 * after it.
 *
 * WHY "HIT A PLAN LIMIT" IS GONE. It was the right rung when actions were the
 * value metric. Since the 2026-08-19 repricing the paywall is the inbox count
 * and the action ceiling is a silent abuse guard nobody is meant to reach, so
 * the rung was a permanent zero measuring a paywall that no longer exists. The
 * two rungs that replace it measure the paywall that does.
 *
 * THE ABANDONMENT NOTE IS THE POINT OF THE PANEL. Everything above it is about
 * getting people to want the product. The gap between "started a checkout" and
 * "paid" is the only step where someone had already decided to pay and we lost
 * them anyway, and it is the only number here that can be fixed in an
 * afternoon.
 *
 * TWO SEAMS, both marked in the notes rather than hidden. The first three rungs
 * come from the activation RPC and count WORKSPACES including our own; the
 * pricing and checkout rungs are filtered in Node and exclude ours. Our
 * accounts are roughly a twentieth of signups, so the ladder still reads true;
 * the cleaner fix is to teach `growth_activation_funnel` the same exclusion.
 * The second seam is the window: the pricing and checkout rungs are all-time,
 * "came back" is the rolling 28 days.
 */
function milestoneSteps(
  funnel: { stage: string; workspaces: number }[],
  retention: { returning: number; oneAndDone: number | null },
  checkout: CheckoutFunnel | null,
  mrr: RevenueSummary | null,
) {
  const { returning, oneAndDone } = retention;
  const paid = checkout?.checkoutCompleted ?? 0;
  const stillPaying = mrr?.payingCustomers ?? 0;
  return [
    // "Created a workspace", not "Signed up", and the aside says "workspaces".
    // The headline tile three columns to the left says "Signed up 315" and this
    // rung says 308, because they count different things: that one counts
    // external PEOPLE and this one counts WORKSPACES including our own. Both
    // are right and the difference is small, which is precisely what makes it
    // dangerous on a wall — two numbers under the same word, four tiles apart,
    // that never quite agree. Naming the unit is cheaper than reconciling them,
    // and reconciling them properly means teaching growth_activation_funnel the
    // internal exclusion, which is a change to a shared RPC that /admin/growth
    // also reads.
    { label: 'Created a workspace', value: stageOf(funnel, 'signup') },
    { label: 'Connected an inbox', value: stageOf(funnel, 'inbox_connected') },
    { label: 'Used their mailbox', value: stageOf(funnel, 'value_activation') },
    {
      label: 'Came back',
      value: returning,
      note: returning === 0
        ? 'nobody yet'
        : oneAndDone === null
          ? `2+ days, last ${KIOSK_WINDOW_DAYS}d`
          : `2+ days; ${oneAndDone} tried once and left`,
    },
    {
      label: 'Looked at the plans',
      value: checkout?.pricingViewed ?? 0,
      note: checkout ? 'signed in, ever' : 'unavailable',
    },
    {
      label: 'Started a checkout',
      value: checkout?.checkoutStarted ?? 0,
      note: !checkout
        ? 'unavailable'
        : checkout.abandoned > 0
          ? `${checkout.abandoned} left without paying`
          : 'none abandoned',
    },
    {
      label: 'Paid',
      value: paid,
      note: paid === 0
        ? 'the first one is still out there'
        // Ever-paid against still-paying: with the counts this small, one
        // cancellation is the whole retention story and hiding it behind a
        // single number would be the flattering choice.
        : stillPaying === paid ? 'all still paying' : `${stillPaying} still paying`,
    },
  ];
}

/**
 * The checkout ladder on its own, for the Money view.
 *
 * Shares no code with `milestoneSteps` because it deliberately starts later:
 * everything before "looked at the plans" is a product question and this panel
 * is about the four steps after somebody has started thinking about paying.
 */
function checkoutSteps(funnel: CheckoutFunnel, mrr: RevenueSummary | null) {
  const stillPaying = mrr?.payingCustomers ?? 0;
  return [
    { label: 'Looked at the plans', value: funnel.pricingViewed, note: 'signed in, ever' },
    {
      label: 'Started a checkout',
      value: funnel.checkoutStarted,
      note: funnel.checkoutFailed > 0 ? `${funnel.checkoutFailed} could not start` : 'ever',
    },
    {
      label: 'Abandoned on Stripe',
      value: funnel.abandoned,
      // Reached is forced false: this rung is the LOSS, and the funnel paints a
      // reached rung in the accent colour, which would make the board's worst
      // number its most confident-looking one.
      reached: false,
      note: funnel.abandoned > 0 ? 'had already decided to pay' : 'nobody',
    },
    {
      label: 'Paid',
      value: funnel.checkoutCompleted,
      note: funnel.checkoutCompleted === 0
        ? 'the first one is still out there'
        : stillPaying === funnel.checkoutCompleted ? 'all still paying' : `${stillPaying} still paying`,
    },
    {
      label: 'Opened the billing portal',
      value: funnel.portalOpened,
      note: 'existing subscribers',
    },
  ];
}

/**
 * The tone and the aside of the money tile.
 *
 * Ordered by what someone should do about it: a card that is failing outranks a
 * subscription winding down, which outranks the fact that the headline counts
 * one currency, which outranks the annual figure.
 *
 * Every branch is kept to two or three words. The aside is `white-space:
 * nowrap` in a tile three of twelve columns wide, so a longer phrase does not
 * wrap, it eats the label: "Recurring revenue" becomes "Recurring rev...".
 */
function revenueTone(mrr: RevenueSummary): 'good' | 'warn' | 'bad' | 'goal' {
  if (mrr.atRiskCustomers > 0) return 'bad';
  if (mrr.leavingCustomers > 0) return 'warn';
  return mrr.mrrMinor > 0 ? 'good' : 'goal';
}

function revenueAside(mrr: RevenueSummary): string {
  if (mrr.atRiskCustomers > 0) return `${mrr.atRiskCustomers} failing`;
  if (mrr.leavingCustomers > 0) return `${mrr.leavingCustomers} leaving`;
  if (mrr.otherCurrencies.length > 0) {
    return `plus ${mrr.otherCurrencies.map((code) => code.toUpperCase()).join('/')}`;
  }
  return mrr.mrrMinor > 0 ? `${formatMoney(mrr.arrMinor, mrr.currency)}/yr` : 'nobody yet';
}

/**
 * One line under the money.
 *
 * Zero revenue gets the milestone framing and the size of the pool still to
 * convert, because "$0" on its own says nothing about whether that is a
 * problem. Any revenue at all gets what moved in the window, since the fact
 * row underneath now carries the derived figures and repeating ARPA there and
 * here would spend two of the tile's four lines on one number.
 */
function revenueCaption(mrr: RevenueSummary, counts: { free_workspaces: number } | null) {
  if (mrr.payingCustomers === 0) {
    return (
      <>
        Next milestone.{' '}
        {counts ? <><strong>{formatCount(counts.free_workspaces)}</strong> free workspaces to convert</> : 'No paid subscription is live'}
        {mrr.compedCustomers > 0 ? `, ${mrr.compedCustomers} comped` : ''}.
      </>
    );
  }
  return <>{movement(mrr)}</>;
}

/** One line under the money-at-risk headline. */
function riskCaption(mrr: RevenueSummary) {
  if (mrr.atRiskMinor > 0) {
    return <><strong>{formatMoney(mrr.atRiskMinor, mrr.currency)}</strong> on cards Stripe cannot charge right now</>;
  }
  if (mrr.leavingMinor > 0) {
    return <><strong>{formatMoney(mrr.leavingMinor, mrr.currency)}</strong> set to stop at the end of the period</>;
  }
  return <>Every live subscription is paying and none is winding down</>;
}

/**
 * One line under the subscriber count: which tiers those people are on.
 *
 * The tier mix is the whole reason a count is worth wall space beside the
 * money. Two subscribers on Personal and two on Team are the same headline here
 * and a six times difference in what the business is; the plan labels are the
 * only thing on the board that tells them apart.
 *
 * Capped at three plans. There are four tiers and the caption is two lines of
 * clamped text in a tile three of twelve columns wide, so a fourth would push
 * the first out of view rather than appear beneath it.
 */
function subscriberCaption(mrr: RevenueSummary, counts: { free_workspaces: number } | null) {
  if (mrr.payingCustomers === 0) {
    return counts
      ? <>Nobody yet. <strong>{formatCount(counts.free_workspaces)}</strong> free workspaces to convert.</>
      : <>Nobody is on a paid plan yet.</>;
  }
  const mix = mrr.byPlan
    .slice(0, 3)
    .map((plan) => `${plan.label} ${formatCount(plan.customers)}`)
    .join(', ');
  return (
    <>
      {mix || 'Plan unknown'}
      {mrr.compedCustomers > 0 ? `, plus ${mrr.compedCustomers} comped` : ''}.
    </>
  );
}

/** What arrived and what left inside the window, in words rather than a delta. */
function movement(mrr: RevenueSummary): string {
  const gained = formatMoney(mrr.newMrrMinor, mrr.currency);
  const lost = formatMoney(mrr.churnedMrrMinor, mrr.currency);
  if (mrr.newCustomers > 0 && mrr.churnedCustomers > 0) {
    return `${gained} won and ${lost} lost in ${KIOSK_WINDOW_DAYS}d.`;
  }
  if (mrr.newCustomers > 0) return `${gained} of it arrived in the last ${KIOSK_WINDOW_DAYS}d.`;
  if (mrr.churnedCustomers > 0) return `${lost} lost in the last ${KIOSK_WINDOW_DAYS}d.`;
  return `Unchanged for ${KIOSK_WINDOW_DAYS} days.`;
}

/**
 * The outage log's aside.
 *
 * "0 open" is not the same sentence as "all resolved" even though it is the
 * same fact: a number beside a red word reads as a count of something bad, and
 * this tile's happy state should not be the one that looks like a tally.
 */
function incidentAside(incidents: MonitorIncident[]): string {
  if (incidents.length === 0) return 'never';
  const open = incidents.filter((row) => row.status === 'open').length;
  return open === 0 ? 'all resolved' : `${open} open`;
}

/** Whole days since an ISO timestamp, phrased for a wall. */
function daysAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return 'just now';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
