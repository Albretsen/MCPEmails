/**
 * The four panels behind the capacity strip: which mailboxes people bring,
 * how much room Google leaves us to keep taking them, who the inbox paywall
 * is actually standing in front of, and how much work the product did.
 *
 * The pattern is written out in full at the top of audience.tsx and is
 * followed here without variation: one `Promise.all` per panel, a `TileError`
 * rather than a zero whenever a query does not answer, the window clamped
 * where the data is clamped, and aggregates only.
 *
 * WHAT IS DIFFERENT ABOUT THIS FILE: three of these four panels have no window
 * at all. A provider mix, a cumulative OAuth grant count and an inbox ceiling
 * are facts about right now, not about the last 28 days, and the board's
 * window switch sits directly above them. Printing "last 28 days" over a
 * current-state count would be a lie that the control above makes look
 * deliberate, so each of those panels says in words that the switch changes
 * nothing on it, and only UsageDetail is windowed.
 *
 * THE TWO BUSINESS RULES THAT DECIDE HOW THESE READ:
 *
 *  1. The inbox cap only exists for accounts created after the 2026-08-19
 *     repricing. Everybody who signed up before it keeps unlimited inboxes,
 *     free, permanently (migration 20260819170500). Those workspaces are
 *     reported apart from the capped ones everywhere below, never summed with
 *     them: a conversion rate measured over a population that was never asked
 *     for money is not a conversion rate.
 *  2. The Gmail number is a DEADLINE, not demand. Google caps a published but
 *     unverified OAuth client with restricted Gmail scopes at 100 users, the
 *     count is cumulative, and verification plus the CASA assessment takes
 *     weeks that do not start until somebody notices. So the cap panel is a
 *     countdown to a date, and reading it as "Gmail is popular" gets the sign
 *     of the whole thing backwards.
 */

import {
  fetchDailyMetrics,
  fetchGmailCapSummary,
  fetchGmailGrantSeries,
  fetchInboxDistribution,
  fetchOAuthAbandonment,
  fetchProviderFunnel,
  fetchProviderMix,
  fetchUpgradePressure,
  fetchUsageVolume,
  fetchUtilizationBands,
  gmailCapProjection,
} from '@/lib/analytics/growth-queries';
import { GMAIL_OAUTH_USER_CAP } from '@/lib/analytics/growth-types';
import { NO_DATA, formatCount, ratio } from '../../charts';
import {
  BarList,
  BigNumber,
  FactRow,
  FunnelSteps,
  Gauge,
  GroupedColumns,
  SplitList,
  Tile,
  TileError,
} from '../primitives';
import { CHART_WEEKS, FUNNEL_DAYS, calendarWeekBuckets, prettyProvider, sumBy } from '../shared';
import { activityDays, isActivityCapped, windowShort } from '../windows';
import type { KioskDetailProps } from './registry';

/* ------------------------------------------------------------- formatters */

/** Column labels on the grant chart: "Aug 26" fits under a bar, "August 2026" does not. */
const MONTH_COLUMN = new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
/** The projected exhaustion month, read as a date rather than as a bar label. */
const MONTH_FULL = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const DAY_LABEL = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * A month key ('YYYY-MM' from the projection, 'YYYY-MM-DD' from the series)
 * as a label. Anything unparseable renders as the empty marker rather than as
 * "Invalid Date", which is the one string on a wall panel that tells a passer
 * by nothing except that something is broken.
 */
