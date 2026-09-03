/**
 * Donut.tsx: a composition of a single whole, drawn as one ring.
 *
 * WHY a donut here when the rest of this kit is bars: the question this card
 * answers is "what is the ONE hundred percent made of", and the hole in the
 * middle is where the total goes, so the part and the whole are read in one
 * look. It is deliberately the only round chart on the board, and it is never
 * used for comparing categories across time (bars do that better and
 * MixBars is right next door).
 *
 * WHY this SVG keeps its aspect ratio while every chart in components/admin/
 * charts sets preserveAspectRatio="none": those are stretched into whatever
 * box they land in because a bar does not care about being wider than it is
 * tall. A circle does. Stretching this one turns the ring into an ellipse and
 * makes equal slices look unequal, which is the one thing a pie must never do.
 * The consequence is that the centre text lives in HTML on top of the SVG
 * rather than in <text>, so it stays the same size at any card width.
 *
 * Two degenerate cases are handled explicitly because the arithmetic is where
 * donuts usually break: a single slice at 100% must draw a CLOSED ring (dash
 * array of the full circumference and a zero gap), and a slice of 0 must draw
 * NOTHING. A zero-length dash with a full-circumference gap is visually
 * nothing but still a rendered element, and with a round line cap it shows up
 * as a stray dot, so zero slices are skipped outright.
 *
 * Synchronous Server Component. Each arc carries a native <title>.
 */

import { ChartFrame, seriesColor, formatCount, ratio, share, type ChartTable } from '../charts';

export type DonutSlice = {
  name: string;
  value: number;
  /** A `var(--token)` reference. Defaults to this slice's series colour. */
  color?: string;
};

export type DonutProps = {
  title: string;
  subtitle?: string;
  slices: DonutSlice[];
  /** Pre-formatted. Defaults to the total count across every slice. */
  centerValue?: string;
  centerLabel?: string;
  footnote?: string;
  emptyLabel?: string;
};

const RADIUS = 38;
const STROKE = 16;
const CENTER = 50;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * How many real slices survive before the tail is folded into "Other".
 *
 * Six is the length of the series palette. A seventh slice would wrap back to
 * the brand colour and two different things on one ring would be the same
 * blue, so the tail gets a neutral grey of its own instead of a palette entry.
 * The full unaggregated list is still in the frame's numbers table.
 */
const MAX_SLICES = 6;
const OTHER_COLOR = 'var(--border-2)';

type Wedge = { name: string; value: number; color: string };

function build(slices: DonutSlice[]): Wedge[] {
  const clean = slices
    .map((slice, index) => ({
      slice: { ...slice, value: Number.isFinite(slice.value) ? Math.max(0, slice.value) : 0 },
      index,
    }))
    .sort((a, b) => b.slice.value - a.slice.value || a.index - b.index)
    .map((entry) => entry.slice);

  const head = clean.slice(0, MAX_SLICES).map((slice, index) => ({
    name: slice.name,
    value: slice.value,
    color: slice.color ?? seriesColor(index),
  }));

  const tail = clean.slice(MAX_SLICES);
  if (tail.length === 0) return head;
  return [
    ...head,
    { name: 'Other', value: tail.reduce((sum, slice) => sum + slice.value, 0), color: OTHER_COLOR },
  ];
}

export function Donut({
  title,
  subtitle,
  slices,
  centerValue,
  centerLabel,
  footnote,
  emptyLabel = 'Nothing recorded yet',
}: DonutProps) {
  const wedges = build(slices);
  const total = wedges.reduce((sum, wedge) => sum + wedge.value, 0);

  if (wedges.length === 0 || total <= 0) {
    return (
      <ChartFrame title={title} subtitle={subtitle} footnote={footnote}>
        <p className="ac-empty">{emptyLabel}</p>
      </ChartFrame>
    );
  }

  const table: ChartTable = {
    columns: ['Slice', 'Count', 'Share'],
    rows: slices
      .map((slice) => ({ ...slice, value: Number.isFinite(slice.value) ? Math.max(0, slice.value) : 0 }))
      .sort((a, b) => b.value - a.value)
      .map((slice) => [slice.name, formatCount(slice.value), ratio(slice.value, total)]),
  };

  // Arcs are laid down head to tail around the ring, each one offset by every
  // length that came before it. Offsets accumulate in circumference units, not
  // in degrees, because that is the unit stroke-dasharray speaks. The offset is
  // recomputed as a prefix sum rather than carried in a running variable: at
  // seven wedges the extra passes are free, and nothing in a render body
  // reassigns across elements.
  const lengths = wedges.map((wedge) => share(wedge.value, total) * CIRCUMFERENCE);
  const arcs = wedges.map((wedge, index) => ({
    wedge,
    length: lengths[index],
    offset: lengths.slice(0, index).reduce((sum, part) => sum + part, 0),
  }));

  return (
    <ChartFrame title={title} subtitle={subtitle} table={table} footnote={footnote}>
      <div className="bd-donut">
        <div className="bd-donut-figure">
          <svg className="bd-donut-svg" viewBox="0 0 100 100" role="img" aria-label={`${title}: ${wedges.length} slices`}>
            <circle
              className="bd-donut-track"
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              strokeWidth={STROKE}
              fill="none"
            />
            {/* Rotating the whole group is what puts the first slice at twelve
                o'clock. Rotating each arc separately drifts by a fraction of a
                degree per slice and leaves hairline gaps in the ring. */}
            <g transform={`rotate(-90 ${CENTER} ${CENTER})`}>
              {arcs.map(({ wedge, length, offset }, index) =>
                length > 0 ? (
                  <circle
                    className="bd-donut-arc"
                    key={`${wedge.name}-${index}`}
                    cx={CENTER}
                    cy={CENTER}
                    r={RADIUS}
                    fill="none"
                    strokeWidth={STROKE}
                    stroke={wedge.color}
                    strokeDasharray={`${length.toFixed(3)} ${Math.max(0, CIRCUMFERENCE - length).toFixed(3)}`}
                    strokeDashoffset={(-offset).toFixed(3)}
                  >
                    <title>{`${wedge.name}: ${formatCount(wedge.value)} of ${formatCount(total)} (${ratio(wedge.value, total)})`}</title>
                  </circle>
                ) : null,
              )}
            </g>
          </svg>
          <div className="bd-donut-center" aria-hidden="true">
            <span className="bd-donut-center-value">{centerValue ?? formatCount(total)}</span>
            {centerLabel ? <span className="bd-donut-center-label">{centerLabel}</span> : null}
          </div>
        </div>

        <ul className="bd-donut-legend">
          {wedges.map((wedge, index) => (
            <li className="bd-donut-item" key={`${wedge.name}-${index}`}>
              <span
                className="ac-swatch"
                style={{ background: wedge.color, borderColor: wedge.color }}
                aria-hidden="true"
              />
              <span className="bd-donut-name" title={wedge.name}>
                {wedge.name}
              </span>
              <span className="bd-donut-count">{formatCount(wedge.value)}</span>
              <span className="bd-donut-share">{ratio(wedge.value, total)}</span>
            </li>
          ))}
        </ul>
      </div>
    </ChartFrame>
  );
}

export default Donut;
