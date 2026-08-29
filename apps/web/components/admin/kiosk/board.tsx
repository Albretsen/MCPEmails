/**
 * The kiosk board: one screen of numbers, refreshed on a timer, read from
 * across a room.
 *
 * WHY IT IS ONE COMPONENT rather than a Suspense boundary per section like
 * /admin/growth. That page is opened by a person who is waiting for it, so
 * streaming each panel as its query lands is the right trade. This one is
 * unattended: nobody is watching the moment it loads, and a board that paints
 * in nine stages every five minutes is a board that spends its life visibly
 * reassembling itself. One `Promise.all`, one paint, and the previous frame
 * stays on screen until the new one is complete.
 *
 * WHAT IS DELIBERATELY MISSING: the Active accounts roster. It is the only
 * part of /admin/growth that names workspaces and owner email addresses, and
 * this screen hangs on a wall where anyone in the room can read it, reachable
 * with a shared token rather than an operator login. Everything here is an
 * aggregate.
 *
 * WHAT IT IS FOR: the honest state of the business at a glance, framed so that
 * the answer to "how are we doing" is a direction rather than a verdict. Hence
 * the milestone funnel: with zero paying customers, a board that only reported
 * revenue would say the same thing every day forever, and would be ignored
 * within a week. The funnel shows the step actually in play.
 */

import {
  fetchActivationFunnel,
  fetchDailyMetrics,
  fetchEngagementBands,
  fetchGmailCapSummary,
  fetchLifecycleCounts,
  fetchProviderMix,
  fetchRevenueCounts,
  fetchUsageVolume,
  gmailCapProjection,
} from '@/lib/analytics/growth-queries';
import { GMAIL_OAUTH_USER_CAP } from '@/lib/analytics/growth-types';
import type { GmailCapSummaryRow, GrowthDailyRow } from '@/lib/analytics/growth-types';
import { fetchCheckoutFunnel, fetchRecurringRevenue } from '@/lib/analytics/kiosk-revenue';
import type { CheckoutFunnel } from '@/lib/analytics/kiosk-revenue';
import type { RevenueSummary } from '@/lib/analytics/revenue-math';
import { NO_DATA, formatCount, formatMoney, formatPercent, ratio } from '../charts';
import {
  BarList,
  BigNumber,
  FactRow,
  FunnelSteps,
  Gauge,
  GroupedColumns,
  Tile,
  TileError,
  type Trend,
} from './primitives';

/** The board's reporting window. Fixed: a wall display has no controls. */
export const KIOSK_WINDOW_DAYS = 28;

/** Weeks of history in the trend chart. Eight fits the tile and one quarter. */
const CHART_WEEKS = 8;

/**
 * Days of daily history to pull. Ninety is the ceiling: a pg_cron job deletes
 * `activity_log` rows past 90 days, so asking for more would return real
 * workspace counts beside zeroed activity and every delta computed against
 * that stretch would be an invention.
 */
const DAILY_DAYS = 90;

/**
 * Window for the milestone funnel. It reads `workspaces.created_at` and the
 * durable `onboarding_*_at` columns rather than `activity_log`, so the 90 day
 * purge does not apply and a wide window really does mean all-time. That is
 * what this panel wants: the road to a first paying customer is a story about
 * everyone who has ever signed up, not about the last four weeks.
 */
const FUNNEL_DAYS = 400;