function monthLabel(value: string | null | undefined, formatter: Intl.DateTimeFormat): string {
  if (!value) return NO_DATA;
  const date = new Date(`${value.slice(0, 7)}-01T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? NO_DATA : formatter.format(date);
}

/** A timestamp as a short day, or null when there is no honest date to print. */
function dayLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : DAY_LABEL.format(date);
}

/* ---------------------------------------------------------------- providers */

/**
 * The panel behind "Connected inboxes".
 *
 * The tile is a ranked list of providers, which answers "which is biggest" and
 * nothing else. Standing at the glass the question is the next one: of the
 * people who TRIED to bring that provider, how many got in, and where do the
 * rest die. That needs three sources, because the drop-off is spread across
 * three places in the schema: the live inbox rows, the connection events, and
 * the consent screens that never came back at all.
 *
 * The connect funnel is asked for `FUNNEL_DAYS` rather than the board window.
 * `product_funnel_events` is not touched by the 90 day activity purge, and at
 * a few dozen connect attempts a month a 7 or 28 day slice of it would be
 * mostly zeroes, which reads as "nobody is connecting" rather than "this
 * window is too short to say".
 */
export async function ProvidersDetail({ days }: KioskDetailProps) {
  const [mix, funnel, abandonment] = await Promise.all([
    fetchProviderMix(),
    fetchProviderFunnel(FUNNEL_DAYS),
    fetchOAuthAbandonment(),
  ]);

  const liveInboxes = mix.ok ? sumBy(mix.data, (row) => row.inboxes) : 0;
  const attempts = funnel.ok ? sumBy(funnel.data, (row) => row.attempts) : 0;
  const successes = funnel.ok ? sumBy(funnel.data, (row) => row.successes) : 0;
  const failures = funnel.ok ? sumBy(funnel.data, (row) => row.failures) : 0;
  const connected = funnel.ok ? sumBy(funnel.data, (row) => row.workspaces_connected) : 0;

  return (
    <>
      {mix.ok ? (
        <Tile label="Live inboxes by provider" aside={`${formatCount(liveInboxes)} live`} span={4}>
          <BigNumber
            value={liveInboxes}
            caption={
              <>
                across <strong>{formatCount(mix.data.length)}</strong> providers
              </>
            }
          />
          <BarList
            rows={mix.data
              .slice()
              .sort((a, b) => b.inboxes - a.inboxes)
              .map((row) => ({ name: prettyProvider(row.provider), count: row.inboxes }))}
            emptyLabel="No inbox is connected"
          />
        </Tile>
      ) : (
        <TileError label="Live inboxes by provider" message={mix.error} span={4} />
      )}

      {/* WORKSPACES, not attempts, in the first three columns. One determined
          person retrying eight times is not eight people, and the drop-off is
          only honest when it is read off the deduplicated counts. The failure
          category is printed verbatim as the server wrote it, so a cause on
          the wall can be grepped for in the logs without a translation step. */}
      {funnel.ok ? (
        <Tile label="Getting connected, by provider" aside="all time" span={8}>
          {funnel.data.length === 0 ? (
            <p className="kiosk-empty">No connection attempt has been recorded.</p>
          ) : (
            <table className="kiosk-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th className="is-num">Tried</th>
                  <th className="is-num">Connected</th>
                  <th className="is-num">Got in</th>
                  <th className="is-num">Failed tries</th>
                  <th>Usual cause</th>
                </tr>
              </thead>
              <tbody>
                {funnel.data.map((row) => (
                  <tr key={row.provider}>
                    <td>{prettyProvider(row.provider)}</td>
                    <td className="is-num">{formatCount(row.workspaces_attempted)}</td>
                    <td className="is-num">{formatCount(row.workspaces_connected)}</td>
                    <td className="is-num">{ratio(row.workspaces_connected, row.workspaces_attempted)}</td>
                    <td className="is-num">{formatCount(row.failures)}</td>
                    <td>{row.top_error ?? NO_DATA}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Tile>
      ) : (
        <TileError label="Getting connected, by provider" message={funnel.error} span={8} />
      )}

      {/* The one loss that leaves no funnel row at all: a consent screen that
          was opened and never came back writes nothing except a surviving
          `oauth_states` row, so it has to be counted from the leak itself.
          OAuth providers only, which is why IMAP and Fastmail are absent here
          rather than sitting at a meaningless zero. */}
      {abandonment.ok ? (
        <Tile label="Consent screens never finished" aside="all time" span={6}>
          {abandonment.data.length === 0 ? (
            <p className="kiosk-empty">No consent screen has been opened.</p>
          ) : (
            <table className="kiosk-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th className="is-num">Walked away</th>
                  <th className="is-num">Ever connected</th>
                  <th className="is-num">Lost there</th>
                </tr>
              </thead>
              <tbody>
                {abandonment.data.map((row) => (
                  <tr key={row.provider}>
                    <td>{prettyProvider(row.provider)}</td>
                    <td className="is-num">{formatCount(row.abandoned)}</td>
                    <td className="is-num">{formatCount(row.connected)}</td>
                    <td className="is-num">{ratio(row.abandoned, row.abandoned + row.connected)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Tile>
      ) : (
        <TileError label="Consent screens never finished" message={abandonment.error} span={6} />
      )}

      {/* RAW attempts here, deliberately, where the tile above counts people.
          This is the only place the retry cost shows up: a provider that works
          on the third go looks identical to one that works first time in every
          workspace-level count, and it is the difference between a connect
          flow that is fine and one that is quietly awful. */}
      {funnel.ok ? (
        <Tile label="What a connection costs" aside="all time" span={6}>
          <BigNumber
            value={ratio(successes, attempts)}
            caption={
              <>
                of <strong>{formatCount(attempts)}</strong> connect attempts worked
              </>
            }
          />
          <FactRow
            facts={[
              { label: 'Failed tries', value: failures },
              { label: 'Workspaces in', value: connected },
              {
                label: 'Tries per workspace',
                value: connected > 0 ? (attempts / connected).toFixed(1) : NO_DATA,
              },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="What a connection costs" message={funnel.error} span={6} />
      )}

      <p className="kiosk-detail-note">
        The window switch above ({windowShort(days)}) changes nothing on this panel: the mix is what is
        connected right now and the attempt counts are all time. Live inboxes counts ACTIVE connections
        only, so a mailbox whose credentials have broken is missing here while still occupying a slot
        against the inbox cap. The first three columns of the funnel count workspaces, not people and
        not attempts. Consent abandonment is inferred from state rows that were never cleaned up, which
        makes it a floor: a consent that failed for a reason we DO record shows up in the table above as a
        failure instead.
      </p>
    </>
  );
}

/* -------------------------------------------------------------- gmail cap */

/**
 * The panel behind "Gmail OAuth headroom".
 *
 * Read this as a calendar, not as a meter. The cap is 100 grants on an
 * unverified client, the count only ever goes up (revoking access or deleting
 * an inbox does not hand a slot back), and lifting it means Google
 * verification plus a CASA assessment that takes weeks. So the number that
 * decides what to do is the projected exhaustion MONTH, not the percentage:
 * a bar at 55% with four months of runway is a worse position than a fuller
 * bar that is not moving, and the tone follows the runway for that reason.
 */
export async function GmailCapDetail({ days }: KioskDetailProps) {
  const [summary, series] = await Promise.all([fetchGmailCapSummary(), fetchGmailGrantSeries()]);

  const projection = summary.ok ? gmailCapProjection(summary.data) : null;
  const tone = projection?.level === 'danger' ? 'bad' : projection?.level === 'warn' ? 'warn' : 'default';
  // Months of runway, spelled out rather than left inside the projection: the
  // exhaustion month alone hides the difference between "next month" and
  // "eleven months from now" when both round to the same tidy date.
  const monthsLeft =
    projection && projection.ratePerMonth > 0 ? projection.remaining / projection.ratePerMonth : null;
  const thisMonth = new Date().toISOString().slice(0, 7);

  return (
    <>
      {summary.ok && projection ? (
        <Tile label="Slots spent" aside={`${formatCount(projection.remaining)} left`} span={4} tone={tone}>
          <Gauge value={projection.used} max={GMAIL_OAUTH_USER_CAP} unit="grants" />
          <FactRow
            facts={[
              { label: 'Cap', value: GMAIL_OAUTH_USER_CAP },
              { label: 'Per month', value: projection.ratePerMonth.toFixed(1) },
              { label: 'Full by', value: monthLabel(projection.projectedExhaustion, MONTH_FULL) },
            ]}
          />
        </Tile>
      ) : (
        <TileError
          label="Slots spent"
          message={summary.ok ? 'The cap summary returned no row.' : summary.error}
          span={4}
        />
      )}

      {/* New grants per month, never the cumulative line beside them: the
          running total is two orders of magnitude larger than a month of new
          grants and would flatten every bar it is drawn next to. The total is
          the gauge above; this chart is the rate that the projection uses. The
          current month is drawn hollow and labelled "so far", because a month
          two days old always looks like the wave has stopped. */}
      {series.ok ? (
        <Tile label="New Gmail grants by month" aside="all time" span={8}>
          {series.data.length === 0 ? (
            <p className="kiosk-empty">No Gmail account has ever been connected.</p>
          ) : (
            <GroupedColumns
              buckets={series.data.slice(-CAP_CHART_MONTHS).map((row) => ({
                label: monthLabel(row.month, MONTH_COLUMN),
                values: [row.new_grants],
                partial: row.month.slice(0, 7) === thisMonth,
              }))}
              series={[{ name: 'New Gmail grants', color: 'var(--kiosk-accent)' }]}
            />
          )}
        </Tile>
      ) : (
        <TileError label="New Gmail grants by month" message={series.error} span={8} />
      )}

      {/* What the counters mean, because they are several different numbers for
          one word. Google counts a grant at consent and never uncounts it,
          so the spent figure includes addresses that have since been deleted
          and addresses whose connection is now broken. Only the hand-entered
          Cloud Console figure is authoritative, and it is only as fresh as the
          day somebody last looked. */}
      {summary.ok ? (
        <Tile
          label="What the counter can see"
          aside={
            dayLabel(summary.data.google_reported_at)
              ? `console read ${dayLabel(summary.data.google_reported_at)}`
              : 'console never recorded'
          }
          span={6}
        >
          <SplitList
            rows={[
              { label: 'Distinct addresses ever', count: summary.data.distinct_ever },
              { label: 'Still connected', count: summary.data.live },
              { label: 'Working right now', count: summary.data.active },
            ]}
          />
          <FactRow
            facts={[
              {
                label: 'Google console',
                value: summary.data.google_reported_users === null ? NO_DATA : summary.data.google_reported_users,
              },
              { label: 'Counted against cap', value: projection ? projection.used : NO_DATA },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="What the counter can see" message={summary.error} span={6} />
      )}

      {summary.ok && projection ? (
        <Tile
          label="Runway before verification"
          aside={projection.level === 'ok' ? 'not urgent yet' : 'start verification'}
          span={6}
          tone={tone}
        >
          <BigNumber
            value={monthsLeft === null ? 'No growth' : monthsLeft.toFixed(1)}
            suffix={monthsLeft === null ? undefined : 'months'}
            caption={
              monthsLeft === null ? (
                'Nothing has been granted lately, so there is no rate to project from'
              ) : (
                <>
                  at <strong>{projection.ratePerMonth.toFixed(1)}</strong> grants a month, full by{' '}
                  {monthLabel(projection.projectedExhaustion, MONTH_FULL)}
                </>
              )
            }
          />
          <FactRow
            facts={[
              { label: 'Last 30 days', value: summary.data.grants_last_30d },
              { label: 'Last 60 days', value: summary.data.grants_last_60d },
              { label: 'First grant', value: dayLabel(summary.data.first_grant_at) ?? NO_DATA },
            ]}
          />
        </Tile>
      ) : (
        <TileError
          label="Runway before verification"
          message={summary.ok ? 'The cap summary returned no row.' : summary.error}
          span={6}
        />
      )}

      <p className="kiosk-detail-note">
        The window switch above ({windowShort(days)}) changes nothing here: the cap is cumulative over
        the life of the OAuth client. This is a limit Google puts on an unverified app, not a measure of
        how much people want Gmail, so a rising line is a shortening deadline rather than good news. The
        spent figure is a FLOOR: a consent given to Google that failed before we wrote the inbox row
        still burned a slot we cannot see, which is why the hand-entered Cloud Console figure wins
        whenever it is higher. Deleting an inbox or revoking access never returns a slot. The projection
        assumes the current rate holds, and it says when the cap is reached, not when anyone would
        notice.
      </p>
    </>
  );
}

/** Months of grant history the chart shows. Nine bars stay legible in a tile. */
const CAP_CHART_MONTHS = 9;

/* ----------------------------------------------------------- inbox ceiling */

/**
 * The panel behind "At the inbox ceiling".
 *
 * THE WHOLE PANEL IS A SPLIT, and it is a split because averaging the two
 * halves is a documented way this number has already been read wrongly. Since
 * the 2026-08-19 repricing a new signup gets one free inbox; everybody who
 * existed before it keeps unlimited inboxes free, permanently. So the estate
 * contains a large population the paywall can never reach, and any rate
 * computed over the whole of it is measured against people who were never
 * asked for money. Grandfathered and comped workspaces therefore get their own
 * tile and their own colour in the histogram, and are never folded into the
 * capped counts.
 *
 * `at_ceiling_activated` is the number to act on. A workspace that reached the
 * ceiling without ever performing a mailbox operation is blocked by onboarding,
 * not by price, and prompting it to upgrade would be selling to somebody who
 * has not seen the product work yet.
 */
export async function InboxCeilingDetail({ days }: KioskDetailProps) {
  const [pressure, distribution] = await Promise.all([fetchUpgradePressure(), fetchInboxDistribution()]);

  return (
    <>
      {pressure.ok ? (
        <Tile
          label="At the ceiling now"
          aside={`${formatCount(pressure.data.grandfathered_workspaces)} exempt`}
          span={4}
          tone={pressure.data.at_ceiling_activated > 0 ? 'goal' : 'default'}
        >
          <BigNumber
            value={pressure.data.at_ceiling}
            caption={
              <>
                <strong>{formatCount(pressure.data.at_ceiling_activated)}</strong> of them have used a mailbox
              </>
            }
          />
          <FactRow
            facts={[
              { label: 'Free and capped', value: pressure.data.capped_workspaces },
              { label: 'Of those, activated', value: pressure.data.capped_activated },
              { label: 'Paid', value: pressure.data.paid_workspaces },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="At the ceiling now" message={pressure.error} span={4} />
      )}

      {/* One histogram over three populations that are priced completely
          differently, drawn as three bars per band rather than one stack. The
          capped series is the only one the paywall can move; the exempt series
          is revenue that was given away on purpose and can never be recovered;
          the paid series is the outcome. Merging them is how "almost everybody
          is on Free" came to look like demand rather than a grandfather clause. */}
      {distribution.ok ? (
        <Tile label="Inboxes held, band by band" aside="live workspaces" span={8}>
          {distribution.data.length === 0 ? (
            <p className="kiosk-empty">No live workspace to place in a band.</p>
          ) : (
            <GroupedColumns
              buckets={distribution.data
                .slice()
                .sort((a, b) => a.band_index - b.band_index)
                .map((row) => ({ label: row.band, values: [row.capped, row.exempt, row.paid] }))}
              series={[
                { name: 'Capped (the cap applies)', color: 'var(--kiosk-accent)' },
                { name: 'Exempt (unlimited free)', color: 'var(--kiosk-warn)' },
                { name: 'Paid', color: 'var(--kiosk-good)' },
              ]}
            />
          )}
        </Tile>
      ) : (
        <TileError label="Inboxes held, band by band" message={distribution.error} span={8} />
      )}

      {/* THREE RUNGS, EACH ONE A SUBSET OF THE ONE ABOVE IT. The count of
          capped workspaces that have used a mailbox belongs in a note rather
          than as a rung of its own: it is not a superset of "holding the cap",
          so as a rung it could draw wider than its parent, and a funnel step
          that grows is read as growth rather than as two overlapping sets.
          The last rung is the only population an upgrade prompt can honestly
          be measured against: everybody else here is blocked by onboarding or
          has simply not needed a second mailbox yet. */}
      {pressure.ok ? (
        <Tile label="Who the paywall can reach" aside="free, not exempt" span={6}>
          <FunnelSteps
            steps={[
              {
                label: 'Free and capped',
                value: pressure.data.capped_workspaces,
                note: `${formatCount(pressure.data.capped_activated)} have used a mailbox`,
              },
              {
                label: 'Holding the cap',
                value: pressure.data.at_ceiling,
                note: 'next connect refused',
              },
              {
                label: 'Blocked after value',
                value: pressure.data.at_ceiling_activated,
                note: pressure.data.at_ceiling_activated === 0 ? 'nobody yet' : 'the ones to ask',
              },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Who the paywall can reach" message={pressure.error} span={6} />
      )}

      {/* Reported, not hidden, and reported as a count of workspaces rather
          than as money: the second row is the number of accounts that hold
          more inboxes than Free allows and will never be charged for them.
          That is revenue permanently forgone by a decision we made, which is
          worth seeing every day precisely because it can never be fixed. */}
      {pressure.ok ? (
        <Tile
          label="Exempt for good"
          aside="never billable"
          span={6}
          tone={pressure.data.grandfathered_over_free > 0 ? 'warn' : 'default'}
        >
          <SplitList
            rows={[
              { label: 'Grandfathered, unlimited free', count: pressure.data.grandfathered_workspaces },
              { label: 'Of those, over the free cap', count: pressure.data.grandfathered_over_free },
              { label: 'Comped entitlements', count: pressure.data.comped_workspaces },
            ]}
          />
          <FactRow facts={[{ label: 'Paid workspaces', value: pressure.data.paid_workspaces }]} />
        </Tile>
      ) : (
        <TileError label="Exempt for good" message={pressure.error} span={6} />
      )}

      <p className="kiosk-detail-note">
        The window switch above ({windowShort(days)}) changes nothing here: every count is the estate as
        it stands right now. The cap is the free plan inbox allowance (one inbox today, read from the
        plan table rather than written here), and it applies ONLY to workspaces created after the
        2026-08-19 repricing: every account that existed before it keeps unlimited inboxes free,
        permanently, so those workspaces are counted apart and are not part of any rate on this panel. An inbox occupies a slot whether or not its connection is working, which is how the
        product enforces it, so these counts are higher than the live-inbox counts on the providers
        panel. Reaching the ceiling is not a purchase intent: it is only the moment the next connect is
        refused.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------- usage */

/**
 * The panel behind "Work done for customers".
 *
 * The tile shows billable actions, which is the metered subset of tool calls
 * rather than the calls themselves, so this panel puts the raw call series
 * beside it instead of letting one number stand for both.
 *
 * THE ACTION CEILING IS NOT THE PAYWALL. It was, before the 2026-08-19
 * repricing; since then the value metric is the inbox count and the action cap
 * survives as a silent abuse guard nobody is meant to reach. So a workspace
 * high in the utilisation bands is a runaway loop worth looking at, not a
 * customer about to convert, and the bands are measured over each workspace's
 * own billing period rather than over the board window: a share of an
 * allowance only means something over the period the allowance is granted for.
 */
export async function UsageDetail({ days }: KioskDetailProps) {
  const activity = activityDays(days);
  const capped = isActivityCapped(days);
  const windowAside = capped ? '90d max' : windowShort(days);

  const [volume, daily, bands] = await Promise.all([
    fetchUsageVolume(activity),
    fetchDailyMetrics(activity),
    fetchUtilizationBands(),
  ]);

  return (
    <>
      {volume.ok ? (
        <Tile label="Billable actions" aside={windowAside} span={4}>
          <BigNumber
            value={volume.data.billable_actions}
            caption={
              <>
                across <strong>{formatCount(volume.data.billable_workspaces)}</strong> workspaces
              </>
            }
          />
          <FactRow
            facts={[
              { label: 'Estate', value: volume.data.total_workspaces },
              {
                label: 'Did billable work',
                value: ratio(volume.data.billable_workspaces, volume.data.total_workspaces),
              },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Billable actions" message={volume.error} span={4} />
      )}

      {/* Every call, successful or not, beside the failures. This is a VOLUME
          series and not a user one: a single looping client can own it, which
          is exactly why it is drawn next to the workspace counts rather than
          on its own. Calendar weeks, so "last week" here and "last week" in
          somebody's head are the same stretch of days. */}
      {daily.ok ? (
        <Tile label="Tool calls, week by week" aside={windowAside} span={8}>
          {daily.data.length === 0 ? (
            <p className="kiosk-empty">No tool call has been recorded in this window.</p>
          ) : (
            <GroupedColumns
              buckets={calendarWeekBuckets(daily.data, CHART_WEEKS, (row) => [row.calls, row.errors])}
              series={[
                { name: 'Tool calls', color: 'var(--kiosk-accent)' },
                { name: 'Failed', color: 'var(--kiosk-bad)' },
              ]}
            />
          )}
        </Tile>
      ) : (
        <TileError label="Tool calls, week by week" message={daily.error} span={8} />
      )}

      {/* Not windowed, and the aside says so. The bands divide each workspace's
          usage by its own plan ceiling over its own current billing period,
          because dividing a trailing 7 or 90 day window by a per-period cap
          produced a number that meant nothing in either direction (the same
          workspace read fine at 7 days and over cap at 90). Workspaces that
          cannot hit a cap at all sit in the bottom band rather than being
          dropped, so the bands still total the whole estate. */}
      {bands.ok ? (
        <Tile label="Share of the action ceiling used" aside="own billing period" span={6}>
          <BarList
            rows={bands.data.map((row) => ({ name: row.band, count: row.workspaces }))}
            emptyLabel="No workspace to place in a band"
          />
        </Tile>
      ) : (
        <TileError label="Share of the action ceiling used" message={bands.error} span={6} />
      )}

      {/* A rejection is a call the product refused, so it never reached a tool
          and never appears as a failure in the chart above. It is counted here
          on its own for that reason, and because at this volume it usually
          means one workspace looping rather than a customer outgrowing us. */}
      {volume.ok ? (
        <Tile
          label="Refused at the cap"
          aside={windowAside}
          span={6}
          tone={volume.data.cap_rejections > 0 ? 'warn' : 'default'}
        >
          <BigNumber
            value={volume.data.cap_rejections}
            caption={
              volume.data.cap_rejections === 0 ? (
                'Nobody was turned away in this window'
              ) : (
                <>
                  <strong>{formatCount(volume.data.cap_hit_workspaces)}</strong> workspaces were told no
                </>
              )
            }
          />
          <FactRow
            facts={[
              { label: 'Estate', value: volume.data.total_workspaces },
              { label: 'Of the estate', value: ratio(volume.data.cap_hit_workspaces, volume.data.total_workspaces) },
            ]}
          />
        </Tile>
      ) : (
        <TileError label="Refused at the cap" message={volume.error} span={6} />
      )}

      <p className="kiosk-detail-note">
        Billable actions are the metered subset of tool calls, not the calls themselves, so the headline
        and the chart are counting different things on purpose and will never match. The action ceiling
        is an abuse guard rather than a price: since the 2026-08-19 repricing the paywall is the inbox
        count, so a workspace near its ceiling is worth a look for a runaway loop, not an upgrade
        prompt. The utilisation bands ignore the window switch entirely and measure each workspace over
        its own current billing period, which is the only period a share of an allowance means anything
        over. Our own accounts are included here, where they are real load.
        {capped
          ? ' Everything drawn from the activity log stops at 90 days: older rows are deleted, so a longer window would show real workspace counts beside zeroed activity.'
          : ''}
      </p>
    </>
  );
}
