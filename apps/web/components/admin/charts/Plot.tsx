/**
 * Plot.tsx: internal plot surface shared by BarSeries and LineChart.
 *
 * WHY the split between SVG and HTML: the marks (bars, lines, gridlines) live
 * in an SVG whose viewBox is 0..100 on both axes with
 * `preserveAspectRatio="none"`, so the browser stretches them to whatever
 * width the card happens to be. Every axis LABEL, however, is plain HTML
 * positioned by percentage on top of that box. Text inside a stretched SVG
 * would be squashed horizontally and would scale from illegible at 320px to
 * oversized at 1400px, which is exactly the failure mode these cards have to
 * survive. Strokes keep their one-pixel weight via `vector-effect`.
 *
 * Not exported from the barrel: BarSeries and LineChart are the public API.
 */

import type { ReactNode } from 'react';

export type YTick = { value: number; label: string; y: number };
export type XTick = { index: number; label: string; x: number; align: 'start' | 'center' | 'end' };

/**
 * Builds an x tick, choosing an alignment that keeps the label inside the
 * plot. Centred is what you want everywhere except the two ends, where half a
 * date label would hang over the y axis gutter or off the edge of the card.
 */
export function tickAt(index: number, label: string, x: number): XTick {
  return { index, label, x, align: x < 5 ? 'start' : x > 95 ? 'end' : 'center' };
}

export type PlotProps = {
  /** Plot height in CSS pixels. Width always follows the container. */
  height: number;
  yTicks: YTick[];
  xTicks: XTick[];
  /** Element id of the <title> inside the SVG, for aria-labelledby. */
  titleId: string;
  /** Sentence read by screen readers in place of the picture. */
  title: string;
  /** SVG marks drawn in the 0..100 coordinate space. */
  children: ReactNode;
  /** Absolutely positioned HTML overlays, for example a threshold tag. */
  overlay?: ReactNode;
};

export function Plot({ height, yTicks, xTicks, titleId, title, children, overlay }: PlotProps) {
  return (
    <div className="ac-plot">
      <div className="ac-yaxis" style={{ height }}>
        {yTicks.map((tick) => (
          <span className="ac-ytick" style={{ top: `${tick.y}%` }} key={tick.value}>
            {tick.label}
          </span>
        ))}
      </div>

      <div className="ac-canvas" style={{ height }}>
        <svg
          className="ac-svg"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          role="img"
          aria-labelledby={titleId}
        >
          <title id={titleId}>{title}</title>
          <g className="ac-grid" aria-hidden="true">
            {yTicks.map((tick) => (
              <line x1="0" x2="100" y1={tick.y} y2={tick.y} key={tick.value} />
            ))}
          </g>
          {children}
        </svg>
        {overlay}
      </div>

      <div className="ac-xaxis-spacer" aria-hidden="true" />
      <div className="ac-xaxis" aria-hidden="true">
        {xTicks.map((tick) => (
          <span className={`ac-xtick ac-xtick-${tick.align}`} style={{ left: `${tick.x}%` }} key={tick.index}>
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default Plot;
