/**
 * The primitives every region of /admin/growth is built from.
 *
 * THE PAGE IS A SHEET, NOT A FIELD OF CARDS, and that is the one decision
 * these primitives exist to enforce. Two previous designs of this page opened
 * with a strip of bordered stat cards and continued as a stack of bordered
 * section cards, and both were called messy. A card is a container that says
 * "this number is separate from that one", and on a page whose entire point is
 * that the numbers explain each other, drawing forty of those boundaries is
 * the mess. So there is no `Card` here. Regions are separated by a hairline
 * rule and a lot of vertical space, columns by a hairline and nothing else,
 * and the only borders below that level are the ones inside a table.
 *
 * The other rule is that SIZE IS THE HIERARCHY. `Display` is used exactly once
 * on the page (MRR). `Lead` is for the handful of numbers that anchor a region.
 * `Figure` is everything else. A number that cannot be assigned one of those
 * three is a number that has not been thought about, and it is what produced
 * six equally weighted cards last time.
 *
 * Everything here is a synchronous Server Component taking plain data, with no
 * fetching of its own. That is what lets the whole presentation layer be
 * rendered to static HTML by a harness script, which is the only way to check
 * this page's layout without an ADMIN_EMAILS session against production.
 */

import type { ReactNode } from 'react';
import { NO_DATA } from '../charts/format';

/**
 * One region of the sheet.
 *
 * The heading is a QUESTION, not a category. "Revenue" is a filing cabinet and
 * tells a reader nothing about whether to look; "How much are we paid, and
 * what changed" is the thing they came to find out. The kiosk names its five
 * views the same way, and it is the part of the kiosk that works.
 */
export function Region({
  question,
  note,
  children,
}: {
  question: string;
  /** The window, the source, and whatever the region as a whole excludes. */
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="br-region">
      <header className="br-region-head">
        <h2>{question}</h2>
        {note && <p>{note}</p>}
      </header>
      {children}
    </section>
  );
}

/** A label above a number. Small, upper case, never competing with the figure. */
export function Label({ children }: { children: ReactNode }) {
  return <p className="br-label">{children}</p>;
}

/**
 * The one display-size number on the page.
 *
 * Deliberately a separate component from `Lead` rather than a size prop, so
 * that adding a second display-size number to the page is a visible act
 * somebody has to justify in review rather than a character change.
 */
export function Display({ value, unit, title }: { value: string; unit?: string; title?: string }) {
  return (
    <p className="br-display" title={title}>
      {value}
      {unit && <span className="br-display-unit">{unit}</span>}
    </p>
  );
}

/** The number that anchors a region or a column. */
export function Lead({ value, unit }: { value: string | number; unit?: ReactNode }) {
  return (
    <p className="br-lead">
      {typeof value === 'number' ? value.toLocaleString('en-US') : value}
      {unit && <span className="br-lead-unit">{unit}</span>}
    </p>
  );
}

/** A supporting sentence under a number. Grey, small, allowed to be long. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="br-note">{children}</p>;
}

/**
 * A dead panel.
 *
 * A failed read must degrade to a panel that says so, never to a missing one.
 * A missing panel reads as a zero, and a zero next to revenue sends somebody
 * off to investigate a query timeout as a collapse in demand. Same argument as
 * the kiosk's TileError, and the same reason it prints the raw error: this page
 * is operator-only, and a vague "something went wrong" just costs a debugging
 * session.
 */
export function Dead({ what, error }: { what: string; error: string }) {
  return (
    <div className="br-dead" role="status">
      <p className="br-dead-head">{what} could not be read</p>
      <p className="br-dead-why">{error}</p>
    </div>
  );
}

/**
 * A horizontal bar in a list of them: providers, channels, error codes.
 *
 * Constant width with a proportional fill rather than a proportional width,
 * for the reason the kiosk's funnel gives: a tapering shape encodes the same
 * number twice and makes the smallest, most important row the hardest to read.
 */
export function BarRow({
  name,
  value,
  max,
  right,
  tone = 'brand',
}: {
  name: ReactNode;
  value: number;
  max: number;
  /** Right-hand column: usually a `ratio()` string. */
  right?: ReactNode;
  tone?: 'brand' | 'mint' | 'amber' | 'red' | 'muted';
}) {
  const width = max > 0 ? Math.max(1.5, (value / max) * 100) : 0;
  return (
    <li className="br-bar">
      <span className="br-bar-name">{name}</span>
      <span className="br-bar-track">
        <span className={`br-bar-fill is-${tone}`} style={{ width: `${width}%` }} />
      </span>
      <span className="br-bar-value">{value.toLocaleString('en-US')}</span>
      <span className="br-bar-right">{right ?? ''}</span>
    </li>
  );
}

/**
 * A capacity bar against a hard ceiling somebody else set.
 *
 * Thresholds are passed in as a level rather than computed here: the only
 * capacity on this page is Google's OAuth cap, and its level is decided by
 * TIME as well as by count (see `gmailCapProjection`). Recomputing it from the
 * fraction would quietly disagree with the sentence printed beside it.
 */
export function Meter({ value, max, level }: { value: number; max: number; level: 'ok' | 'warn' | 'danger' }) {
  const fraction = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div className={`br-meter is-${level}`}>
      <span className="br-meter-fill" style={{ width: `${fraction * 100}%` }} />
    </div>
  );
}

/**
 * A month-by-month strip of tiny columns.
 *
 * Not a `LineChart`. The cash series is nine points of lumpy, mostly-zero data
 * where a single annual payment is one tall bar; a line drawn through that
 * implies a trajectory between the points that does not exist.
 */
export function MonthBars({
  months,
  format,
}: {
  months: { month: string; value: number }[];
  format: (value: number) => string;
}) {
  if (months.length === 0) return <p className="br-empty">No months recorded yet</p>;
  const max = Math.max(1, ...months.map((entry) => entry.value));
  return (
    <ol className="br-months">
      {months.map((entry) => (
        <li key={entry.month}>
          <span className="br-month-bar" style={{ height: `${Math.max(2, (entry.value / max) * 100)}%` }}>
            <b>{format(entry.value)}</b>
          </span>
          <span className="br-month-label">{monthLabel(entry.month)}</span>
        </li>
      ))}
    </ol>
  );
}

/** `2026-08-01` as `Aug`. Fixed to UTC, like every other day key on this page. */
function monthLabel(key: string): string {
  const parsed = new Date(`${key.slice(0, 7)}-01T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return key;
  return MONTH_FORMAT.format(parsed);
}

const MONTH_FORMAT = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });

/** A small definition list: two to six facts that belong together. */
export function Facts({ rows }: { rows: { label: ReactNode; value: ReactNode; note?: ReactNode }[] }) {
  return (
    <dl className="br-facts">
      {rows.map((row, index) => (
        <div key={index}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
          {row.note && <p>{row.note}</p>}
        </div>
      ))}
    </dl>
  );
}

/** Placeholder for a value we genuinely do not have, so it is never a zero. */
export { NO_DATA };
