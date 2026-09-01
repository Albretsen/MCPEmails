/**
 * Display primitives for the wall-mounted kiosk.
 *
 * These deliberately do not reuse `components/admin/charts`. Those primitives
 * are tuned for a 14 inch laptop at reading distance: 12px axis labels, hover
 * tooltips, collapsed exact-numbers tables, an info dot on every heading. None
 * of that survives being read from four metres away by someone walking past,
 * and half of it needs a pointer the kiosk does not have.
 *
 * The rules here are different, and they are all consequences of the viewing
 * distance:
 *
 *   - Every number is sized in `cqh` / `vh` units, never pixels, so the board
 *     fills a 1080p panel and a 4K one identically without a media query.
 *   - No hover states, no tooltips, no transitions that depend on a cursor.
 *   - Colour carries meaning but never alone; every tile also states its own
 *     label in words, because a glanced-at green bar with no caption is just
 *     decoration.
 *
 * Server components throughout: the board ships no JavaScript except the small
 * refresh ticker.
 */

import type { ReactNode } from 'react';
// Imported from the leaf module rather than the `../charts` barrel. The barrel
// re-exports every chart component, and this file is now pulled into the
// client bundle by the health tile, which would drag all of them with it for
// the sake of two pure functions.
import { NO_DATA, formatCount } from '../charts/format';

/** A framed tile. Everything on the board sits in one of these. */
export function Tile({
  label,
  aside,
  span,
  tone,
  className,
  children,
}: {
  label: string;
  /** Short right-aligned qualifier: a window, a total, a target. */
  aside?: ReactNode;
  /** Grid columns to occupy. Rows are set by the board's own template. */
  span?: number;
  tone?: 'default' | 'good' | 'warn' | 'bad' | 'goal';
  /** Extra classes, in practice only `kiosk-strip` (see the stylesheet). */
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`kiosk-tile is-${tone ?? 'default'}${className ? ` ${className}` : ''}`}
      style={span ? { gridColumn: `span ${span}` } : undefined}
    >
      <header className="kiosk-tile-head">
        <h2>{label}</h2>
        {aside && <span className="kiosk-tile-aside">{aside}</span>}
      </header>
      <div className="kiosk-tile-body">{children}</div>
    </section>
  );
}

export type Trend = { percent: number; goodDirection: 'up' | 'down' } | null;

/**
 * The headline number in a tile.
 *
 * `value` is pre-formatted by the caller when it is not a plain count (a
 * percentage, a currency figure), because the formatting rules for those live
 * with the metric, not with the typography.
 */
export function BigNumber({
  value,
  suffix,
  trend,
  caption,
  spark,
  sparkColor,
}: {
  value: string | number;
  suffix?: string;
  trend?: Trend;
  caption?: ReactNode;
  spark?: number[];
  sparkColor?: string;
}) {
  const tone = trendTone(trend);
  const text = typeof value === 'number' ? formatCount(value) : value;
  // The row does not wrap and its children do not shrink, so a long headline
  // pushes the trend badge off the tile instead of being made to fit. Counts
  // never get there; the money tile can, once MRR needs a thousands separator
  // beside a currency symbol and a "/mo". Long values step down a size.
  const long = text.length >= 7;
  return (
    <div className="kiosk-big">
      <div className="kiosk-big-row">
        <span className={`kiosk-big-value${long ? ' is-long' : ''}`}>
          {text}
          {suffix && <span className="kiosk-big-suffix">{suffix}</span>}
        </span>
        {trend && tone && (
          <span className={`kiosk-trend is-${tone}`}>
            {trend.percent > 0 ? '▲' : trend.percent < 0 ? '▼' : '■'}
            {Math.abs(Math.round(trend.percent))}%
          </span>
        )}
      </div>
      {caption && <p className="kiosk-big-caption">{caption}</p>}
      {spark && spark.length > 1 && <KioskSpark values={spark} color={sparkColor} />}
    </div>
  );
}

/**
 * Green when the number moved the way we want it to, red when it moved the
 * other way, neutral when it did not move. A flat week is not a failure and
 * must not be painted as one.
 */
function trendTone(trend: Trend | undefined): 'good' | 'bad' | 'flat' | null {
  if (!trend) return null;
  if (Math.round(trend.percent) === 0) return 'flat';
  const rising = trend.percent > 0;
  return rising === (trend.goodDirection === 'up') ? 'good' : 'bad';
}

/**
 * A filled area trend, sized to the tile rather than to a line of text.
 *
 * Area rather than a bare stroke because at distance a 2px line disappears
 * against the panel; the fill is what makes the shape readable across a room.
 * A flat series is drawn along the middle, the same convention the small
 * Sparkline uses, so "no movement" never looks like "pinned at zero".
 */
