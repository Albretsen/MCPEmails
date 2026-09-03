/**
 * "Where does everyone stop": the ladder from stranger to dollar.
 *
 * THIS REGION IS THE REASON THE PAGE WAS REDESIGNED RATHER THAN REARRANGED.
 * The two versions before it had four separate sections here, titled
 * Acquisition, Onboarding, Retention and The path to paid, each with a chart
 * and a table. Four sections is four filing cabinets: the numbers in them are
 * consecutive stages of one journey, and cutting the journey into four boxes
 * is precisely the fragmentation every source on dashboard design names as the
 * failure mode. So there is one ladder, top to bottom, and the things that
 * used to be section headings are now annotations hanging off the rung they
 * explain.
 *
 * THE SEAM IS DRAWN, NOT HIDDEN. The rungs do not all come from one place, and
 * pretending they do is how a funnel starts lying. Rungs one to seven are
 * workspace counts from the durable onboarding timestamps, over 400 days, and
 * every workspace is in them, ours included. The last three are DISTINCT
 * EXTERNAL workspaces counted from the billing event stream, all time, with our
 * own accounts filtered out. Those are different populations, so no percentage
 * is printed across the join and the join itself is a labelled row rather than
 * another rung. A reader who notices the seam has learned something true about
 * the measurement.
 *
 * THE POOLS ARE NOT RUNGS. People standing at the inbox ceiling are not
 * flowing anywhere: they are a reservoir of workspaces that stopped, and the
 * grandfathered population is a reservoir that can never be charged at all.
 * Drawing either as a step in a funnel would invite a conversion rate against
 * a population that cannot convert, which is the exact error
 * `growth_upgrade_pressure` was written to prevent. They sit in the gutter,
 * beside the seam, as standing counts.
 *
 * NO COHORT HEATMAP. The retention grid is eight by eight cells whose
 * denominators are mostly under ten, which is the size at which `ratio()`
 * refuses to print a percentage at all. Sixty-four cells of "2 of 7" is a
 * texture, not a finding. The curve, which pools the cohorts and therefore has
 * a denominator worth dividing into, is here instead.
 */

import type {
  GrowthActivationFunnelRow,
  GrowthChannelRow,
  GrowthInboxBandRow,
  GrowthLifecycleRow,
  GrowthOAuthAbandonmentRow,
  GrowthProviderFunnelRow,
  GrowthProviderMixRow,
  GrowthRetentionPointRow,
  GrowthUpgradePressureRow,
} from '@/lib/analytics/growth-types';
import type { GrowthUserSignupDayRow } from '@/lib/analytics/growth-types';
import type { CheckoutFunnel } from '@/lib/analytics/kiosk-revenue';
import { agoLabel } from '@/lib/analytics/growth-records';
import { formatCount, ratio } from '../charts/format';
// Pure label helpers, imported from the kiosk rather than copied. They are the
// one place provider and channel ids are turned into words, and two surfaces
// spelling `organic_google` differently is a small lie with no upside.
import { calendarWeekBuckets, prettyChannel, prettyProvider } from '../kiosk/shared';
import { BarRow, Dead, Facts, Label, Note } from './sheet';

type Failed = { error: string };
const failed = <T,>(value: T | Failed): value is Failed =>
  typeof value === 'object' && value !== null && 'error' in (value as Failed);

export type ChainProps = {
  signups: GrowthUserSignupDayRow[] | Failed;
  funnel: GrowthActivationFunnelRow[] | Failed;
  checkout: CheckoutFunnel | Failed;
  pressure: GrowthUpgradePressureRow | Failed;
  bands: GrowthInboxBandRow[] | Failed;
  lifecycle: GrowthLifecycleRow | Failed;
  retention: GrowthRetentionPointRow[] | Failed;
  channels: GrowthChannelRow[] | Failed;
  providers: GrowthProviderMixRow[] | Failed;
  providerFunnel: GrowthProviderFunnelRow[] | Failed;
  oauth: GrowthOAuthAbandonmentRow[] | Failed;
  windowDays: number;
};

/** Stage ids as a person would say them, in funnel order. */
const STAGE_LABELS: Record<GrowthActivationFunnelRow['stage'], string> = {
  signup: 'Signed up',
  client_selected: 'Picked an MCP client',
  inbox_connected: 'Connected an inbox',
  connection_verified: 'Connection verified',
  credential_issued: 'API key issued',
  technical_activation: 'First successful call',
  value_activation: 'Reached a mailbox',
};

