'use client';

/**
 * Fire-and-forget writes from the /onboarding flow to POST /api/onboarding.
 * Every action and what it records: app/api/onboarding/route.ts.
 *
 *   stepViewed(step)        funnel onboarding_step_viewed (category step_<id>)
 *   clientChanged(client)   stores the chip choice + funnel client_changed
 *   onboardingCompleted()   stamps onboarding_completed_at + funnel event
 *
 * Analytics must never break the flow: errors are swallowed, and `keepalive`
 * lets a write survive the navigation that often follows it.
 */
export function postOnboardingAction(action, data = {}, fetchImpl = globalThis.fetch) {
  try {
    return fetchImpl('/api/onboarding', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: JSON.stringify({ action, ...data }),
    }).then((res) => res.ok, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

export const stepViewed = (step) => postOnboardingAction('step_viewed', { step });
export const clientChanged = (client) => postOnboardingAction('client_changed', { client });
export const onboardingCompleted = () => postOnboardingAction('completed');