export function KioskSpark({
  values,
  color = 'var(--kiosk-accent)',
  height = 100,
}: {
  values: number[];
  color?: string;
  height?: number;
}) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length < 2) return null;

  const width = 300;
  const pad = 6;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min;
  const step = width / (clean.length - 1);
  const points = clean.map((value, index) => {
    const x = index * step;
    const y = span === 0
      ? height / 2
      : pad + (height - pad * 2) * (1 - (value - min) / span);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const line = `M${points.join('L')}`;
  const area = `${line}L${width},${height}L0,${height}Z`;
  const gradientId = `kiosk-spark-${color.replace(/[^a-z0-9]/gi, '')}`;

  return (
    <svg
      className="kiosk-spark"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.42" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * A ranked horizontal bar list: providers, clients, plans.
 *
 * Shares its shape with the desktop page's MixBars but not its code, because
 * this one drops the percentage column. At a denominator of a few dozen the
 * share is the least informative thing in the row, and on a wall display the
 * space it costs is what makes the name legible.
 */
export function BarList({
  rows,
  emptyLabel = 'Nothing recorded yet',
  color = 'var(--kiosk-accent)',
}: {
  rows: { name: string; count: number; color?: string }[];
  emptyLabel?: string;
  color?: string;
}) {
  if (rows.length === 0) return <p className="kiosk-empty">{emptyLabel}</p>;
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <ul className="kiosk-bars">
      {rows.map((row) => (
        <li key={row.name}>
          <span className="kiosk-bar-name">{row.name}</span>
          <span className="kiosk-bar-track">
            <span
              className="kiosk-bar-fill"
              style={{ width: `${Math.max(2, (row.count / max) * 100)}%`, background: row.color ?? color }}
            />
          </span>
          <span className="kiosk-bar-count">{formatCount(row.count)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A funnel drawn as full-width steps rather than a tapering trapezoid.
 *
 * The classic funnel shape encodes the same number twice (width and label) and
 * makes the last, smallest and most important step the hardest one to read.
 * Constant-width rows with a proportional fill keep the final step as legible
 * as the first, which is the step the board exists to make someone care about.
 */
export function FunnelSteps({
  steps,
}: {
  steps: { label: string; value: number; note?: string; reached?: boolean }[];
}) {
  const top = Math.max(1, ...steps.map((step) => step.value));
  return (
    <ol className="kiosk-funnel">
      {steps.map((step) => {
        const reached = step.reached ?? step.value > 0;
        return (
          <li key={step.label} className={reached ? 'is-reached' : 'is-pending'}>
            <span className="kiosk-funnel-fill" style={{ width: `${(step.value / top) * 100}%` }} />
            <span className="kiosk-funnel-label">
              {step.label}
              {/* Inline rather than on a line of its own. Each rung is a
                  flex share of the tile, so a second line has nowhere to go
                  and gets clipped by the row it is explaining. */}
              {step.note && <em className="kiosk-funnel-note">{step.note}</em>}
            </span>
            <span className="kiosk-funnel-value">{formatCount(step.value)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A capacity bar with a hard ceiling: how much of a fixed allowance is spent.
 * Thresholds are fractions of `max`, matching the desktop ProgressMeter so the
 * two surfaces never disagree about when a number turns amber.
 */
export function Gauge({
  value,
  max,
  unit,
  thresholds = { warn: 0.6, danger: 0.8 },
}: {
  value: number;
  max: number;
  unit: string;
  thresholds?: { warn: number; danger: number };
}) {
  const fraction = max > 0 ? Math.min(1, value / max) : 0;
  const level = fraction >= thresholds.danger ? 'danger' : fraction >= thresholds.warn ? 'warn' : 'ok';
  return (
    <div className="kiosk-gauge">
      <div className="kiosk-gauge-row">
        <span className="kiosk-gauge-value">{formatCount(value)}</span>
        <span className="kiosk-gauge-max">of {formatCount(max)} {unit}</span>
      </div>
      <div className={`kiosk-gauge-track is-${level}`}>
        <span className="kiosk-gauge-fill" style={{ width: `${fraction * 100}%` }} />
      </div>
    </div>
  );
}

/** Two to four small numbers under a headline. */
export function FactRow({ facts }: { facts: { label: string; value: string | number }[] }) {
  return (
    <dl className="kiosk-facts">
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{typeof fact.value === 'number' ? formatCount(fact.value) : fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A dead tile.
 *
 * The board is unattended, so a section that fails must say so in words. A
 * blank tile on a wall display reads as "zero", and zero is exactly the
 * reading that would send someone off to investigate a problem that is really
 * just a query that timed out.
 */
export function TileError({
  label,
  message,
  span,
  className,
}: {
  label: string;
  message: string;
  span?: number;
  className?: string;
}) {
  return (
    <Tile label={label} tone="bad" span={span} className={className}>
      <p className="kiosk-error">
        <strong>No data</strong>
        <span>{message}</span>
      </p>
    </Tile>
  );
}

export { NO_DATA };

/**
 * Grouped columns, drawn in HTML rather than SVG.
 *
 * An SVG chart on this board would have to be `preserveAspectRatio="none"` to
 * fill a tile whose height is a fraction of the viewport, and that stretches
 * every label and corner radius with it. Flex children sized in percentages
 * fill the same space and stay geometrically honest, and they reflow when the
 * board is opened on a laptop instead of on the panel.
 *
 * Bars are floored at a visible sliver rather than collapsed to nothing, so a
 * week with one signup is distinguishable from a week with two. Zero stays
 * genuinely empty: at this volume the difference between one and none is the
 * single most important thing the chart says.
 *
 * A bucket marked `partial` is a stretch of time still being lived: the
 * current calendar week, which is always short and always looks like a
 * collapse. It is drawn hollow and labelled "so far" rather than smoothed,
 * annualised or hidden, because every one of those is a way of showing a
 * number that is not the number. The scale deliberately still includes it: a
 * partial week that has ALREADY beaten a full one is the most encouraging
 * thing this chart can say, and clipping it would hide exactly that.
 */
export function GroupedColumns({
  buckets,
  series,
}: {
  buckets: { label: string; values: number[]; partial?: boolean }[];
  series: { name: string; color: string }[];
}) {
  const max = Math.max(1, ...buckets.flatMap((bucket) => bucket.values));
  // The tallest bar stops short of the top of the plot so the count printed
  // above it has somewhere to sit. Without the reserve it rides up into the
  // tile's own heading.
  const CEILING = 88;
  return (
    <div className="kiosk-chart">
      <div className="kiosk-cols" role="img" aria-label={`${series.map((entry) => entry.name).join(' and ')} by week`}>
        {buckets.map((bucket) => (
          <div className={`kiosk-col${bucket.partial ? ' is-partial' : ''}`} key={bucket.label}>
            <div className="kiosk-col-bars">
              {bucket.values.map((value, index) => (
                <span
                  key={series[index]?.name ?? index}
                  className="kiosk-col-bar"
                  style={{
                    height: value === 0 ? '0' : `${Math.max(4, (value / max) * CEILING)}%`,
                    // A partial bucket is outlined in its series colour rather
                    // than filled with it, so it reads as "not finished" from
                    // across the room without needing the label.
                    background: bucket.partial
                      ? `color-mix(in srgb, ${series[index]?.color ?? 'var(--kiosk-accent)'} 26%, transparent)`
                      : series[index]?.color ?? 'var(--kiosk-accent)',
                    borderTop: bucket.partial
                      ? `2px dashed ${series[index]?.color ?? 'var(--kiosk-accent)'}`
                      : undefined,
                  }}
                >
                  {value > 0 && <b>{formatCount(value)}</b>}
                </span>
              ))}
            </div>
            <span className="kiosk-col-label">
              {bucket.label}
              {bucket.partial && <i> so far</i>}
            </span>
          </div>
        ))}
      </div>
      <div className="kiosk-legend">
        {series.map((entry) => (
          <span key={entry.name}>
            <i style={{ background: entry.color }} />
            {entry.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * A short list of things that happened, newest first.
 *
 * The board's only non-numeric panel. Below the fold the same material is a
 * `.kiosk-table` at a fixed 13px, which is right at arm's length and unreadable
 * from the doorway; this is the version sized in `dvh` like everything else
 * above the fold, and it drops the columns that only make sense up close.
 *
 * `tone` is per row rather than per list because the one thing this panel must
 * never do is let an OPEN incident look like a closed one just because four
 * resolved rows sit above it.
 */
export function EventList({
  rows,
  emptyLabel = 'Nothing recorded yet',
}: {
  rows: { key: string; title: string; note?: string; when: string; tone?: 'bad' | 'warn' | 'default' }[];
  emptyLabel?: string;
}) {
  if (rows.length === 0) return <p className="kiosk-empty">{emptyLabel}</p>;
  return (
    <ul className="kiosk-events">
      {rows.map((row) => (
        <li key={row.key} className={`is-${row.tone ?? 'default'}`}>
          <span className="kiosk-event-title">{row.title}</span>
          {row.note && <span className="kiosk-event-note">{row.note}</span>}
          <span className="kiosk-event-when">{row.when}</span>
        </li>
      ))}
    </ul>
  );
}