export function Chain(props: ChainProps) {
  return (
    <>
      <Arrivals signups={props.signups} />
      {/* WHAT GOES IN WHICH COLUMN. The left column is the journey itself: the
          ladder, then the two things that are stages of it without being
          rungs. Standing at the inbox ceiling is a reservoir rather than a
          step, and coming back is measured from each workspace's own
          activation rather than from the top, so neither can be a rung
          without inviting a conversion rate that means nothing. The right
          column is the two breakdowns of who those people are: where they
          came from, and what they connected. Splitting it that way is also
          what keeps the two columns roughly the same height; with all four
          annotations on the right, the region was a 400px column beside a
          1000px one, which is the shape a reader reads as broken. */}
      <div className="br-chain-wrap">
        <div className="br-chain-col">
          <Ladder funnel={props.funnel} checkout={props.checkout} />
          <Pools pressure={props.pressure} bands={props.bands} checkout={props.checkout} />
          <ComingBack lifecycle={props.lifecycle} retention={props.retention} />
        </div>
        <div className="br-chain-gutter">
          <Channels channels={props.channels} windowDays={props.windowDays} />
          <Connecting
            providers={props.providers}
            providerFunnel={props.providerFunnel}
            oauth={props.oauth}
            windowDays={props.windowDays}
          />
        </div>
      </div>
    </>
  );
}

/**
 * How many people arrive each week, and how many of them reach a mailbox.
 *
 * CALENDAR WEEKS, MONDAY TO SUNDAY, not trailing seven-day buckets. Rolling
 * buckets never end in a short bar, which is tidy, and cost the reader the
 * ability to check the chart against anything: "last week" on the page and
 * "last week" in somebody's head become different stretches of time. The
 * partial current week is drawn hollow and labelled rather than hidden,
 * annualised or smoothed, all of which are ways of showing a number that is
 * not the number. It stays inside the scale, because a partial week that has
 * already beaten a finished one is the most encouraging thing this strip can
 * say.
 *
 * It sits above the ladder rather than in a section of its own because it is
 * the ladder's top rung over time: the same population, counted by week.
 */
