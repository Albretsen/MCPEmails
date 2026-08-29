'use client';

import { useEffect, useRef } from 'react';
import { createInboxPaywallReporter } from './inbox-paywall.mjs';

/**
 * Fire-and-forget beacon recording that the inbox-cap upgrade panel was shown.
 *
 * This is the highest-intent surface in the product and until now it left no
 * trace, so "the paywall converts badly" and "nobody ever reaches the paywall"
 * were indistinguishable. Deliberately built on the same shape as
 * `usePricingView`: a POST to a small authenticated endpoint that resolves the
 * workspace itself, rather than a second analytics mechanism.
 *
 * The endpoint takes no body at all, so nothing about the mailbox the user was
 * trying to connect can leak into the funnel. `keepalive` lets the request
 * survive the navigation to Stripe when someone reads the panel and clicks
 * upgrade immediately.
 *
 * @param {object} state
 * @param {boolean} state.isReconnect
 * @param {boolean} state.atInboxLimit
 * @param {boolean} state.serverLimitReached
 */
export function useInboxPaywallView({ isReconnect, atInboxLimit, serverLimitReached }) {
  // One reporter per mount. The modal is conditionally rendered, so a mount is
  // exactly one modal-open and the dedupe guard resets when it should.
  const reporter = useRef(null);
  reporter.current ??= createInboxPaywallReporter();

  useEffect(() => {
    if (!reporter.current({ isReconnect, atInboxLimit, serverLimitReached })) return;
    let cancelled = false;
    // Defer past paint: the user is looking at an upgrade offer, and nothing
    // about measuring it may compete with rendering it.
    const id = setTimeout(() => {
      if (cancelled) return;
      fetch('/api/analytics/paywall', { method: 'POST', keepalive: true }).catch(() => {
        // Analytics is never worth a console error in a user's browser.
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [isReconnect, atInboxLimit, serverLimitReached]);
}
