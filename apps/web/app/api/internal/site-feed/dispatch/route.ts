/**
 * POST /api/internal/site-feed/dispatch?job=events|mrr
 *
 * Feeds albretsen.no, the owner's personal site, with MCPEmails' live MRR in
 * NOK and an anonymous ticker of what agents are doing. Poked by pg_cron
 * through dispatch_site_feed() (20261026090000_schedule_site_feed.sql):
 * `events` every minute, `mrr` every 15 minutes. The jobs live in
 * src/lib/site-feed/run.ts; the privacy rules in src/lib/site-feed/events.ts.
 *
 * OFF THE PRODUCT'S PATH. The jobs read rows that already exist
 * (activity_log, inboxes, Stripe), so nothing a customer does waits on this
 * route or on albretsen.no.
 *
 * AUTH. `X-Dispatch-Secret` against DISPATCH_SECRET in constant time, the same
 * secret and check as /api/internal/billing-lifecycle/dispatch.
 *
 * ALBRETSEN_FEED_KEY is the bearer key the site accepts. Unset, every run is a
 * silent no-op. It is never logged and never returned.
 *
 * Always answers quickly with a small summary and status 200 once
 * authenticated, whatever albretsen.no did: a failing site is not an incident
 * here, and a 5xx would only make pg_net's log noisier.
 */

import { timingSafeEqual } from 'node:crypto';

import { createServiceRoleClient } from '@/lib/supabase/service';
import { loadRecurringRevenue } from '@/lib/analytics/kiosk-revenue';
import { runEventsJob, runMrrJob } from '@/lib/site-feed/run';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[site-feed] DISPATCH_SECRET is not set; refusing every request.');
    return false;
  }
  const provided = request.headers.get('x-dispatch-secret') ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  // Length is not secret, and timingSafeEqual throws on a mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorised(request)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const job = new URL(request.url).searchParams.get('job');
  if (job !== 'events' && job !== 'mrr') {
    return Response.json({ error: 'unknown_job' }, { status: 400 });
  }
  const key = process.env.ALBRETSEN_FEED_KEY?.trim();
  if (!key) {
    return Response.json({ job, skipped: 'not_configured' }, { status: 200 });
  }

  try {
    const summary =
      job === 'mrr'
        ? await runMrrJob({
          key,
          loadMrrMinorUsd: async () => (await loadRecurringRevenue(28)).mrrMinor,
          nowMs: Date.now(),
        })
        : await runEventsJob({ key, db: createServiceRoleClient(), nowMs: Date.now() });
    if (summary.reason && summary.reason !== 'unchanged') console.warn('[site-feed]', JSON.stringify(summary));
    return Response.json(summary, { status: 200 });
  } catch (err) {
    // The jobs do not throw; this is the guard for one that one day does.
    console.error('[site-feed] job failed', { job, error: err instanceof Error ? err.message : String(err) });
    return Response.json({ job, error: 'job_failed' }, { status: 200 });
  }
}

async function otherMethod(): Promise<Response> {
  return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } });
}

export const GET = otherMethod;
export const HEAD = otherMethod;
export const PUT = otherMethod;
export const PATCH = otherMethod;
export const DELETE = otherMethod;
export const OPTIONS = otherMethod;
