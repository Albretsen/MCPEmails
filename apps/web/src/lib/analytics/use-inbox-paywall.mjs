'use client';

import { useEffect, useRef } from 'react';
import { createInboxPaywallReporter } from './inbox-paywall.mjs';
import { parseConnectEntryPoint } from './connect-entry-point.mjs';

/**
 * Fire-and-forget beacon recording that the inbox-cap upgrade panel was shown.
 *
 * This is the highest-intent surface in the product and until now it left no
 * trace, so "the paywall converts badly" and "nobody ever reaches the paywall"
 * were indistinguishable. Deliberately built on the same shape as
 * `usePricingView`: a POST to a small authenticated endpoint that resolves the
 * workspace itself, rather than a second analytics mechanism.
 *
 * The body is one optional word, `entry_point`: which control opened the
 * modal, from the closed list in connect-entry-point.mjs, which the endpoint
 * checks again. Nothing about the mailbox the user was trying to connect is
 * sent, so none of it can leak into the funnel. `keepalive` lets the request
 * survive the navigation to Stripe when someone reads the panel and clicks
 * upgrade immediately.
 *
 * @param {object} state
 * @param {boolean} state.isReconnect
 * @param {boolean} state.atInboxLimit
 * @param {boolean} state.serverLimitReached
 * @param {string|null} [state.entryPoint] - Which control opened the modal.
 */
export function useInboxPaywallView({ isReconnect, atInboxLimit, serverLimitReached, entryPoint = null }) {
  // Read at send time through a ref: the entry point belongs to the modal-open
  // and must never be a reason for the effect below to run again.
  const entry = useRef(entryPoint);
  useEffect(() => { entry.current = entryPoint; }, [entryPoint]);

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
      const entryPointValue = parseConnectEntryPoint(entry.current);
      fetch('/api/analytics/paywall', {
        method: 'POST',
        keepalive: true,
        ...(entryPointValue
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entry_point: entryPointValue }) }
          : {}),
      }).catch(() => {
        // Analytics is never worth a console error in a user's browser.
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [isReconnect, atInboxLimit, serverLimitReached]);
}
