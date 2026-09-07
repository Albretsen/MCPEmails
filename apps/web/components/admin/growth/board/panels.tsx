/**
 * The panels that exist only on /admin/growth.
 *
 * Everything else on that board is either a kiosk tile (components/admin/kiosk
 * /primitives) or a chart (components/admin/charts). What is left is the four
 * things a laptop can carry and a wall display cannot: a money panel with five
 * levels of weight in it, the computed to-do list, a health line that is one
 * line rather than a flashing bar, and the channel-quality bars.
 *
 * All synchronous Server Components. The board ships no JavaScript.
 */

import type { ReactNode } from 'react';
import type { AttentionItem, AttentionReport } from '@/lib/analytics/growth-attention';
import type { HealthLevel } from '@/lib/analytics/health-math';
import type { CashCollected } from '@/lib/analytics/kiosk-revenue';
import type { RevenueSummary } from '@/lib/analytics/revenue-math';
import { agoLabel } from '@/lib/analytics/growth-records';
import { clamp, formatCount, formatMoney, formatPercent } from '../../charts/format';
import { GroupedColumns } from '../../kiosk/primitives';

/* ============================================================== the hero */

export type HeroProps = {
  revenue: RevenueSummary | null;
  revenueError: string | null;
  cash: CashCollected | null;
  /** Notional company value: ARR times the house multiple. */
  valuationMinor: number | null;
  valuationMultiple: number;
  /** ISO of the most recent completed checkout, or null if there has never been one. */
  lastSaleAt: string | null;
  windowDays: number;
};

/**
 * The money, as one panel with five weights rather than five equal cards.
 *
 * MRR is the number. The annual figure, what each paying customer is worth and
 * the notional valuation are a line of satellites under it, because every one
 * of them is derived from MRR and giving each its own tile would imply it was
 * independently measured. Cash sits among them at the same weight and is
 * meant to disagree with MRR: a year paid up front lands whole and recurs at a
 * twelfth of itself. The movements are chips and are never netted.
 */
export function Hero({
  revenue,
  revenueError,
  cash,
  valuationMinor,
  valuationMultiple,
  lastSaleAt,
  windowDays,
}: HeroProps) {
  if (!revenue) {
    return (
      <section className="gb-hero">
        <div className="gb-hero-left">
          <p className="gb-hero-label">Recurring revenue</p>
          <div className="gb-hero-row">
            <span className="gb-hero-value">&mdash;</span>
          </div>
          <p className="gb-hero-note">
            Stripe could not be read, so every money figure here is missing rather than zero.
            {revenueError ? ` ${revenueError}` : ''}
          </p>
        </div>
        <div className="gb-hero-right" />
      </section>
    );
  }

  const money = (minor: number) => formatMoney(minor, revenue.currency);
  const sinceSale = agoLabel(lastSaleAt);

  return (
    <section className="gb-hero">
      <div className="gb-hero-left">
        <p className="gb-hero-label">Recurring revenue</p>
        <div className="gb-hero-row">
          <span className="gb-hero-value">{money(revenue.mrrMinor)}</span>
          <span className="gb-hero-unit">/mo</span>
        </div>

        <dl className="gb-sats">
          <div>
            <dt>A year of it</dt>
            <dd>{money(revenue.arrMinor)}</dd>
          </div>
          <div>
            <dt>Each customer</dt>
            <dd>
              {revenue.payingCustomers > 0 ? money(revenue.arpaMinor) : '—'}
              <small>{formatCount(revenue.payingCustomers)} paying</small>
            </dd>
          </div>
          <div>
            <dt>Cash, all time</dt>
            <dd>
              {cash ? money(cash.allTimeMinor) : '—'}
              {cash ? <small>{money(cash.last30Minor)} in 30d</small> : null}
            </dd>
          </div>
          <div>
            {/* Named "on this convention" rather than "valuation", because a
                large currency figure is the single easiest number here to
                mistake for a fact. It is ARR times a multiple and nothing more. */}
            <dt>{valuationMultiple}&times; ARR</dt>
            <dd>{valuationMinor === null ? '—' : money(valuationMinor)}</dd>
          </div>
        </dl>

        <ul className="gb-moves">
          <Move kind="new" label={`new, ${windowDays}d`} amount={revenue.newMrrMinor} count={revenue.newCustomers} money={money} />
          <Move kind="churn" label={`churned, ${windowDays}d`} amount={revenue.churnedMrrMinor} count={revenue.churnedCustomers} money={money} />
          <Move kind="risk" label="at risk" amount={revenue.atRiskMinor} count={revenue.atRiskCustomers} money={money} />
          <Move kind="leaving" label="leaving" amount={revenue.leavingMinor} count={revenue.leavingCustomers} money={money} />
        </ul>

        {/* One line, and it is the one line that is not derivable from the
            figures above it. The plan split lives in its own tile two rows
            down and is not restated here. */}
        <p className="gb-hero-note">
          {sinceSale ? `Last sale ${sinceSale}` : 'Never sold'} &middot;{' '}
          {formatCount(revenue.compedCustomers)} comped &middot; {formatCount(revenue.internalCustomers)} ours, excluded
        </p>

        {revenue.otherCurrencies.length > 0 && (
          <p className="gb-hero-flag">
            Also live in {revenue.otherCurrencies.join(', ').toUpperCase()}. The headline is{' '}
            {revenue.currency.toUpperCase()} only, so it understates the total.
          </p>
        )}
        {cash && cash.mode !== 'live' && (
          <p className="gb-hero-flag">Stripe is in {cash.mode} mode here, so these are not real dollars.</p>
        )}
      </div>

      <div className="gb-hero-right">
        {cash && cash.months.length >= 2 ? (
          <>
            <p className="gb-hero-label">Cash banked by month</p>
            <GroupedColumns
              buckets={cash.months.map((month, index) => ({
                label: monthLabel(month.month),
                values: [Math.max(0, month.netMinor) / 100],
                // The month we are living through is short by construction and
                // always looks like a collapse. Drawn hollow and labelled, the
                // same convention the kiosk uses for the current week.
                partial: index === cash.months.length - 1,
              }))}
              series={[{ name: 'Net of refunds', color: 'var(--mint-500)' }]}
            />
            <p className="gb-hero-note">
              {formatCount(cash.charges)} charges{cash.since ? `, first ${agoLabel(cash.since)}` : ''}
              {cash.truncated ? '. Read ceiling hit, so these are floors' : ''}
            </p>
          </>
        ) : (
          <p className="gb-hero-note">Not enough banked months to draw a shape yet.</p>
        )}
      </div>
    </section>
  );
}