export async function KioskBoard() {
  const days = KIOSK_WINDOW_DAYS;

  const [daily, lifecycle, revenue, funnel, bands, gmail, providers, usage, recurring, checkout] =
    await Promise.all([
      fetchDailyMetrics(DAILY_DAYS),
      fetchLifecycleCounts(),
      fetchRevenueCounts(),
      fetchActivationFunnel(FUNNEL_DAYS),
      fetchEngagementBands(days),
      fetchGmailCapSummary(),
      fetchProviderMix(),
      fetchUsageVolume(days),
      fetchRecurringRevenue(days),
      fetchCheckoutFunnel(),
    ]);

  const rows = daily.ok ? daily.data : [];
  const current = rows.slice(-days);
  const previous = rows.slice(-days * 2, -days);
  // Only compare against a full prior period. A partial one makes every
  // percentage on the board an understatement dressed up as a decline.
  const comparable = previous.length === days;
  const latest = rows.at(-1);
  const priorSameDay = rows.at(-1 - days);

  const life = lifecycle.ok ? lifecycle.data : null;
  const money = revenue.ok ? revenue.data : null;
  const volume = usage.ok ? usage.data : null;
  const mrr = recurring.ok ? recurring.data : null;

  const activeNow = life?.active_28d ?? latest?.active_28d ?? 0;
  const returning = returningWorkspaces(bands.ok ? bands.data : []);
  const oneAndDone = life?.one_and_done ?? null;

  const newThisWindow = sum(current, 'new_workspaces');
  const activationsThisWindow = sum(current, 'value_activations');

  const calls = sum(current, 'calls');
  const successes = sum(current, 'successes');
  const errors = sum(current, 'errors');

  return (
    <>
      {/* ---- Row 2: the four numbers the business turns on ---- */}

      <Tile label="Active workspaces" aside={`${days}d`} span={3}>
        {daily.ok ? (
          <BigNumber
            value={activeNow}
            trend={trend(activeNow, priorSameDay && comparable ? priorSameDay.active_28d : null, 'up')}
            caption={<><strong>{latest?.active_7d ?? 0}</strong> active in the last 7 days</>}
            spark={rows.slice(-30).map((row) => row.active_28d)}
          />
        ) : (
          <p className="kiosk-error"><strong>No data</strong><span>{daily.error}</span></p>
        )}
      </Tile>

      {/* Retention, stated as a count rather than a rate. "22% retained" over a
          denominator this small swings by ten points when one person opens
          their laptop; "12 came back" does not, and it is the number anyone
          actually wants when they glance at the wall. */}
      <Tile label="Came back" aside={`${days}d`} span={3} tone={returning > 0 ? 'good' : 'default'}>
        <BigNumber
          value={returning}
          trend={null}
          caption={
            oneAndDone === null
              ? <>Workspaces active on <strong>2 or more</strong> days</>
              : <>Active on <strong>2 or more</strong> days. {oneAndDone} tried once and left.</>
          }
        />
      </Tile>

      <Tile label="Value activations" aside={`${days}d`} span={3}>
        {daily.ok ? (
          <BigNumber
            value={activationsThisWindow}
            trend={trend(activationsThisWindow, comparable ? sum(previous, 'value_activations') : null, 'up')}
            caption={<><strong>{newThisWindow}</strong> signed up, {ratio(activationsThisWindow, newThisWindow)} reached a mailbox</>}
            spark={rows.slice(-30).map((row) => row.value_activations)}
            sparkColor="var(--kiosk-good)"
          />
        ) : (
          <p className="kiosk-error"><strong>No data</strong><span>{daily.error}</span></p>
        )}
      </Tile>

      {/* THE MONEY TILE. It replaced a plain count of paying customers on
          2026-08-29, the day the count stopped being zero, because a count
          cannot tell a $5 month from a $79 one and the whole point of the
          repricing was that those are different outcomes.

          PRICED FROM STRIPE, NOT FROM OUR PRICE TABLE. A comped account is a
          live subscription carrying a 100% off coupon, so priced from `plan`
          it reads as full revenue and priced from Stripe it correctly reads as
          nothing. Yearly is divided by twelve rather than booked in the month
          it lands: our first sale was a year up front, and showing $43 of MRR
          would report thirty times the truth and then appear to lose it all
          the month after. See revenue-math.ts.

          THE ASIDE IS A TRIAGE SLOT, not a label. A failing card and a
          subscription already set to stop are the two things worth walking
          over for, and they say so there in priority order; when neither is
          true it falls back to the annual figure. Payments that are failing
          stay IN the MRR figure, because the app still entitles them through
          dunning and dropping them on the first bounce would paint a collapse
          that has not happened.

          A FAILED READ IS NOT A ZERO. Every other tile here renders TileError
          when its query fails; the tile this replaced used to fall back to
          `?? 0` and print a confident nought under a "Paying customers" label.
          That is the single worst thing this board can display: it is the
          number someone walks past to check, zero is a plausible value for it,
          and nothing distinguished "nobody has paid" from "the query did not
          answer". Stripe being down must read as Stripe being down. */}
      {recurring.ok && mrr ? (
        <Tile
          label="Recurring revenue"
          aside={revenueAside(mrr)}
          span={3}
          tone={revenueTone(mrr)}
        >
          <BigNumber
            value={formatMoney(mrr.mrrMinor, mrr.currency)}
            suffix="/mo"
            // The prior period is derived, not stored: today's MRR less what
            // arrived and left inside the window. That is exact while nobody
            // has upgraded or downgraded, which is true today and is noted in
            // revenue-math.ts as the thing to revisit once it is not.
            trend={mrr.netNewMrrMinor === 0 ? null : trend(mrr.mrrMinor, mrr.mrrMinor - mrr.netNewMrrMinor, 'up')}
            caption={revenueCaption(mrr, money)}
          />
        </Tile>
      ) : (
        <TileError
          label="Recurring revenue"
          message={recurring.ok ? 'Stripe returned no subscriptions.' : recurring.error}
          span={3}
        />
      )}

      {/* ---- Row 3: the two panels worth standing still for ---- */}

      {daily.ok ? (
        <Tile label="Signups and activations" aside={`last ${CHART_WEEKS} weeks`} span={7}>
          <GroupedColumns
            buckets={weeklyBuckets(rows, CHART_WEEKS)}
            series={[
              { name: 'Signed up', color: 'var(--kiosk-accent)' },
              { name: 'Reached a mailbox', color: 'var(--kiosk-good)' },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Signups and activations" message={daily.error} span={7} />
      )}

      {funnel.ok ? (
        <Tile label="Road to a paying customer" aside="every signup, ever" span={5}>
          <FunnelSteps steps={milestoneSteps(funnel.data, returning, checkout.ok ? checkout.data : null, mrr)} />
        </Tile>
      ) : (
        <TileError label="Road to a paying customer" message={funnel.error} span={5} />
      )}

      {/* ---- Row 4: the supporting strip ---- */}

      {gmail.ok ? (
        <GmailTile summary={gmail.data} />
      ) : (
        <TileError label="Gmail OAuth headroom" message={gmail.error} span={3} className="kiosk-strip" />
      )}

      <Tile
        label="Reliability"
        aside={`${days}d`}
        span={3}
        className="kiosk-strip"
        tone={calls > 0 && successes / calls < 0.95 ? 'warn' : 'default'}
      >
        <BigNumber
          value={calls > 0 ? formatPercent(successes / calls, 1) : NO_DATA}
          caption={<>{formatCount(errors)} failed of {formatCount(calls)} calls</>}
        />
      </Tile>

      <Tile label="Work done for customers" aside={`${days}d`} span={3} className="kiosk-strip">
        <BigNumber
          value={volume?.billable_actions ?? (usage.ok ? 0 : NO_DATA)}
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

      {providers.ok ? (
        <Tile label="Connected inboxes" aside={`${sumBy(providers.data, (row) => row.inboxes)} live`} span={3} className="kiosk-strip">
          <BarList
            rows={providers.data
              .slice()
              .sort((a, b) => b.inboxes - a.inboxes)
              .slice(0, 5)
              .map((row) => ({ name: prettyProvider(row.provider), count: row.inboxes }))}
            emptyLabel="No inboxes connected"
          />
        </Tile>
      ) : (
        <TileError label="Connected inboxes" message={providers.error} span={3} className="kiosk-strip" />
      )}
    </>
  );
}

/**
 * The Gmail cap tile.
 *
 * Split out because its tone is driven by TIME rather than by the bar: Google
 * verification plus the CASA assessment take weeks, and the cap does not pause
 * while they run, so the level turns red when the runway gets shorter than the
 * process, not when the meter looks full. That is why this tile can be red at
 * a little over half. The aside says what to do about it, because a warning
 * nobody can act on is just a colour.
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

function sum(rows: GrowthDailyRow[], key: keyof GrowthDailyRow): number {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

function sumBy<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

/**
 * Percentage change, or nothing. A null previous period and a previous period
 * of zero both mean "no honest comparison exists": dividing by zero would
 * render every first-ever signup as an infinite improvement.
 */
function trend(current: number, previous: number | null | undefined, goodDirection: 'up' | 'down'): Trend {
  if (previous === null || previous === undefined || previous === 0) return null;
  return { percent: ((current - previous) / previous) * 100, goodDirection };
}

/**
 * Workspaces that came back at least once.
 *
 * The engagement RPC buckets by active days as '1', '2–3', '4–7', '8+', so
 * everything except the first band is a workspace that returned on a
 * different day. Matching on "not 1" rather than listing the other three keeps
 * this correct if a band is ever added.
 */
function returningWorkspaces(rows: { metric: string; band: string; workspaces: number }[]): number {
  return rows
    .filter((row) => row.metric === 'active_days' && row.band !== '1')
    .reduce((total, row) => total + row.workspaces, 0);
}

/**
 * Trailing 7-day buckets, oldest first, anchored on the most recent day.
 *
 * Deliberately not calendar weeks. The board is read on whatever day someone
 * walks past it, and a calendar-week chart spends most of its life ending in a
 * partial bar that looks like a collapse.
 */
function weeklyBuckets(rows: GrowthDailyRow[], weeks: number): { label: string; values: number[] }[] {
  const buckets: { label: string; values: number[] }[] = [];
  for (let index = weeks - 1; index >= 0; index -= 1) {
    const end = rows.length - index * 7;
    const slice = rows.slice(Math.max(0, end - 7), end);
    if (slice.length === 0) continue;
    buckets.push({
      label: index === 0 ? 'This week' : `${index}w ago`,
      values: [sum(slice, 'new_workspaces'), sum(slice, 'value_activations')],
    });
  }
  return buckets;
}

/**
 * The milestone ladder, ending at the step that is actually in play.
 *
 * The last three rungs come from outside the activation funnel on purpose: the
 * funnel stops at first value, and the interesting question now is what
 * happens after it.
 *
 * WHY "HIT A PLAN LIMIT" IS GONE. It was the right rung when actions were the
 * value metric. Since the 2026-08-19 repricing the paywall is the inbox count,
 * the action ceiling is a silent abuse guard nobody is meant to reach, and
 * `paywall_reached` has never once fired, so the rung was a permanent zero
 * measuring a paywall that no longer exists. The two rungs that replace it
 * measure the paywall that does: looking at the plans, and getting as far as
 * Stripe's checkout page.
 *
 * THE ABANDONMENT NOTE IS THE POINT OF THE PANEL. Everything above it is
 * about getting people to want the product. The gap between "started a
 * checkout" and "paid" is the only step where someone had already decided to
 * pay and we lost them anyway, and it is the only number here that can be
 * fixed in an afternoon.
 *
 * TWO SEAMS TO KNOW ABOUT, both marked in the notes rather than hidden. The
 * first three rungs come from the activation RPC and count every workspace
 * including our own; the pricing and checkout rungs are filtered in Node and
 * exclude ours, because the owner's dashboard visits and live test purchases
 * are a large share of every billing event ever recorded and left in they
 * would turn the pricing rung into a measure of our own browsing. Our accounts
 * are roughly a twentieth of signups, so the ladder still reads true; the
 * cleaner fix is to teach `growth_activation_funnel` the same exclusion.
 *
 * The second seam is the window: the pricing and checkout rungs are all-time,
 * "came back" is the rolling 28 days. Mixing windows in a funnel is
 * defensible, doing it without saying which rung changed measure is not.
 */
function milestoneSteps(
  funnel: { stage: string; workspaces: number }[],
  returning: number,
  checkout: CheckoutFunnel | null,
  mrr: RevenueSummary | null,
) {
  const stage = (name: string) => funnel.find((row) => row.stage === name)?.workspaces ?? 0;
  const paid = checkout?.checkoutCompleted ?? 0;
  const stillPaying = mrr?.payingCustomers ?? 0;
  return [
    { label: 'Signed up', value: stage('signup') },
    { label: 'Connected an inbox', value: stage('inbox_connected') },
    { label: 'Used their mailbox', value: stage('value_activation') },
    {
      label: 'Came back',
      value: returning,
      note: returning === 0 ? 'nobody yet' : `2+ days, last ${KIOSK_WINDOW_DAYS}d`,
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
 * The tone and the aside of the money tile.
 *
 * Ordered by what someone should do about it: a card that is failing outranks
 * a subscription winding down, which outranks the fact that the headline is
 * only counting one currency, which outranks the annual figure.
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
  if (mrr.atRiskCustomers > 0) {
    return `${mrr.atRiskCustomers} failing`;
  }
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
 * problem. Any revenue at all gets the customer count, the average, and what
 * moved in the window, since the average is the number that says whether the
 * repricing is landing on the tiers it was aimed at.
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
  return (
    <>
      <strong>{formatCount(mrr.payingCustomers)}</strong> paying,{' '}
      {formatMoney(mrr.arpaMinor, mrr.currency)} each. {movement(mrr)}
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

/** Provider ids as a person would say them. */
const PROVIDER_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  google: 'Gmail',
  outlook: 'Outlook',
  microsoft: 'Outlook',
  imap: 'IMAP',
  fastmail: 'Fastmail',
  icloud: 'iCloud',
  yandex: 'Yandex',
};

function prettyProvider(provider: string): string {
  const key = provider.toLowerCase();
  return PROVIDER_LABELS[key] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}
