/**
 * KpiTile.tsx: one headline number on the growth board, with its movement.
 *
 * WHY the delta chip goes GREY under two percent instead of green or red:
 * this product has six paying customers. One of them churning is a 17% drop;
 * one signing up is a 20% rise. If every chip is a saturated colour then the
 * colour stops meaning "look at this" within a day of reading the board, and
 * the reader trains themselves to skip it. So small moves are stated in plain
 * grey and the colour is reserved for movement large enough that a single
 * person cannot have caused it on their own.
 *
 * The obvious alternative, dropping the chip entirely below the threshold, was
 * rejected: the number still moved and hiding it makes a flat quarter and a
 * quarter of small steady gains look identical.
 *
 * `tone` tints the LEFT EDGE only, never the value. --mint-500, --amber-500
 * and --red-500 sit at roughly 2:1 against the page, which is fine for a solid
 * fill and unreadable as 30px type, so the number always stays --fg-1.
 *
 * Synchronous Server Component: no state, no handlers, no client JavaScript.
 * This file is also the one that imports admin-board-parts.css, the same way
 * ChartFrame owns the import for the charts kit, so a page that renders any of
 * these parts gets the stylesheet without six duplicate imports.
 */

import type { ReactNode } from 'react';
import { Sparkline } from '../charts';
import '../../../styles/admin-board-parts.css';

export type KpiDelta = {
  /** Already a percentage (12 means twelve percent), signed by direction. */
  percent: number;
  /** Which way is the good way for THIS metric. Churn is 'down'. */
  goodDirection: 'up' | 'down';
};

export type KpiTileProps = {
  /** Small uppercase label, for example "Paying customers". */
  label: string;
  /** Pre-formatted by the caller: "$35", "339", "97.1%". */
  value: string;
  /** Small suffix beside the value, for example "/mo" or "of 100". */
  unit?: string;
  /** Movement chip. `null` or omitted renders nothing at all. */
  delta?: KpiDelta | null;
  /** One short line under the value. */
  caption?: ReactNode;
  /** Optional trend under the caption. Drawn by the shared Sparkline. */
  spark?: number[];
  /** A `var(--token)` reference for the sparkline. Defaults to the brand. */
  sparkColor?: string;
  /** Tints the left edge. Never touches the type. */
  tone?: 'default' | 'good' | 'warn' | 'bad';
};

/**
 * Movement smaller than this (in percentage points) is reported without
 * colour. Two points is deliberately low as a threshold and deliberately high
 * as a signal: at these volumes almost nothing real moves by less than two
 * percent, so anything under it is rounding, seasonality or one person.
 */
const NEUTRAL_BAND = 2;

type DeltaLook = { className: string; symbol: string; meaning: string };

function lookFor(delta: KpiDelta): DeltaLook {
  const size = Math.abs(delta.percent);
  const symbol = delta.percent > 0 ? '▲' : delta.percent < 0 ? '▼' : '▪';
  if (size < NEUTRAL_BAND) {
    return { className: 'bd-kpi-delta-flat', symbol, meaning: 'roughly flat' };
  }
  const rose = delta.percent > 0;
  const good = rose === (delta.goodDirection === 'up');
  return {
    className: good ? 'bd-kpi-delta-good' : 'bd-kpi-delta-bad',
    symbol,
    meaning: good ? 'moving the right way' : 'moving the wrong way',
  };
}

export function KpiTile({
  label,
  value,
  unit,
  delta,
  caption,
  spark,
  sparkColor,
  tone = 'default',
}: KpiTileProps) {
  const showDelta = delta && Number.isFinite(delta.percent);
  const look = showDelta ? lookFor(delta) : null;
  const size = showDelta ? Math.round(Math.abs(delta.percent)) : 0;

  return (
    <div className={`ac-card bd-kpi bd-kpi-${tone}`}>
      <p className="bd-kpi-label">{label}</p>

      <p className="bd-kpi-row">
        <span className="bd-kpi-value">{value}</span>
        {unit ? <span className="bd-kpi-unit">{unit}</span> : null}
        {showDelta && look ? (
          <span
            className={`bd-kpi-delta ${look.className}`}
            title={`${label}: ${size}% versus the previous period, ${look.meaning}.`}
          >
            <span aria-hidden="true">{look.symbol}</span>
            {`${size}%`}
          </span>
        ) : null}
      </p>

      {caption ? <div className="bd-kpi-caption">{caption}</div> : null}

      {spark && spark.length > 0 ? (
        <div className="bd-kpi-spark">
          <Sparkline values={spark} label={label} color={sparkColor} />
        </div>
      ) : null}
    </div>
  );
}

export default KpiTile;
