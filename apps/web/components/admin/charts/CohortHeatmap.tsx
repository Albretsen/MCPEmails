/**
 * CohortHeatmap.tsx: signup cohorts down the side, weeks since signup across
 * the top, retention in the cells.
 *
 * WHY it is a real <table> rather than a grid of SVG rects: a heatmap IS a
 * table. Rendering it as one gives keyboard navigation, row and column
 * headers, selectable text and a sane screen-reader reading order for free,
 * and the colour becomes what it should always have been, a second channel on
 * top of a number that is already printed. Nothing here is chart-only, so this
 * is the one component that passes no numbers table to ChartFrame.
 *
 * WHY cells prefer counts over percentages: the honesty rule. A cohort of
 * seven people cannot produce a meaningful "43%", so a row is given the
 * retained COUNT plus the cohort size and `ratio()` decides whether a
 * percentage is defensible. Callers holding percentages can pass `cells`
 * instead and the count is recovered from the cohort size.
 *
 * Missing data and genuine zero are different facts and must not look alike.
 * A cohort that signed up two weeks ago has no week-8 number yet (hatched and
 * empty), which is nothing like a cohort where everybody left (flat, "0").
 */

import { ChartFrame } from './ChartFrame';
import { clamp, ratio, share, slugify } from './format';

export type CohortRow = {
  /** Cohort identity, normally the week starting date such as "Jun 30". */
  label: string;
  /** How many workspaces joined in this cohort. The denominator for the row. */
  size: number;
  /**
   * Retained COUNT per week index. `null` means the week has not happened yet
   * for this cohort, which is rendered differently from a real zero.
   */
  values?: Array<number | null>;
  /** Percentages already scaled 0..100. Used only when `values` is absent. */
  cells?: Array<number | null>;
};

export type CohortHeatmapProps = {
  title: string;
  subtitle?: string;
  rows: CohortRow[];
  /** Force the number of week columns. Defaults to the widest row supplied. */
  weeks?: number;
  /** Column header prefix. Defaults to "W" so columns read W0, W1, W2. */
  columnPrefix?: string;
  footnote?: string;
};

/**
 * Percentage of brand colour mixed into the card surface.
 *
 * The range is 10 to 78, measured rather than guessed. It starts at 10 so a
 * live-but-low cell still reads as a filled cell rather than a hole, and it
 * stops at 78 because that is the last point where the page's own text colour
 * still clears 4.5:1 against the cell in BOTH themes. Pushing the ramp to full
 * brand would force white text on strong cells, which is fine on the dark
 * theme and fails badly on the light one in the middle of the range.
 */
function mixFor(fraction: number): number {
  return 10 + clamp(fraction, 0, 1) * 68;
}

type Cell = { missing: true } | { missing: false; retained: number; fraction: number };

function cellAt(row: CohortRow, index: number): Cell {
  if (row.values) {
    const raw = row.values[index];
    if (raw === null || raw === undefined || !Number.isFinite(raw)) return { missing: true };
    const retained = Math.max(0, raw);
    return { missing: false, retained, fraction: share(retained, row.size) };
  }
  const percent = row.cells?.[index];
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return { missing: true };
  const fraction = clamp(percent / 100, 0, 1);
  // Recover the count so the small-denominator rule still applies: the caller
  // computed this percentage from whole people, and at these cohort sizes
  // rounding back is exact.
  return { missing: false, retained: Math.round(fraction * row.size), fraction };
}

export function CohortHeatmap({ title, subtitle, rows, weeks, columnPrefix = 'W', footnote }: CohortHeatmapProps) {
  const width =
    weeks && weeks > 0
      ? weeks
      : rows.reduce((widest, row) => Math.max(widest, (row.values ?? row.cells ?? []).length), 0);

  if (rows.length === 0 || width === 0) {
    return (
      <ChartFrame title={title} subtitle={subtitle}>
        <p className="ac-empty">No cohorts in this window.</p>
      </ChartFrame>
    );
  }

  const columns = Array.from({ length: width }, (_, index) => index);
  const captionId = `ac-cohort-${slugify(title)}`;

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      footnote={footnote}
      legend={[
        { name: 'Higher retention', color: 'var(--brand)' },
        { name: 'Lower retention', color: 'var(--bg-sunken)' },
        { name: 'Week not reached yet', color: 'var(--border-2)', hatched: true },
      ]}
    >
      <div className="ac-scroll">
        <table className="ac-heatmap" aria-describedby={captionId}>
          <caption className="ac-visually-hidden" id={captionId}>
            {`${title}. Rows are signup cohorts with their size, columns are weeks since signup, cells are how many of that cohort were still active.`}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="ac-hm-corner">
                Cohort
              </th>
              <th scope="col" className="ac-hm-size">
                Size
              </th>
              {columns.map((index) => (
                <th scope="col" key={index}>
                  {`${columnPrefix}${index}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row" className="ac-hm-label">
                  {row.label}
                </th>
                <td className="ac-hm-size">{row.size}</td>
                {columns.map((index) => {
                  const cell = cellAt(row, index);
                  if (cell.missing) {
                    return <td className="ac-hm-cell ac-hm-empty" key={index} aria-label="not reached yet" />;
                  }
                  const mix = mixFor(cell.fraction);
                  return (
                    <td
                      className="ac-hm-cell"
                      key={index}
                      style={{ background: `color-mix(in oklab, var(--brand) ${mix.toFixed(0)}%, var(--bg-surface))` }}
                      title={`${row.label}, ${columnPrefix}${index}: ${cell.retained} of ${row.size} still active`}
                    >
                      {ratio(cell.retained, row.size)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartFrame>
  );
}

export default CohortHeatmap;
