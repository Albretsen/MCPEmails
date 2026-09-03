/**
 * CalendarHeat.tsx: a contribution grid. Columns are ISO weeks, rows are the
 * seven weekdays, each cell is one UTC day.
 *
 * WHY a calendar and not the daily bar chart that already exists: a bar chart
 * answers "how much", a calendar answers "when, and how often". Weekday
 * rhythm, holiday gaps and dead streaks are the shape of this data, and they
 * are invisible in a 180-bar smear but obvious as rows and columns.
 *
 * THE DISTINCTION THAT MATTERS: a day with a count of zero and a day with no
 * data at all are different facts and must not look alike. A zero day draws a
 * faint track, which is a statement that nothing happened. A day the series
 * does not cover, or a day in the future, draws NOTHING, because we do not
 * know. Same rule as CohortHeatmap. Getting this wrong makes a broken query
 * look like a quiet fortnight.
 *
 * WHY the window is anchored on the LAST day in the series rather than on
 * `new Date()`: this is a Server Component, and reading the wall clock at
 * render time makes the output non-deterministic, uncacheable, and off by a
 * day for anyone whose local date has rolled past UTC. The series already
 * knows where it ends.
 *
 * WHY this SVG preserves its aspect ratio (unlike the stretched plots in
 * components/admin/charts): the cells are SQUARES. Stretching them into
 * rectangles would make the same count look different in a narrow card, so the
 * grid is drawn at its natural size and capped with max-width, which means it
 * only ever shrinks. That in turn is why the axis labels are <text> here
 * rather than positioned HTML: they scale with the cells they label.
 *
 * The Monday-of-week arithmetic is a deliberate COPY of `mondayOf` in
 * components/admin/kiosk/shared.ts, not an import. The kiosk is a separate
 * deployment target with its own data contract, and this folder must not grow
 * a dependency on it just to share nine lines of date maths.
 */

import { ChartFrame, clamp, formatCount, share, type ChartTable } from '../charts';

export type HeatDay = {
  /** UTC day key, `YYYY-MM-DD`. */
  day: string;
  count: number;
};

export type CalendarHeatProps = {
  title: string;
  subtitle?: string;
  /** May be unsorted and may have gaps. Duplicate days are summed. */
  days: HeatDay[];
  /** Trailing weeks to draw. Default 26, about half a year. */
  weeks?: number;
  footnote?: string;
  /** Word for the tooltip, for example "signups". Default "events". */
  unit?: string;
};

const DAY_MS = 86_400_000;
const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP;
/** Room for the Mon/Wed/Fri labels down the side. */
const GUTTER = 26;
/** Room for the month labels along the top. */
const HEADER = 15;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const FULL_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });

