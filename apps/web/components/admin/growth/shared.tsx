/**
 * Shared building blocks for the /admin/growth sections.
 *
 * Server components only. Anything interactive (the metric drill-down) lives
 * in `components/admin/MetricCard.tsx`, which wraps `StatBlock` rather than
 * replacing it, so a card that has a drill-down and one that does not render
 * identically.
 */

import type { ReactNode } from 'react';
import { Sparkline, formatCount, ratio } from '../charts';
import { InfoDot, SectionHeading } from '../InfoDot';
import { deltaTone, type GoodDirection } from '@/lib/analytics/growth-metrics';

/**
 * A failed section. The page streams sections independently, so a broken
 * query must degrade to one visibly dead panel and never to a blank page or a
 * silently missing section (a missing section reads as "zero", which is a
 * dangerous thing for a metrics page to imply).
 */
export function SectionError({ title, message }: { title: string; message: string }) {
  return (
    <section className="growth-section">
      <h2>{title}</h2>
      <div className="growth-error">
        <strong>This section could not load.</strong>
        <code>{message}</code>
      </div>
    </section>
  );
}

/** The inner content of a stat card. Rendered inside a div, or inside a button when clickable. */
export function StatBlock({
  label,
  value,
  detail,
  explain,
  delta,
  spark,
  target,
}: {
  label: string;
  value: string | number;
  /** One short line. Anything longer belongs in `explain`. */
  detail: string;
  /** The definition, behind a question mark next to the label. */
  explain?: ReactNode;
  /** Percentage change against the previous equivalent period. */
  delta?: { percent: number; goodDirection: GoodDirection };
  /** Trailing series for the sparkline, oldest first. */
  spark?: number[];
  target?: string;
}) {
  const tone = delta ? deltaTone(delta.percent, delta.goodDirection) : null;
  return (
    <>
      <div className="growth-stat-label">
        {label}
        {explain && <InfoDot label={label}>{explain}</InfoDot>}
      </div>
      <div className="growth-stat-value">
        <span>{typeof value === 'number' ? formatCount(value) : value}</span>
        {delta && tone && (
          <span className={`growth-delta is-${tone}`}>
            {delta.percent > 0 ? '▲' : delta.percent < 0 ? '▼' : '='} {Math.abs(Math.round(delta.percent))}%
          </span>
        )}
      </div>
      <div className="growth-stat-detail">{detail}</div>
      {target && <div className="growth-stat-target">{target}</div>}
      {spark && spark.length > 1 && (
        <div className="growth-stat-spark"><Sparkline values={spark} label={`${label} trend`} /></div>
      )}
    </>
  );
}

/** A non-clickable stat card, for numbers that have no meaningful history. */
export function StatCard(props: Parameters<typeof StatBlock>[0]) {
  return <div className="growth-stat"><StatBlock {...props} /></div>;
}

/**
 * A labelled horizontal bar list: provider mix, client mix, plan mix.
 *
 * Deliberately not one of the chart primitives. This is a ranked list that
 * happens to draw a bar, it has no axis and no time dimension, and keeping it
 * as plain markup means it reflows and truncates like text rather than
 * scaling like an SVG.
 */
export function MixBars({
  title,
  unit,
  rows,
  emptyLabel = 'No data recorded yet.',
}: {
  title: string;
  unit: string;
  rows: { name: string; count: number }[];
  emptyLabel?: string;
}) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <div className="growth-panel">
      <div className="growth-mix-head"><h3>{title}</h3><span>{unit}</span></div>
      {rows.length === 0 && <p className="growth-note">{emptyLabel}</p>}
      <ul className="growth-mix">
        {rows.map((row) => (
          <li key={row.name}>
            <span className="growth-mix-name">{row.name}</span>
            <span className="growth-mix-bar" aria-hidden="true">
              <span style={{ width: `${(row.count / max) * 100}%` }} />
            </span>
            <span className="growth-mix-count">{formatCount(row.count)}</span>
            <span className="growth-mix-share">{ratio(row.count, total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Section wrapper. The explanation goes behind the heading's question mark
 * rather than on the page: see InfoDot for why. `aside` is for the rare line
 * that has to stay visible, such as an active warning.
 */
export function Section({
  id,
  title,
  explain,
  aside,
  children,
}: {
  /**
   * Anchor for the page's section nav. Optional so a section that is not in
   * the nav does not have to invent one, but every section the nav lists must
   * pass the id the nav links to: a jump link to a missing anchor silently
   * does nothing, which is the worst failure a nav can have.
   */
  id?: string;
  title: string;
  explain: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    // `scroll-margin-top` (see admin-growth.css) keeps the sticky nav from
    // covering the heading it just jumped to.
    <section className="growth-section" id={id}>
      <SectionHeading title={title} aside={aside}>{explain}</SectionHeading>
      {children}
    </section>
  );
}
