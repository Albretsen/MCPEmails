/**
 * POST /api/internal/eur-launch/dispatch
 *
 * Turns the EUR launch on by itself (src/lib/stripe/eur-launch-run.ts): a
 * read-only Stripe preflight, then the EUR currency options and tax codes,
 * then the `eur_launch_live` flag that eur-launch.ts reads, then the legacy EU
 * swap in capped pages. Called hourly by pg_cron through
 * public.dispatch_eur_launch() from 2026-12-07 00:00 Oslo for 14 days
 * (migration 20261025120000_eur_launch_cron).
 *
 * SAFE TO CALL ANY TIME. Before 2026-12-07 (Oslo) it reads nothing and returns
 * `outside_window`. A preflight failure writes nothing and alerts at most once
 * per Oslo day. Every Stripe write is idempotent, so a second call redoes
 * only what is missing, and a call after the launch only continues the swap.
 * `?dry_run=1` runs the preflight alone, on any date, and writes nothing.
 *
 * AUTH. `X-Dispatch-Secret`, constant-time compared against DISPATCH_SECRET,
 * as the other dispatchers. No body is read: the route decides everything
 * from the clock, the database and Stripe, so a caller holding the secret
 * cannot choose prices, amounts or subscriptions. Output is check codes and
 * counts only.
 *
 * ALERTS go to the owner through the existing pipeline: emit_system_event
 * writes a system_events row and the system-notify edge function renders the
 * `billing.eur_launch` template and emails it.
 */

import { timingSafeEqual } from 'node:crypto';

import { createServiceRoleClient } from '@/lib/supabase/service';
import { resetEurLaunchCache } from '@/lib/stripe/eur-launch';
import { makeFetchTransport } from '@/lib/stripe/eur-launch-plan';
import { runEurLaunchDispatch, scrub } from '@/lib/stripe/eur-launch-run';
import { pricingSwitchStore, systemEventNotify } from '@/lib/stripe/eur-launch-store';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/** Swaps per run; each is one Stripe call, well inside maxDuration. */
const SWAP_CAP = 25;
/** No new Stripe write starts after this, leaving room to report. */
const TIME_BUDGET_MS = 40_000;

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[eur-launch] DISPATCH_SECRET is not set; refusing every request.');
    return false;
  }
  const provided = request.headers.get('x-dispatch-secret') ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorised(request)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const dryRun = new URL(request.url).searchParams.get('dry_run') === '1';
  try {
    const key = process.env.STRIPE_SECRET_KEY?.trim();
    if (!key) return Response.json({ error: 'stripe_not_configured' }, { status: 500 });
    const stripe = makeFetchTransport({ key, live: key.includes('_live_') });
    const db = createServiceRoleClient();
    const report = await runEurLaunchDispatch({
      stripe,
      store: pricingSwitchStore(db),
      notify: systemEventNotify(db),
      env: process.env as Record<string, string | undefined>,
      dryRun,
      swapCap: SWAP_CAP,
      timeBudgetMs: TIME_BUDGET_MS,
    });
    // This instance serves checkout too: let it see the flag at once instead
    // of after the 60 s cache. Other instances catch up within that minute.
    if (report.mode === 'launched') resetEurLaunchCache(true);
    console.log('[eur-launch]', JSON.stringify({ mode: report.mode, failed: report.failed, swap: report.swap, alerted: report.alerted }));
    return Response.json(report, { status: report.mode === 'error' ? 500 : 200 });
  } catch (err) {
    console.error('[eur-launch] run failed:', scrub(err));
    return Response.json({ error: 'run_failed' }, { status: 500 });
  }
}
