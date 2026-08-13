'use client';

import { useEffect } from 'react';

/**
 * Fire-and-forget beacon recording that a signed-in user looked at the plans.
 *
 * The endpoint ignores anonymous callers and dedupes server-side per UTC day,
 * so mounting this on a public page is safe: logged-out visitors record
 * nothing. `keepalive` lets the request survive the navigation to Stripe when
 * a user views and immediately clicks upgrade.
 *
 * @param {'pricing_page' | 'dashboard_billing'} surface
 */
export function usePricingView(surface) {
  useEffect(() => {
    let cancelled = false;
    // Defer past first paint: this must never compete with rendering the page
    // a user is trying to buy from.
    const id = setTimeout(() => {
      if (cancelled) return;
      fetch('/api/analytics/pricing-view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface }),
        keepalive: true,
      }).catch(() => {
        // Analytics is never worth a console error in a user's browser.
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [surface]);
}
