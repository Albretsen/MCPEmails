/**
 * POST /api/internal/plan-ending-reminder
 *
 * The daily plan-ending reminder run (src/lib/billing/plan-ending-reminder.ts):
 * finds subscriptions whose scheduled stop is 4 to 6 days away, assigns the
 * `plan_ending_reminder` experiment, and queues `plan_ending_5d` for the
 * reminder arm. It sends nothing itself: the billing lifecycle dispatcher
 * (every five minutes) sends the queued row after a Stripe freshness check.
 *
 * Called daily by pg_cron through public.dispatch_plan_ending_reminder()
 * (20261111140300_plan_ending_reminder.sql).
 *
 * MODE, PLAN_ENDING_REMINDER_ENABLED, read per call:
 *   off      (default) return at once. No Stripe or database access.
 *   dry_run  read everything, write nothing, report what it would do.
 *   on       assign, write the ledger rows and the holdout funnel events.
 *   ?dry_run=1 forces a dry run for one call; a query string can only make
 *   the route quieter.
 *
 * AUTH. `X-Dispatch-Secret`, constant-time compared against DISPATCH_SECRET,
 * as the other internal dispatchers. Output carries subscription ids and
 * counts, never an address.
 */
import { timingSafeEqual } from 'node:crypto';

import { stripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { budgetExhausted } from '@/lib/billing/dispatch-freshness';
import { planEndingMode, runPlanEndingReminder } from '@/lib/billing/plan-ending-reminder';
import { SupabasePlanEndingStore } from '@/lib/billing/plan-ending-reminder-store';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[plan-ending] DISPATCH_SECRET is not set; refusing every request.');
    return false;
  }
  const provided = request.headers.get('x-dispatch-secret') ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorised(request)) return Response.json({ error: 'Forbidden' }, { status: 403 });

  const flag = planEndingMode();
  if (flag === 'off') return Response.json({ skipped: 'PLAN_ENDING_REMINDER_ENABLED is off' }, { status: 200 });
  const mode = new URL(request.url).searchParams.get('dry_run') === '1' ? 'dry_run' : flag;

  const started = Date.now();
  const now = new Date();
  try {
    const report = await runPlanEndingReminder({
      store: new SupabasePlanEndingStore(createServiceRoleClient(), stripe, now),
      mode,
      now,
      outOfTime: () => budgetExhausted(started, Date.now()),
    });
    console.log('[plan-ending]', JSON.stringify(report));
    return Response.json({ ok: true, ...report }, { status: 200 });
  } catch (err) {
    console.error('[plan-ending] run failed:', err instanceof Error ? err.message : String(err));
    return Response.json({ ok: false, error: 'run_failed' }, { status: 500 });
  }
}
