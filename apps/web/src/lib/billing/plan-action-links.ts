/**
 * The PLAN_ENDING_REMINDER_ENABLED switch and the "Keep my plan" / "Pause
 * instead" links. Dependency-free on purpose: the email composer, the billing
 * routes and the reminder job all read it.
 *
 *   off      (default) nothing changes anywhere.
 *   dry_run  the reminder job reports what it would do and writes nothing.
 *   on       the job runs, and the cancellation confirmation carries the
 *            keep link and the pause deep link.
 *
 * Read at call time, never at module load (see lifecycle-mode.ts). Anything
 * that is not a known value reads as off.
 */

export type PlanEndingMode = 'off' | 'dry_run' | 'on';

export function planEndingMode(env: Record<string, string | undefined> = process.env): PlanEndingMode {
  const raw = (env.PLAN_ENDING_REMINDER_ENABLED ?? '').trim().toLowerCase();
  if (raw === 'on') return 'on';
  if (raw === 'dry_run' || raw === 'dry-run') return 'dry_run';
  return 'off';
}

/** True only when customers may see the keep / pause links in an email. */
export function planEndingLinksOn(env: Record<string, string | undefined> = process.env): boolean {
  return planEndingMode(env) === 'on';
}

/**
 * Where a keep or pause click came from. Written to
 * product_funnel_events.entry_point on plan_kept and pause_started.
 */
export const PLAN_ACTION_SOURCES = ['plan_ending_email', 'cancel_email', 'billing_page'] as const;
export type PlanActionSource = (typeof PLAN_ACTION_SOURCES)[number];

export function planActionSource(value: unknown): PlanActionSource | null {
  return typeof value === 'string' && (PLAN_ACTION_SOURCES as ReadonlyArray<string>).includes(value)
    ? (value as PlanActionSource)
    : null;
}

/**
 * The billing page with one action ready. Query, not hash: the sign-in
 * redirect keeps the query string and drops the fragment. The billing card
 * (components/dashboard/PlanChangeBlock.jsx) reads `plan_action` and opens the
 * matching dialog; nothing changes until its confirm button is pressed, so a
 * mail scanner that prefetches the link changes nothing.
 */
export function planActionUrl(base: string, action: 'keep' | 'pause', source: PlanActionSource): string {
  return `${base.replace(/\/+$/, '')}/dashboard/settings?plan_action=${action}&src=${source}`;
}
