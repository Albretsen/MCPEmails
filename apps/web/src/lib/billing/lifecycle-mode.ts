/**
 * BILLING_LIFECYCLE_EMAILS: the production kill switch, read at CALL time.
 *
 *   off        (default) Queue nothing, send nothing. The webhook behaves
 *              exactly as it did before lifecycle email existed.
 *   queue_only Materialise sequences from real Stripe events and have the
 *              dispatcher report what it WOULD send, without sending it.
 *   on         Send.
 *
 * WHY THIS IS A FUNCTION AND NOT A CONST.
 *
 * Both the webhook and the dispatcher originally captured this into a
 * module-scope `const` at import time. On Vercel that is evaluated once per
 * lambda instance, so changing the variable in the dashboard has no effect on
 * any warm instance until the next deploy. A kill switch that needs a redeploy
 * to take effect is not a kill switch, and the failure is silent in the exact
 * direction that matters: flipping it to `on` looks like it worked, and no mail
 * goes out until something unrelated triggers a redeploy.
 *
 * Reading it per call costs one property lookup and makes the switch testable,
 * which is why the tests can assert that `queue_only` sends nothing.
 *
 * Anything that is not one of the three known values is treated as `off`. A
 * typo in an environment variable must fail towards silence, never towards
 * mailing customers.
 */

export type LifecycleMode = 'off' | 'queue_only' | 'on';

export function lifecycleMode(): LifecycleMode {
  const raw = (process.env.BILLING_LIFECYCLE_EMAILS ?? 'off').trim().toLowerCase();
  if (raw === 'on') return 'on';
  if (raw === 'queue_only') return 'queue_only';
  return 'off';
}

/** True when sequences should be materialised into `billing_email_sends`. */
export function lifecycleQueueingEnabled(): boolean {
  return lifecycleMode() !== 'off';
}

/** True only when a real customer may actually receive something. */
export function lifecycleSendingEnabled(): boolean {
  return lifecycleMode() === 'on';
}
