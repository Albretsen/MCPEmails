/**
 * Send billing lifecycle emails that are due now, right after the response.
 *
 * The cron dispatcher runs every five minutes, so before this a cancellation
 * question or a pause receipt could wait up to five minutes. Now every writer
 * in lifecycle-queue.ts (and pass-notices.ts) passes the ids of rows it just
 * queued with `send_after <= now` to `kickDueRows`, which schedules
 * `dispatchBillingEmails({ ids })` with Next's `after()`. It runs once the
 * response has gone, so it cannot slow the request, and the cron stays as the
 * fallback for anything it misses (no request scope, a cold import failing, a
 * crash mid-send): the rows are already queued and due.
 *
 * NEVER THROWS, by construction: the scheduling is wrapped, and the work
 * itself is wrapped again inside the scheduled task. Outside a request scope
 * (`after()` throws there; plain Node cannot even resolve `next/server`), the
 * kick is skipped with a log line and the cron sends the row.
 *
 * Double sends are impossible here for the same reason they are impossible
 * between two cron runs: lifecycle-dispatch.ts claims each row with one
 * compare-and-set UPDATE, and claim_billing_emails() skips locked and claimed
 * rows. Whichever dispatcher claims first sends; the other sees nothing.
 */

import { lifecycleMode } from '@/lib/billing/lifecycle-mode';

/** Runs `task` after the response. Throws when there is no request scope. */
export type KickScheduler = (task: () => Promise<void>) => void | Promise<void>;
/** Claims and sends exactly these rows. */
export type KickRunner = (ids: number[]) => Promise<unknown>;

async function nextAfter(task: () => Promise<void>): Promise<void> {
  // Imported lazily: plain Node (the unit tests) cannot resolve next/server,
  // and lifecycle-queue.ts must stay importable there.
  const { after } = await import('next/server');
  after(task);
}

async function dispatchIds(ids: number[]): Promise<unknown> {
  // Lazily too: the Stripe client throws at import without STRIPE_SECRET_KEY,
  // and lifecycle-dispatch.ts imports lifecycle-queue.ts (a cycle if static).
  const [{ dispatchBillingEmails }, { createServiceRoleClient }, { stripe }] = await Promise.all([
    import('@/lib/billing/lifecycle-dispatch'),
    import('@/lib/supabase/service'),
    import('@/lib/stripe/client'),
  ]);
  const outcome = await dispatchBillingEmails({ db: createServiceRoleClient(), stripe, ids });
  console.log('[dispatch-kick]', JSON.stringify(outcome));
  return outcome;
}

let scheduler: KickScheduler = nextAfter;
let runner: KickRunner = dispatchIds;

/** TEST SUPPORT. Replace the scheduler and/or runner; null restores the default. */
export function setDispatchKickForTests(options: {
  scheduler?: KickScheduler | null;
  runner?: KickRunner | null;
}): void {
  if (options.scheduler !== undefined) scheduler = options.scheduler ?? nextAfter;
  if (options.runner !== undefined) runner = options.runner ?? dispatchIds;
}

/** The ids among `rows` whose `send_after` is not in the future. */
export function dueIds(
  rows: ReadonlyArray<{ id?: unknown; send_after?: unknown }> | null | undefined,
  now: number = Date.now(),
): number[] {
  const out: number[] = [];
  for (const row of rows ?? []) {
    if (typeof row.id !== 'number') continue;
    const at = typeof row.send_after === 'string' ? Date.parse(row.send_after) : NaN;
    if (Number.isFinite(at) && at <= now) out.push(row.id);
  }
  return out;
}

/**
 * Schedule a dispatch of these just-queued, due-now rows after the response.
 * Awaited by the queue writers so `after()` is called inside the request's
 * scope; it only schedules, it never waits for the send. Never throws.
 */
export async function kickDueRows(ids: number[], label: string): Promise<void> {
  if (ids.length === 0) return;
  try {
    if (lifecycleMode() === 'off') return;
    const batch = [...ids];
    await scheduler(async () => {
      try {
        await runner(batch);
      } catch (err) {
        console.error(`[dispatch-kick] ${label}: dispatch failed; the cron will retry:`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  } catch (err) {
    console.warn(`[dispatch-kick] ${label}: not scheduled (no request scope?); the cron will send it:`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
