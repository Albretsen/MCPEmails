/**
 * The panels that exist only on /admin/growth.
 *
 * Everything else on the board is either a kiosk tile (components/admin/kiosk
 * /primitives, re-scaled for a laptop in admin-growth.css) or a chart
 * (components/admin/charts). What is left is the four shapes those two kits
 * do not have.
 *
 * REBUILT 2026-09-07 against Plausible's and Baremetrics' boards, after the
 * first attempt was called too large and messy. Two of the ideas here are
 * theirs outright:
 *
 *   THE STAT STRIP is Plausible's. Six headline metrics as hairline-divided
 *   columns along the top of ONE card, with the chart that explains them
 *   directly underneath. What it replaces was a 76px MRR "hero" panel plus four
 *   separate KPI tiles, which took a full screen to say less and implied the
 *   six numbers were unrelated to each other and to the chart.
 *
 *   THE RAIL is Baremetrics'. Its Control Center keeps the MRR movement
 *   breakdown in a narrow right-hand column of compact `count · label · value`
 *   rows rather than in cards. Both things that had no good home here are that
 *   shape: the four MRR movements, and the records.
 *
 * WHAT WAS DELETED: the "Needs attention" panel. The operator asked why it was
 * necessary and there is no good answer: every line in it was a threshold
 * crossing over a figure already on the page, so it was the board telling
 * itself what it had just said. The rules still live in
 * src/lib/analytics/growth-attention.ts, unused, if it is ever wanted back.
 *
 * All synchronous Server Components. The board ships no JavaScript.
 */

import type { ReactNode } from 'react';
import type { HealthLevel } from '@/lib/analytics/health-math';
import { clamp, formatCount } from '../../charts/format';

/* ============================================================= stat strip */

export type Stat = {
  label: string;
  /** Pre-formatted by the caller: the rule for money is not typography's. */
  value: string;
  /** Percentage change against the previous window, or null when none exists. */
  deltaPercent?: number | null;
  goodDirection?: 'up' | 'down';
  /** Baremetrics' "from $174,730": the comparison, beside the number. */
  note?: string;
};

/**
 * The headline row. Six columns, one hairline between each, nothing else.
 *
 * It sits inside a `Tile` whose padding it deliberately cancels with a
 * negative margin, so the dividers reach the card edges the way Plausible's
 * do. A strip inset from the border reads as a table dropped into a box;
 * flush, it reads as the top of the card.
 */
