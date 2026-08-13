/**
 * ChartFrame.tsx: the chrome every chart on /admin/growth sits inside.
 *
 * WHY this exists: a chart is not just marks. It is a title, a legend that
 * names each colour, and (non-negotiable on this page) the exact numbers,
 * because a growth dashboard read at a glance is how you talk yourself into a
 * trend that is four people. Rather than have six components each reinvent
 * that shell and each get the accessibility slightly different, they all
 * render their marks into this frame.
 *
 * The numbers table is collapsed inside <details> so it never competes with
 * the picture, but it is always one click away and it is real, selectable,
 * copyable text. No value in this folder is ever chart-only.
 *
 * Pure Server Component: no 'use client', no state, no client JavaScript ships
 * for any chart. Hover detail is done with native SVG <title> elements, which
 * the browser turns into tooltips for free.
 */

import type { ReactNode } from 'react';
import '../../../styles/admin-charts.css';

export type ChartLegendItem = {
  name: string;
  /** A `var(--token)` reference from palette.ts, never a literal colour. */
  color: string;
  /** Optional trailing detail, for example a total or a share. */
  note?: string;
  /** Renders the swatch as a dashed rule instead of a solid block. */
  dashed?: boolean;
  /** Renders the swatch with the "no data yet" hatch used by the heatmap. */
  hatched?: boolean;
};

export type ChartTable = {
  columns: string[];
  rows: Array<Array<string | number>>;
  /** Overrides the default "Exact numbers" summary label. */
  summary?: string;
};

export type ChartFrameProps = {
  /** Omit only when the surrounding section already carries the heading. */
  title?: string;
  subtitle?: string;
  legend?: ChartLegendItem[];
  /** Omitted by charts that already print every number in the chart itself. */
  table?: ChartTable;
  footnote?: string;
  children: ReactNode;
};

export function ChartFrame({ title, subtitle, legend, table, footnote, children }: ChartFrameProps) {
  return (
    <figure className="ac-card">
      <figcaption className={title || subtitle || legend?.length ? 'ac-head' : 'ac-head ac-head-bare'}>
        {title ? <h3 className="ac-title">{title}</h3> : null}
        {subtitle ? <p className="ac-sub">{subtitle}</p> : null}
        {legend && legend.length > 0 ? (
          <ul className="ac-legend">
            {legend.map((item) => (
              <li className="ac-legend-item" key={item.name}>
                <span
                  className={`ac-swatch${item.dashed ? ' ac-swatch-dashed' : ''}${item.hatched ? ' ac-swatch-hatched' : ''}`}
                  style={
                    item.dashed || item.hatched
                      ? { borderColor: item.color }
                      : { background: item.color, borderColor: item.color }
                  }
                  aria-hidden="true"
                />
                <span className="ac-legend-name">{item.name}</span>
                {item.note ? <span className="ac-legend-note">{item.note}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </figcaption>

      <div className="ac-body">{children}</div>

      {footnote ? <p className="ac-foot">{footnote}</p> : null}

      {table ? (
        <details className="ac-details">
          <summary className="ac-summary">{table.summary ?? 'Exact numbers'}</summary>
          <div className="ac-scroll">
            <table className="ac-table">
              <thead>
                <tr>
                  {table.columns.map((column) => (
                    <th scope="col" key={column}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={`${String(row[0])}-${rowIndex}`}>
                    {row.map((cell, cellIndex) =>
                      cellIndex === 0 ? (
                        <th scope="row" key={cellIndex}>
                          {cell}
                        </th>
                      ) : (
                        <td key={cellIndex}>{cell}</td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </figure>
  );
}

export default ChartFrame;
