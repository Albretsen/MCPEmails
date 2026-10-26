'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { startVisiblePoll } from '@/lib/polling/visible-poll';

/**
 * The live OnboardingStatus (src/lib/onboarding/status.ts) for the /onboarding
 * panels. One instance lives in OnboardingApp and is handed to every step as
 * `status`, `refreshStatus` and `setPolling`.
 *
 *   refreshStatus()        fetch GET /api/onboarding/status now; resolves to
 *                          the new status (or the old one on failure)
 *   setPolling(cadence)    start polling; `cadence(elapsedMs)` returns the
 *                          delay before the next poll in ms, or null to stop.
 *                          setPolling(null) stops. Polls only while the tab is
 *                          visible (visible-poll.ts). `adaptiveCadence` is the
 *                          plan's default (A8: 3 s for 3 min, then 15 s, stop
 *                          after 60 min).
 *
 * The wait step (WP-F) owns when to poll; nothing polls by default.
 */

/** Plan A8 / report 11 R1: fast at first, then slower, listening for an hour. */
export function adaptiveCadence(elapsedMs) {
  if (elapsedMs < 3 * 60 * 1000) return 3000;
  if (elapsedMs < 60 * 60 * 1000) return 15000;
  return null;
}

export async function fetchOnboardingStatus(fetchImpl = globalThis.fetch) {
  const res = await fetchImpl('/api/onboarding/status', { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

export function useOnboardingStatus(initialStatus) {
  const [status, setStatus] = useState(initialStatus ?? null);
  const statusRef = useRef(status);
  const pollRef = useRef(null);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await fetchOnboardingStatus();
      statusRef.current = next;
      setStatus(next);
      return next;
    } catch {
      return statusRef.current;
    }
  }, []);

  const setPolling = useCallback((cadence) => {
    pollRef.current?.stop();
    pollRef.current = null;
    if (typeof cadence !== 'function') return;
    const startedAt = Date.now();
    let stopped = false;
    const poll = startVisiblePoll({
      immediate: true,
      poll: async () => {
        await refreshStatus();
        if (cadence(Date.now() - startedAt) === null) {
          stopped = true;
          poll.stop();
        }
      },
      // Read after each poll; an elapsed time past the cadence's end stops in poll().
      intervalMs: () => (stopped ? 60_000 : cadence(Date.now() - startedAt) ?? 60_000),
    });
    pollRef.current = poll;
  }, [refreshStatus]);

  useEffect(() => () => pollRef.current?.stop(), []);

  return { status, refreshStatus, setPolling };
}