export function StatStrip({ stats }: { stats: Stat[] }) {
  return (
    <div className="gb-strip">
      {stats.map((stat) => {
        const tone = deltaTone(stat.deltaPercent, stat.goodDirection ?? 'up');
        return (
          <div className="gb-stat" key={stat.label}>
            <p className="gb-stat-label">{stat.label}</p>
            <div className="gb-stat-row">
              <span className="gb-stat-value">{stat.value}</span>
              {tone && stat.deltaPercent !== null && stat.deltaPercent !== undefined && (
                <span className={`gb-stat-delta is-${tone}`}>
                  {stat.deltaPercent > 0 ? '↑' : stat.deltaPercent < 0 ? '↓' : '→'}
                  {Math.abs(Math.round(stat.deltaPercent))}%
                </span>
              )}
            </div>
            {stat.note && <span className="gb-stat-note">{stat.note}</span>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Green when the number moved the way we want it to, red the other way,
 * neutral when it did not move. A flat week is not a failure and must not be
 * painted as one, and a missing comparison renders no badge at all rather than
 * a zero.
 */
function deltaTone(percent: number | null | undefined, good: 'up' | 'down'): 'good' | 'bad' | 'flat' | null {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return null;
  if (Math.round(percent) === 0) return 'flat';
  return percent > 0 === (good === 'up') ? 'good' : 'bad';
}

/* =================================================================== rail */

export type RailRow = {
  key: string;
  /** Left column: a count. Omitted for rows that have none. */
  count?: string | number;
  label: string;
  value: string;
  tone?: 'good' | 'bad' | 'warn';
  /** Renders faded. A zero must not look the same as "we do not measure it". */
  zero?: boolean;
};

/** A titled block of `count · label · value` rows. */
export function Rail({ groups }: { groups: { title: string; rows: RailRow[] }[] }) {
  return (
    <div className="gb-rail">
      {groups.map((group) => (
        <div key={group.title}>
          <p className="gb-rail-head">{group.title}</p>
          {group.rows.map((row) => (
            <div className={`gb-row${row.tone ? ` is-${row.tone}` : ''}${row.zero ? ' is-zero' : ''}`} key={row.key}>
              <span className="gb-row-count">{row.count ?? ''}</span>
              <span className="gb-row-label">{row.label}</span>
              <span className="gb-row-value">{row.value}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ========================================================= health verdict */

/**
 * One line, above everything.
 *
 * The kiosk's alarm has no green state because a permanent "all systems
 * operational" bar becomes wallpaper on a wall. This surface is opened
 * deliberately by someone who wants the answer, so the healthy case does
 * render: a dot, a word and a reason. Only a degraded verdict takes colour,
 * and only a down one is allowed to wrap onto a second line.
 */
export function Verdict({
  level,
  headline,
  reason,
}: {
  level: HealthLevel;
  headline: string;
  reason: string;
}) {
  return (
    <p className={`gb-verdict is-${level}`}>
      <b>{headline}</b>
      <span className="gb-verdict-reason">{reason}</span>
    </p>
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
 * Where paying customers come from, which is not where signups come from.
 *
 * The donut this replaces ranked channels by signup count. A channel that
 * sends fifty people who never connect an inbox is worth less than one that
 * sends five who pay, and a share-of-signups chart cannot say so. Each row is
 * one channel's own signups split into the three states those people reached,
 * so the SHAPE of the row is the quality of the channel and its LENGTH is
 * still the volume.
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
        // segments are DIFFERENCES. Stacking the raw counts would draw a bar
        // longer than the channel's own traffic. Clamped at zero because the
        // three figures come from one query but not from one instant.
        const paying = clamp(row.paying, 0, row.signups);
        const activated = clamp(row.activated - paying, 0, row.signups - paying);
        const cold = Math.max(0, row.signups - paying - activated);
        const scale = (value: number) => `${(value / widest) * 100}%`;
        return (
          <li key={row.name}>
            <span className="gb-chan-name">{row.name}</span>
            <span
              className="gb-chan-track"
              title={`${row.signups} signed up, ${row.activated} reached a mailbox, ${row.paying} pay`}
            >
              <span className="gb-chan-seg is-paying" style={{ width: scale(paying) }} />
              <span className="gb-chan-seg is-activated" style={{ width: scale(activated) }} />
              <span className="gb-chan-seg is-cold" style={{ width: scale(cold) }} />
            </span>
            <span className="gb-chan-num">
              {formatCount(row.signups)}
              {row.paying > 0 ? ` · ${formatCount(row.paying)} pay` : ''}
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
  size = 40,
  center,
  label,
}: {
  progress: number;
  size?: number;
  center?: ReactNode;
  label: string;
}) {
  const diameter = Number.isFinite(size) && size > 0 ? size : 40;
  const fraction = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
  const stroke = Math.max(3, Math.round(diameter * 0.1));
  const radius = (diameter - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const length = fraction * circumference;
  const middle = diameter / 2;

  return (
    <span className="gb-ring" style={{ width: diameter, height: diameter }}>
      <svg
        className="gb-ring-svg"
        viewBox={`0 0 ${diameter} ${diameter}`}
        width={diameter}
        height={diameter}
        role="img"
        aria-label={label}
      >
        <title>{label}</title>
        <circle className="gb-ring-track" cx={middle} cy={middle} r={radius} fill="none" strokeWidth={stroke} />
        {length > 0 ? (
          /* The -90 degree rotation starts the arc at twelve o'clock. SVG
             angles start at three, and a dial that begins on the right reads
             as though it is already a quarter of the way round. */
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
