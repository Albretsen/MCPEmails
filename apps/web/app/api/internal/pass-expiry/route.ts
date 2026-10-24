/**
 * POST /api/internal/pass-expiry
 *
 * Ends 3-month Personal passes on their date. Called by pg_cron through
 * public.dispatch_pass_expiry() (20261024170000_personal_pass.sql) every 15
 * minutes, and only when a pass has ended or a stacked pass has started, so
 * on almost every tick nothing reaches this route at all.
 *
 * What one run does (sweepPassExpiry in src/lib/billing/pass.ts): for each
 * user with an ended pass or a stacked pass whose start has come, re-project
 * `workspaces.plan` (Free unless a subscription or the next pass is entitled),
 * then mark the ended pass `expired` and the stacked one `active`, and write a
 * `pass_expired` funnel row per expired pass.
 *
 * WHY ITS OWN ROUTE AND NOT THE BILLING LIFECYCLE DISPATCHER. The dispatcher
 * does nothing at all when BILLING_LIFECYCLE_EMAILS=off, and its cron poke
 * returns early unless an email is due. A pass must end on its date whatever
 * the email flag says, so expiry cannot ride on either.
 *
 * NOT GATED ON PERSONAL_PASS_ENABLED. The switch stops new sales; a pass
 * already sold runs to its end and must also stop there.
 *
 * AUTH. `X-Dispatch-Secret`, compared in constant time against
 * DISPATCH_SECRET, exactly as /api/internal/billing-lifecycle/dispatch and
 * with the same Vault secret on the database side. The body is ignored, so
 * even a caller holding the secret cannot steer which passes end.
 *
 * NOTICES. Both pass notices are queued at purchase (pass-notices.ts). The
 * sweep hands its pass_ended notice to the same sink as a backfill; the
 * (customer, template, pass id) unique key makes that a no-op when queued.
 */

import { timingSafeEqual } from 'node:crypto';

import { createServiceRoleClient } from '@/lib/supabase/service';
import { sweepPassExpiry } from '@/lib/billing/pass';
import { passNoticeSink } from '@/lib/billing/pass-notices';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[pass-expiry] DISPATCH_SECRET is not set; refusing every request.');
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

  try {
    const db = createServiceRoleClient();
    // The pass_ended notice was queued at purchase; this is the backfill for a
    // pass bought while lifecycle queueing was off. Same unique key, so a pass
    // already queued gets nothing new.
    const result = await sweepPassExpiry(db, { notices: passNoticeSink(db) });
    console.log('[pass-expiry] sweep:', result);
    return Response.json({ ok: result.failed === 0, ...result }, { status: result.failed === 0 ? 200 : 500 });
  } catch (err) {
    console.error('[pass-expiry] sweep failed:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'sweep_failed' }, { status: 500 });
  }
}