function Arrivals({ signups }: { signups: GrowthUserSignupDayRow[] | Failed }) {
  if (failed(signups)) return <Dead what="Weekly arrivals" error={signups.error} />;
  const weeks = calendarWeekBuckets(signups, ARRIVAL_WEEKS, (row) => [row.new_users, row.activated_users]);
  if (weeks.length === 0) return <p className="br-empty">No signup has been recorded</p>;
  const max = Math.max(1, ...weeks.flatMap((week) => week.values));

  return (
    <div className="br-arrivals">
      <div className="br-arrivals-head">
        <Label>People arriving, by calendar week</Label>
        <p className="br-legend">
          <span><i className="is-brand" /> signed up</span>
          <span><i className="is-mint" /> reached a mailbox for the first time</span>
        </p>
      </div>
      <ol className="br-weeks">
        {weeks.map((week) => (
          <li key={week.label} className={week.partial ? 'is-partial' : undefined}>
            <span className="br-week-bars">
              {week.values.map((value, index) => (
                <span
                  key={index}
                  className={`br-week-bar ${index === 0 ? 'is-brand' : 'is-mint'}`}
                  style={{ height: value === 0 ? '0' : `${Math.max(3, (value / max) * 100)}%` }}
                >
                  {value > 0 && <b>{formatCount(value)}</b>}
                </span>
              ))}
            </span>
            <span className="br-week-label">
              {week.label}
              {week.partial && <i> so far</i>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Three months of weeks: long enough to see a shape, short enough to read. */
const ARRIVAL_WEEKS = 12;

/* ------------------------------------------------------------------ ladder */

function Ladder({
  funnel,
  checkout,
}: {
  funnel: GrowthActivationFunnelRow[] | Failed;
  checkout: CheckoutFunnel | Failed;
}) {
  const stages = failed(funnel)
    ? []
    : [...funnel].sort((a, b) => a.stage_index - b.stage_index);
  const top = stages[0]?.workspaces ?? 0;

  const paid = failed(checkout)
    ? []
    : [
        { label: 'Looked at the plans', value: checkout.pricingViewed },
        { label: 'Started a checkout', value: checkout.checkoutStarted },
        { label: 'Paid', value: checkout.checkoutCompleted },
      ];
  const paidTop = paid[0]?.value ?? 0;

  return (
    <>
      <ol className="br-chain">
        {/* Column headings, so "89%" and "50%" are not two unlabelled numbers
            in a row. Hidden from assistive tech: the rungs below carry their
            own words and this row is pure alignment. */}
        <li className="br-rung br-rung-head" aria-hidden="true">
          <span />
          <span />
          <span className="br-rung-value">count</span>
          <span className="br-rung-kept">kept</span>
          <span className="br-rung-overall">of top</span>
        </li>
        {failed(funnel) ? (
          <li className="br-chain-dead">
            <Dead what="The activation ladder" error={funnel.error} />
          </li>
        ) : (
          stages.map((stage, index) => {
            const previous = stages[index - 1];
            return (
              <Rung
                key={stage.stage}
                label={STAGE_LABELS[stage.stage] ?? stage.stage}
                value={stage.workspaces}
                max={top}
                kept={previous ? ratio(stage.workspaces, previous.workspaces) : null}
                overall={index > 1 ? ratio(stage.workspaces, top) : null}
              />
            );
          })
        )}

        <li className="br-chain-seam">
          <p>
            The count changes here. Everything above is workspaces, ours included, dated from the durable
            onboarding timestamps. Everything below is distinct external workspaces from the billing event
            stream, all time, with our own accounts removed. No percentage is printed across this line
            because the two are not the same population.
          </p>
        </li>

        {failed(checkout) ? (
          <li className="br-chain-dead">
            <Dead what="The checkout ladder" error={checkout.error} />
          </li>
        ) : (
          paid.map((rung, index) => (
            <Rung
              key={rung.label}
              label={rung.label}
              value={rung.value}
              max={paidTop}
              kept={index > 0 ? ratio(rung.value, paid[index - 1].value) : null}
              overall={index > 1 ? ratio(rung.value, paidTop) : null}
              tone="mint"
            />
          ))
        )}
      </ol>
      <Note>
        Each rung shows how many of the rung above it survived, and how many of the top of its own
        segment. A percentage only appears once the denominator is ten or more; below that it is printed
        as a count, because at this size a percentage over a handful of people is a lie with a decimal
        point.
      </Note>
    </>
  );
}

function Rung({
  label,
  value,
  max,
  kept,
  overall,
  tone = 'brand',
}: {
  label: string;
  value: number;
  max: number;
  kept: string | null;
  overall: string | null;
  tone?: 'brand' | 'mint';
}) {
  const width = max > 0 ? Math.max(1.5, (value / max) * 100) : 0;
  return (
    <li className="br-rung">
      <span className="br-rung-label">{label}</span>
      {/* The count sits beside the bar rather than inside it. On a filled bar
          the figure has to be legible against --brand in light mode and
          against the same fill in dark, and there is no one text colour that
          is: outside the track it is always plain foreground. */}
      <span className="br-rung-track">
        <span className={`br-rung-fill is-${tone}`} style={{ width: `${width}%` }} />
      </span>
      <span className="br-rung-value">{formatCount(value)}</span>
      <span className="br-rung-kept">{kept ?? ''}</span>
      <span className="br-rung-overall">{overall ?? ''}</span>
    </li>
  );
}

/* ------------------------------------------------------------------ gutter */

function GutterBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="br-gutter-block">
      <Label>{title}</Label>
      {children}
    </section>
  );
}

/**
 * Where the top rung came from.
 *
 * `unattributed` is rendered as a row like any other and never dropped.
 * Attribution only exists from 2026-08-05 and lands null on roughly a third of
 * signups; if the gap were hidden, the visible rows would eventually be read as
 * if they summed to the signup count, and every channel would silently gain a
 * third of the credit it has not earned.
 */
function Channels({ channels, windowDays }: { channels: GrowthChannelRow[] | Failed; windowDays: number }) {
  return (
    <GutterBlock title={`Where they came from, last ${windowDays} days`}>
      {failed(channels) ? (
        <Dead what="Acquisition channels" error={channels.error} />
      ) : channels.length === 0 ? (
        <p className="br-empty">No signups in this window</p>
      ) : (
        <table className="br-table">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Signups</th>
              <th scope="col">Mailbox</th>
              <th scope="col">Returned</th>
              <th scope="col">Paying</th>
            </tr>
          </thead>
          <tbody>
            {[...channels]
              .sort((a, b) => b.signups - a.signups)
              .map((row) => (
                <tr key={row.source} className={row.source === 'unattributed' ? 'is-quiet' : undefined}>
                  <th scope="row">{prettyChannel(row.source)}</th>
                  <td>{formatCount(row.signups)}</td>
                  <td>{ratio(row.activated, row.signups)}</td>
                  <td>{ratio(row.returned, row.signups)}</td>
                  <td>{formatCount(row.paying)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
      <Note>
        Returned means active on more than one UTC day. Unknown is our own measurement gap, not a
        channel, and stays in the table so the rows keep summing to the signup count.
      </Note>
    </GutterBlock>
  );
}

/** What they connect, and where connecting breaks. */
function Connecting({
  providers,
  providerFunnel,
  oauth,
  windowDays,
}: {
  providers: GrowthProviderMixRow[] | Failed;
  providerFunnel: GrowthProviderFunnelRow[] | Failed;
  oauth: GrowthOAuthAbandonmentRow[] | Failed;
  windowDays: number;
}) {
  const mix = failed(providers) ? [] : [...providers].sort((a, b) => b.inboxes - a.inboxes);
  const mixMax = Math.max(1, ...mix.map((row) => row.inboxes));
  const abandoned = failed(oauth) ? 0 : oauth.reduce((total, row) => total + row.abandoned, 0);
  const consented = failed(oauth) ? 0 : oauth.reduce((total, row) => total + row.connected, 0);

  return (
    <GutterBlock title="What they connect, and what breaks">
      {failed(providers) ? (
        <Dead what="Provider mix" error={providers.error} />
      ) : (
        <ul className="br-bars">
          {mix.map((row) => (
            <BarRow key={row.provider} name={prettyProvider(row.provider)} value={row.inboxes} max={mixMax} />
          ))}
        </ul>
      )}

      {failed(providerFunnel) ? (
        <Dead what="Connection attempts" error={providerFunnel.error} />
      ) : providerFunnel.length === 0 ? (
        <p className="br-empty">No connection attempts in this window</p>
      ) : (
        <table className="br-table">
          <thead>
            <tr>
              <th scope="col">Tried, last {windowDays}d</th>
              <th scope="col">Workspaces</th>
              <th scope="col">Connected</th>
              <th scope="col">Top failure</th>
            </tr>
          </thead>
          <tbody>
            {[...providerFunnel]
              .sort((a, b) => b.workspaces_attempted - a.workspaces_attempted)
              .map((row) => (
                <tr key={row.provider}>
                  <th scope="row">{prettyProvider(row.provider)}</th>
                  <td>{formatCount(row.workspaces_attempted)}</td>
                  <td>{ratio(row.workspaces_connected, row.workspaces_attempted)}</td>
                  <td className="br-cell-text">{row.top_error ?? 'none'}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}

      {failed(oauth) ? (
        <Dead what="OAuth abandonment" error={oauth.error} />
      ) : (
        <Note>
          {formatCount(abandoned)} consent screens were opened and never came back, against{' '}
          {formatCount(consented)} that did. Those leave no funnel event at all, which is why they are
          counted from the leftover `oauth_states` rows instead.
        </Note>
      )}
    </GutterBlock>
  );
}

/** Whether reaching a mailbox once turns into using the product. */
function ComingBack({
  lifecycle,
  retention,
}: {
  lifecycle: GrowthLifecycleRow | Failed;
  retention: GrowthRetentionPointRow[] | Failed;
}) {
  const curve = failed(retention) ? [] : retention.filter((point) => point.eligible > 0);
  return (
    <GutterBlock title="Do they come back">
      {failed(lifecycle) ? (
        <Dead what="Lifecycle counts" error={lifecycle.error} />
      ) : (
        <Facts
          rows={[
            { label: 'Reached a mailbox, ever', value: formatCount(lifecycle.value_activated) },
            {
              label: 'Used it on one day only',
              value: formatCount(lifecycle.one_and_done),
              note: ratio(lifecycle.one_and_done, lifecycle.value_activated),
            },
            {
              label: 'Quiet 14 days or more',
              value: formatCount(lifecycle.at_risk),
              note: 'was active twice or more',
            },
            { label: 'Active in the last 7 days', value: formatCount(lifecycle.active_7d) },
          ]}
        />
      )}

      {failed(retention) ? (
        <Dead what="Retention curve" error={retention.error} />
      ) : curve.length === 0 ? (
        <p className="br-empty">No cohort has completed a week yet</p>
      ) : (
        <ul className="br-bars">
          {curve.map((point) => (
            <BarRow
              key={point.week_index}
              name={`Week ${point.week_index}`}
              value={point.retained}
              max={Math.max(1, ...curve.map((entry) => entry.eligible))}
              right={ratio(point.retained, point.eligible)}
              tone="mint"
            />
          ))}
        </ul>
      )}
      <Note>
        Weeks are counted from each workspace&apos;s own value activation, and a workspace only enters a
        week once that whole week has elapsed. Our own accounts are excluded: the synthetic monitor calls
        the product every five minutes and used to lift the tail of this curve to 50% when no external
        workspace had ever returned that late.
      </Note>
    </GutterBlock>
  );
}

/**
 * The reservoirs: people who stopped, and people who can never be charged.
 *
 * `grandfathered_over_free` is revenue permanently forgone rather than a bug,
 * and it is stated here so that nobody computes a conversion rate against a
 * population that is contractually unable to convert.
 */
function Pools({
  pressure,
  bands,
  checkout,
}: {
  pressure: GrowthUpgradePressureRow | Failed;
  bands: GrowthInboxBandRow[] | Failed;
  checkout: CheckoutFunnel | Failed;
}) {
  return (
    <GutterBlock title="Who is standing still">
      {failed(pressure) ? (
        <Dead what="Upgrade pressure" error={pressure.error} />
      ) : (
        <>
          <Facts
            rows={[
              {
                label: 'At the inbox ceiling',
                value: formatCount(pressure.at_ceiling),
                note: `of ${formatCount(pressure.capped_workspaces)} the cap can reach`,
              },
              {
                label: 'And already used a mailbox',
                value: formatCount(pressure.at_ceiling_activated),
                note: 'the number worth acting on',
              },
              {
                label: 'Grandfathered, never chargeable',
                value: formatCount(pressure.grandfathered_workspaces),
                note: `${formatCount(pressure.grandfathered_over_free)} hold more inboxes than Free allows`,
              },
              { label: 'Paid', value: formatCount(pressure.paid_workspaces), note: `${formatCount(pressure.comped_workspaces)} comped` },
            ]}
          />
          <Note>
            Connected inboxes have been the value metric since the August 2026 repricing. The old action
            cap survives only as a silent abuse ceiling and is not measured on this page at all: it reads
            a structural zero, and four panels used to say so.
          </Note>
        </>
      )}

      {failed(bands) ? (
        <Dead what="Inbox distribution" error={bands.error} />
      ) : (
        <table className="br-table">
          <thead>
            <tr>
              <th scope="col">Inboxes</th>
              <th scope="col">Capped</th>
              <th scope="col">Exempt</th>
              <th scope="col">Paid</th>
            </tr>
          </thead>
          <tbody>
            {[...bands]
              .sort((a, b) => a.band_index - b.band_index)
              .map((band) => (
                <tr key={band.band}>
                  <th scope="row">{band.band}</th>
                  <td>{formatCount(band.capped)}</td>
                  <td>{formatCount(band.exempt)}</td>
                  <td>{formatCount(band.paid)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}

      {!failed(checkout) && (
        <Note>
          {checkout.lastCompletedAt
            ? `Last completed sale ${agoLabel(checkout.lastCompletedAt)}. `
            : 'No checkout has ever completed. '}
          {formatCount(checkout.abandoned)} started and abandoned, {formatCount(checkout.checkoutFailed)}{' '}
          failed outright, {formatCount(checkout.portalOpened)} opened the billing portal.{' '}
          {formatCount(checkout.internalExcluded)} of our own workspaces were dropped from all of it.
        </Note>
      )}
    </GutterBlock>
  );
}