/** The UTC Monday on or before a `YYYY-MM-DD` day key. */
function mondayOf(dayKey: string): string {
  const date = new Date(`${dayKey}T00:00:00Z`);
  // getUTCDay is 0 for Sunday. Shifting so Monday reads 0 and Sunday reads 6
  // is the whole difference between an ISO week and a US one, and it is the
  // single most common way this function is written wrong.
  const offset = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Four filled steps plus the zero track. Percentages of --brand mixed into
 * transparent, so the cell sits on whatever surface the card is using and both
 * themes come out of the same declaration. The bottom filled step is 28 rather
 * than something smaller so a one-event day still reads as a filled cell next
 * to a zero day rather than as a slightly dirty one.
 */
const LEVEL_MIX = [28, 48, 70, 100];

function levelOf(count: number, max: number): number {
  if (count <= 0) return 0;
  return clamp(Math.ceil(share(count, max) * LEVEL_MIX.length), 1, LEVEL_MIX.length);
}

function fillFor(level: number): string {
  if (level <= 0) return 'var(--bg-sunken)';
  return `color-mix(in srgb, var(--brand) ${LEVEL_MIX[level - 1]}%, transparent)`;
}

export function CalendarHeat({
  title,
  subtitle,
  days,
  weeks = 26,
  footnote,
  unit = 'events',
}: CalendarHeatProps) {
  const counts = new Map<string, number>();
  for (const entry of days) {
    const key = typeof entry.day === 'string' ? entry.day.slice(0, 10) : '';
    if (!DAY_KEY.test(key) || !Number.isFinite(entry.count)) continue;
    counts.set(key, (counts.get(key) ?? 0) + Math.max(0, entry.count));
  }

  const span = Math.max(1, Math.floor(weeks));
  const keys = [...counts.keys()].sort();

  if (keys.length === 0) {
    return (
      <ChartFrame title={title} subtitle={subtitle} footnote={footnote}>
        <p className="ac-empty">Nothing recorded yet.</p>
      </ChartFrame>
    );
  }

  const anchor = keys[keys.length - 1];
  const lastMonday = Date.parse(`${mondayOf(anchor)}T00:00:00Z`);
  const firstMonday = lastMonday - (span - 1) * 7 * DAY_MS;
  const anchorMs = Date.parse(`${anchor}T00:00:00Z`);

  const width = GUTTER + span * STEP;
  const height = HEADER + 7 * STEP;

  const columns = Array.from({ length: span }, (_, index) => index);
  const inWindow = keys.filter((key) => Date.parse(`${key}T00:00:00Z`) >= firstMonday);
  const max = inWindow.reduce((highest, key) => Math.max(highest, counts.get(key) ?? 0), 0);

  // Month labels are placed where the month CHANGES, and never within three
  // columns of the previous label, because "Aug" and "Sep" three pixels apart
  // is worse than one of them being missing.
  const monthLabels: Array<{ column: number; text: string }> = [];
  let lastLabelled = -99;
  let previousMonth = '';
  for (const column of columns) {
    const monday = new Date(firstMonday + column * 7 * DAY_MS);
    const month = monday.toISOString().slice(5, 7);
    const changed = column === 0 || month !== previousMonth;
    previousMonth = month;
    if (!changed || column - lastLabelled < 3 || column > span - 2) continue;
    monthLabels.push({ column, text: MONTH.format(monday) });
    lastLabelled = column;
  }

  const table: ChartTable = {
    columns: ['Day', unit.charAt(0).toUpperCase() + unit.slice(1)],
    rows: inWindow.map((key) => [FULL_DATE.format(new Date(`${key}T00:00:00Z`)), formatCount(counts.get(key) ?? 0)]),
    summary: 'Exact numbers by day',
  };

  const weekdayRows = [
    { row: 0, text: 'Mon' },
    { row: 2, text: 'Wed' },
    { row: 4, text: 'Fri' },
  ];

  return (
    <ChartFrame title={title} subtitle={subtitle} table={table} footnote={footnote}>
      <div className="bd-heat ac-scroll">
        <svg
          className="bd-heat-svg"
          viewBox={`0 0 ${width} ${height}`}
          style={{ maxWidth: width }}
          role="img"
          aria-label={`${title}: ${unit} per day over the last ${span} weeks, one square per day.`}
        >
          {monthLabels.map((label) => (
            <text className="bd-heat-axis" key={label.column} x={GUTTER + label.column * STEP} y={HEADER - 5}>
              {label.text}
            </text>
          ))}

          {weekdayRows.map((weekday) => (
            <text
              className="bd-heat-axis bd-heat-axis-end"
              key={weekday.text}
              x={GUTTER - 6}
              y={HEADER + weekday.row * STEP + CELL - 2}
            >
              {weekday.text}
            </text>
          ))}

          {columns.map((column) =>
            Array.from({ length: 7 }, (_, row) => {
              const time = firstMonday + (column * 7 + row) * DAY_MS;
              // Anything after the last day the series covers is unknown, not
              // zero, so it is simply not drawn.
              if (time > anchorMs) return null;
              const key = new Date(time).toISOString().slice(0, 10);
              const count = counts.get(key);
              if (count === undefined) return null;
              const level = levelOf(count, max);
              return (
                <rect
                  className="bd-heat-cell"
                  key={key}
                  x={GUTTER + column * STEP}
                  y={HEADER + row * STEP}
                  width={CELL}
                  height={CELL}
                  rx={2.5}
                  fill={fillFor(level)}
                >
                  <title>{`${formatCount(count)} ${unit} on ${FULL_DATE.format(new Date(time))}`}</title>
                </rect>
              );
            }),
          )}
        </svg>
      </div>

      <p className="bd-heat-legend">
        <span className="bd-heat-legend-label">Less</span>
        <span className="bd-heat-keys" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((level) => (
            <span className="bd-heat-key" key={level} style={{ background: fillFor(level) }} />
          ))}
        </span>
        <span className="bd-heat-legend-label">More</span>
        <span className="bd-heat-legend-note">{`Leftmost square is a day with no ${unit}. Days outside the series are blank.`}</span>
      </p>
    </ChartFrame>
  );
}

export default CalendarHeat;
