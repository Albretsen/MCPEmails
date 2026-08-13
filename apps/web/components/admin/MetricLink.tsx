'use client';

/**
 * A text-button trigger for the metric drill-down.
 *
 * Same drawer as MetricCard, different affordance. Some numbers do not live in
 * a stat card: the Gmail cap is a full-width panel with a meter, and wrapping
 * that in a card-shaped button would fight the layout for no benefit.
 */

import { useCallback, useEffect, useState } from 'react';
import { MetricDrawer } from './MetricDrawer';

export function MetricLink({ metricKey, children }: { metricKey: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

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

  return (
    <>
      <button type="button" className="growth-link" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        {children}
      </button>
      {open && <MetricDrawer metricKey={metricKey} onClose={close} />}
    </>
  );
}
