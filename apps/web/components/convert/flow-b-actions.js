'use client';

import { postOnboardingAction } from '../onboarding/onboarding-actions';

/**
 * Flow B writes (POST /api/onboarding {action: 'flow_b'}), fire and forget.
 * The vocabulary and what each event stamps: parseFlowBEvent in
 * src/lib/onboarding/flow-b.mjs.
 *
 * `shownOnce` keeps a "shown" event to one request per page session; the
 * server deduplicates as well, so a reload costs at most one cheap read.
 */
export function flowBEvent(event, data = {}) {
  return postOnboardingAction('flow_b', { event, ...data });
}

const sent = new Set();

export function shownOnce(key, event, data = {}) {
  if (sent.has(key)) return;
  sent.add(key);
  try {
    if (typeof sessionStorage !== 'undefined') {
      const storageKey = `mcpe-flowb:${key}`;
      if (sessionStorage.getItem(storageKey)) return;
      sessionStorage.setItem(storageKey, '1');
    }
  } catch {
    // Private mode or blocked storage: the server dedupes anyway.
  }
  flowBEvent(event, data);
}
