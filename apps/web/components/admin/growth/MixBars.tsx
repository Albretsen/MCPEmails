/**
 * MixBars.tsx: a ranked "what is this made of" list. One row per category,
 * with a bar, the count and the share of the whole.
 *
 * WHY the tracks are a CONSTANT width with a proportional fill, rather than
 * bars of proportional width: a bar whose own length is the only thing
 * carrying the number gets shortest exactly where the reader most needs to
 * read it, and the label beside it starts drifting left as the tail tapers.
 * A fixed track keeps every count and share in the same two columns down the
 * card, so the tail stays scannable and the eye has a reference edge for how
 * much is missing.
 *
 * WHY the fill is measured against the TOTAL and not against the largest row:
 * the number printed beside it is the share of the total. Scaling the geometry
 * to the leader would make the top row full width while its label said 38%,
 * which is two different answers to the same question in one line. The cost is
 * that a genuinely even split draws eight short bars, which is what an even
 * split actually looks like.
 *
 * WHY one colour by default: rank is already encoded by order and by fill.
 * Walking the series palette down the rows would paint row five red, and red
 * on this page means "something is wrong", not "fifth". Callers who need the
 * rows to match a Donut beside them pass `color` per row.
 *
 * Synchronous Server Component. Hover detail is a native title attribute.
 */

import { ChartFrame, SERIES_COLORS, clamp, formatCount, ratio, share, type ChartTable } from '../charts';

/* Same reasoning as FunnelBars: index 0 is the brand colour, and it is the
   only one used unless a caller overrides it row by row. */
const BAR_COLOR = SERIES_COLORS[0];

export type MixRow = {
  name: string;
  value: number;
  /** Optional aside printed under the name, for example a definition. */
  note?: string;
  /** A `var(--token)` reference. Overrides the default single-colour fill. */
  color?: string;
};

export type MixBarsProps = {
  title: string;
  subtitle?: string;
  rows: MixRow[];
  /** Denominator for the share column. Defaults to the sum of the rows. */
  total?: number;
  /** Word for the count column, for example "inboxes". Defaults to "Count". */
  unit?: string;
  footnote?: string;
  emptyLabel?: string;
  /** Rows shown before the rest collapse into a details block. Default 8. */
  limit?: number;
};

const DEFAULT_LIMIT = 8;

type Ranked = MixRow & { value: number };

function rank(rows: MixRow[]): Ranked[] {
  return rows
    .map((row, index) => ({
      row: { ...row, value: Number.isFinite(row.value) ? Math.max(0, row.value) : 0 },
      index,
    }))
    // Ties keep the caller's order, which is usually already meaningful
    // (alphabetical, or the order the categories were defined in).
    .sort((a, b) => b.row.value - a.row.value || a.index - b.index)
    .map((entry) => entry.row);
}

function Row({ row, total }: { row: Ranked; total: number }) {
  const width = clamp(share(row.value, total) * 100, 0, 100);
  return (
    <li className="bd-mix-row">
      <span className="bd-mix-name" title={row.name}>
        {row.name}
        {row.note ? <span className="bd-mix-note">{row.note}</span> : null}
      </span>
      <span className="bd-mix-track" aria-hidden="true">
        {width > 0 ? (
          <span className="bd-mix-fill" style={{ width: `${width}%`, background: row.color ?? BAR_COLOR }} />
        ) : null}
      </span>
      <span className="bd-mix-count">{formatCount(row.value)}</span>
      <span className="bd-mix-share">{ratio(row.value, total)}</span>
    </li>
  );
}

export function MixBars({
  title,
  subtitle,
  rows,
  total,
  unit,
  footnote,
  emptyLabel = 'Nothing recorded yet',
  limit = DEFAULT_LIMIT,
}: MixBarsProps) {
  const ranked = rank(rows);
  const sum = ranked.reduce((running, row) => running + row.value, 0);
  const denominator = typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : sum;

  if (ranked.length === 0 || denominator <= 0) {
    return (
      <ChartFrame title={title} subtitle={subtitle} footnote={footnote}>
        <p className="ac-empty">{emptyLabel}</p>
      </ChartFrame>
    );
  }

  const hasNotes = ranked.some((row) => Boolean(row.note));
  const table: ChartTable = {
    columns: hasNotes ? ['Name', unit ?? 'Count', 'Share', 'Note'] : ['Name', unit ?? 'Count', 'Share'],
    rows: ranked.map((row) =>
      hasNotes
        ? [row.name, formatCount(row.value), ratio(row.value, denominator), row.note ?? '']
        : [row.name, formatCount(row.value), ratio(row.value, denominator)],
    ),
  };

  const cut = Math.max(1, Math.floor(limit));
  const visible = ranked.slice(0, cut);
  const hidden = ranked.slice(cut);

  return (
    <ChartFrame title={title} subtitle={subtitle} table={table} footnote={footnote}>
      <ol className="bd-mix">
        {visible.map((row) => (
          <Row key={row.name} row={row} total={denominator} />
        ))}
      </ol>

      {hidden.length > 0 ? (
        <details className="ac-details bd-mix-more">
          <summary className="ac-summary">{`${formatCount(hidden.length)} smaller, hidden`}</summary>
          <ol className="bd-mix">
            {hidden.map((row) => (
              <Row key={row.name} row={row} total={denominator} />
            ))}
          </ol>
        </details>
      ) : null}
    </ChartFrame>
  );
}

export default MixBars;
