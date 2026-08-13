'use client';

/**
 * MetricDrawer: the historical context panel behind every clickable stat card.
 *
 * Fetched on open, never on page load, from the admin-only
 * `GET /api/admin/growth/metric/[key]` endpoint. That endpoint is guarded by
 * `requireAdmin()` and returns aggregates only, so nothing workspace-
 * identifying ever reaches the browser.
 *
 * The panel answers "is this number good?" with the only honest reference an
 * early-stage product has: its own past. Current value, the previous
 * equivalent period, the observed range, the average, and the full series.
 */

import { useEffect, useState } from 'react';

type Point = { day: string; value: number };

type MetricResponse = {
  key: string;
  label: string;
  definition: string;
  goodDirection: 'up' | 'down';
  target: number | null;
  /** An externally imposed wall (Google's OAuth cap), not a goal. */
  threshold: { value: number; label: string } | null;
  unit: string;
  granularity: 'daily' | 'monthly';
  points: Point[];
  summary: {
    current: number;
    previous: number;
    deltaAbsolute: number;
    deltaPercent: number;
    min: number;
    max: number;
    average: number;
  };
};

/** "45 days" / "2 months": the half of the series each summary figure covers. */
function periodLabel({ points, granularity }: MetricResponse) {
  const half = Math.floor(points.length / 2);
  if (half === 0) return '';
  return granularity === 'monthly'
    ? `${half} month${half === 1 ? '' : 's'}`
    : `${half} day${half === 1 ? '' : 's'}`;
}

function format(value: number, unit: string) {
  if (unit === 'percent') return `${value.toFixed(1)}%`;
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(1);
}

export function MetricDrawer({ metricKey, onClose }: { metricKey: string; onClose: () => void }) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: MetricResponse }>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/admin/growth/metric/${encodeURIComponent(metricKey)}?window=90d`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        return (await response.json()) as MetricResponse;
      })
      .then((data) => setState({ status: 'ready', data }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({ status: 'error', message: error instanceof Error ? error.message : 'Unknown error' });
      });
    return () => controller.abort();
  }, [metricKey]);

  const data = state.status === 'ready' ? state.data : null;

  return (
    <>
      <div className="growth-drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="growth-drawer" role="dialog" aria-modal="true" aria-label={`${data?.label ?? 'Metric'} history`}>
        <div className="growth-drawer-head">
          <div>
            <h2>{data?.label ?? 'Loading'}</h2>
            <p>{data ? `Last ${data.points.length} ${data.granularity === 'monthly' ? 'months' : 'days'}, UTC.` : 'Fetching history.'}</p>
          </div>
          <button type="button" className="growth-drawer-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="growth-drawer-body">
          {state.status === 'loading' && <div className="growth-sk" style={{ height: 220, borderRadius: 8 }} aria-busy="true" />}

          {state.status === 'error' && (
            <div className="growth-error">
              <strong>Could not load this metric.</strong>
              <code>{state.message}</code>
            </div>
          )}

          {data && (
            <>
              {/* The summary splits the series in half, so the comparison period
                  is stated explicitly. Without it these figures look like they
                  should match the card, which covers a different span. */}
              <dl className="growth-drawer-figures">
                <div className="growth-figure"><dt>Current {periodLabel(data)}</dt><dd>{format(data.summary.current, data.unit)}</dd></div>
                <div className="growth-figure"><dt>Previous {periodLabel(data)}</dt><dd>{format(data.summary.previous, data.unit)}</dd></div>
                <div className="growth-figure"><dt>Range</dt><dd>{format(data.summary.min, data.unit)} to {format(data.summary.max, data.unit)}</dd></div>
                <div className="growth-figure"><dt>Average</dt><dd>{format(data.summary.average, data.unit)}</dd></div>
              </dl>

              <MetricSeries
                points={data.points}
                label={data.label}
                rule={data.threshold ?? (data.target === null ? null : { value: data.target, label: 'Target' })}
                unit={data.unit}
              />

              <p className="growth-drawer-def">
                <strong>What this counts.</strong> {data.definition}
                {data.target !== null && ` Operator target: ${format(data.target, data.unit)}.`}
                {data.threshold && ` Hard limit: ${format(data.threshold.value, data.unit)} (${data.threshold.label}).`}
              </p>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

/**
 * The series plot. Deliberately a local, dependency-free SVG rather than the
 * shared chart primitives: those are server components used inside the page's
 * Suspense sections, and pulling them into this client bundle for one sparse
 * line would drag their whole module graph across the boundary.
 */
function MetricSeries({ points, label, rule, unit }: { points: Point[]; label: string; rule: { value: number; label: string } | null; unit: string }) {
  if (points.length === 0) return <p className="growth-note">No history recorded for this metric yet.</p>;

  const width = 520;
  const height = 200;
  const pad = { top: 12, right: 12, bottom: 24, left: 40 };
  const values = points.map((point) => point.value);
  const max = Math.max(...values, rule?.value ?? 0, 1);
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const x = (index: number) => pad.left + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
  const y = (value: number) => pad.top + plotHeight - (value / max) * plotHeight;
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ');
  const ticks = [0, 0.5, 1].map((fraction) => max * fraction);
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));

  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={`${label} over time`} style={{ overflow: 'visible' }}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke="var(--border-1)" strokeWidth="1" />
            <text x={pad.left - 7} y={y(tick) + 3.5} textAnchor="end" fontSize="10" fill="var(--fg-4)">{format(tick, unit)}</text>
          </g>
        ))}
        {rule && (
          <>
            <line x1={pad.left} x2={width - pad.right} y1={y(rule.value)} y2={y(rule.value)} stroke="var(--amber-500)" strokeWidth="1.5" strokeDasharray="4 3" />
            <text x={width - pad.right} y={y(rule.value) - 5} textAnchor="end" fontSize="10" fill="var(--amber-500)">{rule.label}</text>
          </>
        )}
        <path d={path} fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((point, index) => (
          index % labelEvery === 0 ? (
            <text key={point.day} x={x(index)} y={height - 6} textAnchor="middle" fontSize="10" fill="var(--fg-4)">{point.day.slice(5)}</text>
          ) : null
        ))}
      </svg>
      <figcaption className="growth-note">
        {rule ? `Dashed line: ${rule.label}.` : 'No target or limit is set for this metric.'}
      </figcaption>
    </figure>
  );
}