function Move({
  kind,
  label,
  amount,
  count,
  money,
}: {
  kind: 'new' | 'churn' | 'risk' | 'leaving';
  label: string;
  amount: number;
  count: number;
  money: (minor: number) => string;
}) {
  const live = amount > 0;
  return (
    <li className={`is-${kind}${live ? '' : ' is-zero'}`}>
      <i aria-hidden="true" />
      <b>{money(amount)}</b>
      {label}
      {live ? ` (${formatCount(count)})` : ''}
    </li>
  );
}

/** `2026-08-01` as `Aug`, or `Aug 25` when the series crosses a year. */
function monthLabel(month: string): string {
  const date = new Date(`${month.slice(0, 7)}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return month;
  return MONTH.format(date);
}
const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });

/* ========================================================= health verdict */

/**
 * One line, at the top, above everything.
 *
 * The kiosk's alarm has no green state because a permanent "all systems
 * operational" bar becomes wallpaper. This surface is different: it is opened
 * deliberately, once, and the reader wants to know the answer rather than be
 * ambushed by it, so the healthy case does render, as one quiet line carrying
 * a number. What it still refuses to do is shout when there is nothing wrong.
 */
export function Verdict({
  level,
  headline,
  reason,
  checkedAt,
  openIncidents,
}: {
  level: HealthLevel;
  headline: string;
  reason: string;
  checkedAt: string;
  openIncidents: number;
}) {
  return (
    <p className={`gb-verdict is-${level}`}>
      <b>{headline}</b>
      <span className="gb-verdict-reason">{reason}</span>
      <span>
        {openIncidents > 0
          ? `${formatCount(openIncidents)} incident${openIncidents === 1 ? '' : 's'} open · `
          : ''}
        checked {agoLabel(checkedAt) ?? 'just now'}
      </span>
    </p>
  );
}

/* ========================================================ceneeds attention */

/** Shown before the rest collapse into a drawer. */
const VISIBLE_ITEMS = 5;

/**
 * The computed to-do list.
 *
 * Nothing here is a judgement: every line is a fact plus the fact that it
 * crossed a threshold somebody wrote down in growth-attention.ts. The
 * population is a muted suffix on the same line rather than a second sentence,
 * because a number without its denominator is exactly how this dashboard has
 * misled before, and a paragraph per item is what made the page it replaces a
 * wall of text.
 *
 * AN EMPTY LIST STATES ITS OWN PROVENANCE. "Nothing is wrong" and "this panel
 * failed to load" look identical if the empty state is blank space.
 */
export function Attention({ report }: { report: AttentionReport }) {
  const shown = report.items.slice(0, VISIBLE_ITEMS);
  const rest = report.items.slice(VISIBLE_ITEMS);

  return (
    <>
      {report.items.length === 0 ? (
        <p className="gb-clear">
          <b>Nothing crossed a threshold.</b>
          <span>
            {formatCount(report.checksRun)} checks ran
            {report.checksBlocked > 0
              ? `, ${formatCount(report.checksBlocked)} could not: their read failed, so those are unknown rather than clear`
              : ', none blocked'}
          </span>
        </p>
      ) : (
        <>
          <Items items={shown} />
          {rest.length > 0 && (
            <details className="gb-drawer">
              <summary>
                {formatCount(rest.length)} more
                {report.checksBlocked > 0 ? `, ${formatCount(report.checksBlocked)} checks blocked` : ''}
              </summary>
              <Items items={rest} />
            </details>
          )}
        </>
      )}
    </>
  );
}

function Items({ items }: { items: AttentionItem[] }) {
  return (
    <ol className="gb-todo">
      {items.map((item) => (
        <li key={item.id} className={`is-${item.severity}`}>
          <i aria-hidden="true" />
          <span>
            <span className="gb-todo-title">{item.title}</span>{' '}
            <span className="gb-todo-pop">{item.population}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ======================================================== channel quality */

export type ChannelRow = {
  name: string;
  signups: number;
  activated: number;
  paying: number;
};

/**
 * Where paying customers come from, which is not the same question as where
 * signups come from.
 *
 * The donut this replaces ranked channels by signup count. A channel that
 * sends fifty people who never connect an inbox is worth less than one that
 * sends five who pay, and a share-of-signups chart cannot say so; it is the
 * chart that makes an unattributed third of the traffic look like the biggest
 * thing we do. Each row here is one channel's own signups, split into the
 * three states those people ended up in, so the SHAPE of the row is the
 * quality of the channel and the length of it is still the volume.
 *
 * `Unknown` stays in. It is a gap in our own measurement rather than a
 * channel, and hiding it would silently hand every named source a share it has
 * not earned.
 */
export function ChannelQuality({ rows }: { rows: ChannelRow[] }) {
  if (rows.length === 0) return <p className="kiosk-empty">No signup has an attributed source yet.</p>;
  const widest = Math.max(1, ...rows.map((row) => row.signups));

  return (
    <ul className="gb-chan">
      {rows.map((row) => {
        // Paying is a subset of activated, which is a subset of signups, so the
        // segments are differences rather than the raw counts: stacking the
        // counts themselves would draw a bar longer than the channel's own
        // traffic. Clamped at zero because the three figures come from one
        // query but not from one instant.
        const paying = clamp(row.paying, 0, row.signups);
        const activated = clamp(row.activated - paying, 0, row.signups - paying);
        const cold = Math.max(0, row.signups - paying - activated);
        const scale = (value: number) => `${(value / widest) * 100}%`;
        return (
          <li key={row.name}>
            <span className="gb-chan-name">{row.name}</span>
            <span className="gb-chan-track" title={`${row.signups} signed up, ${row.activated} reached a mailbox, ${row.paying} pay`}>
              <span className="gb-chan-seg is-paying" style={{ width: scale(paying) }} />
              <span className="gb-chan-seg is-activated" style={{ width: scale(activated) }} />
              <span className="gb-chan-seg is-cold" style={{ width: scale(cold) }} />
            </span>
            <span className="gb-chan-num">
              {formatCount(row.signups)}
              <small>
                {row.paying > 0
                  ? `${formatCount(row.paying)} pay`
                  : row.activated > 0
                    ? `${formatPercent(row.activated / Math.max(1, row.signups))} activated`
                    : 'none activated'}
              </small>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ================================================================= a ring */

/**
 * A "how close" dial, for the milestone board and nothing else.
 *
 * Both ends of the range break naive dash arithmetic, so both are explicit: at
 * zero no arc element is emitted at all (a zero-length dash still paints a cap
 * and shows as a stray dot), and at one the gap is zero, which closes the ring
 * rather than leaving a hairline.
 */
export function Ring({
  progress,
  size = 56,
  center,
  label,
}: {
  progress: number;
  size?: number;
  center?: ReactNode;
  label: string;
}) {
  const diameter = Number.isFinite(size) && size > 0 ? size : 56;
  const fraction = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
  const stroke = Math.max(4, Math.round(diameter * 0.11));
  const radius = (diameter - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const length = fraction * circumference;
  const middle = diameter / 2;

  return (
    <span className="gb-ring" style={{ width: diameter, height: diameter }}>
      <svg className="gb-ring-svg" viewBox={`0 0 ${diameter} ${diameter}`} width={diameter} height={diameter} role="img" aria-label={label}>
        <title>{label}</title>
        <circle className="gb-ring-track" cx={middle} cy={middle} r={radius} fill="none" strokeWidth={stroke} />
        {length > 0 ? (
          /* The -90 degree rotation is what starts the arc at twelve o'clock.
             SVG angles start at three, and a dial that begins on the right
             reads as though it is already a quarter of the way round. */
          <circle
            cx={middle}
            cy={middle}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            stroke="var(--kiosk-accent)"
            strokeLinecap="round"
            strokeDasharray={`${length.toFixed(3)} ${Math.max(0, circumference - length).toFixed(3)}`}
            transform={`rotate(-90 ${middle} ${middle})`}
          />
        ) : null}
      </svg>
      {center ? <span className="gb-ring-center" aria-hidden="true">{center}</span> : null}
    </span>
  );
}
