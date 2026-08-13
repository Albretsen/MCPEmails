'use client';

/**
 * MetricCard: a growth stat card that opens a historical drill-down.
 *
 * The complaint this solves is that a bare number ("active workspaces: 31")
 * carries no information without a reference point. Two layers of context are
 * provided: the card itself shows a sparkline and a delta against the previous
 * equivalent period, and clicking it opens a drawer with the full 90-day
 * series, the min and max, and the precise definition of the metric.
 *
 * The number and sparkline are rendered on the server and passed in as
 * `children`, so this component adds no data fetching to the initial page. The
 * series is fetched only when a card is actually opened, which keeps the
 * drill-down off the critical path entirely.
 */

import { useCallback, useEffect, useState } from 'react';
import { MetricDrawer } from './MetricDrawer';

export function MetricCard({
  metricKey,
  label,
  children,
}: {
  metricKey: string;
  /** Used for the button's accessible name, since the visible label is inside `children`. */
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  // Escape closes, and the page behind must not scroll while the drawer is up.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, close]);

  // The card is a div with a full-bleed button behind its content, not a
  // button wrapping it. Cards carry their own hover explanation, and a
  // <button> inside a <button> is invalid HTML: the parser unnests it and
  // hydration then fails against a tree the server never produced. This keeps
  // the whole card clickable while leaving the info dot a real sibling
  // control, above the hit area in z-order.
  return (
    <>
      <div className="growth-stat is-clickable">
        <button
          type="button"
          className="growth-stat-hit"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${label}, show history`}
          onClick={() => setOpen(true)}
        />
        <div className="growth-stat-content">{children}</div>
      </div>
      {open && <MetricDrawer metricKey={metricKey} onClose={close} />}
    </>
  );
}
