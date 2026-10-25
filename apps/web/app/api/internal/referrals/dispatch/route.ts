/**
 * POST /api/internal/referrals/dispatch
 *
 * The daily referral dispatcher, poked by pg_cron through dispatch_referrals()
 * (migration 20261025090000_referrals.sql) at 10:15 UTC when a 'charged'
 * referral has reached qualifies_at. The body is ignored: selection, the
 * Stripe re-checks, rewards and emails all live in src/lib/referrals/dispatch.ts.
 *
 * AUTH. `X-Dispatch-Secret` against DISPATCH_SECRET in constant time, the same
 * secret and the same check as /api/internal/billing-lifecycle/dispatch (see
 * its header for why the value is shared).
 *
 * The referral flag is read per referrer inside the dispatcher, so with the
 * program off everywhere this answers with every due row skipped.
 */

import { timingSafeEqual } from 'node:crypto';

import { stripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { accountState } from '@/lib/billing/deleted-account';
import { sendReferralEmail } from '@/lib/email/referral-emails';
import { dispatchReferrals } from '@/lib/referrals/dispatch';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[referral-dispatch] DISPATCH_SECRET is not set; refusing every request.');
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
  const db = createServiceRoleClient();
  try {
    const summary = await dispatchReferrals({
      db,
      stripe,
      sendEmail: sendReferralEmail,
      accountState: (userId) => accountState(db, userId),
    });
    console.log('[referral-dispatch] done', summary);
    return Response.json(summary, { status: 200 });
  } catch (err) {
    console.error('[referral-dispatch] failed', { error: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: 'dispatch_failed' }, { status: 500 });
  }
}
