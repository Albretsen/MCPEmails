/**
 * POST /api/internal/black-week-email/dispatch
 *
 * Sends the one Black Week 2026 email (rules in src/lib/email/black-week-email.ts).
 *
 * SCHEDULED by pg_cron (20261024150000_schedule_black_week_email.sql): every
 * 10 minutes from 07:00 to 20:59 UTC on 27 November. The route gates on time
 * itself too: nothing is sent before 2026-11-27T07:00:00Z or after the offer
 * window closes, and nothing at all unless both seasonal offers are live in
 * Stripe (the coupon is the kill switch). Every run after the first finds the
 * ledger already holding everyone and sends nothing more.
 *
 * AUTH. `X-Dispatch-Secret`, constant-time compared against DISPATCH_SECRET,
 * the same secret the billing lifecycle and paywall follow-up dispatchers use.
 * No body is read.
 *
 * DRY RUN. `?dry_run=1` selects and classifies only: counts by segment and by
 * skip reason, no ledger writes, no email. It ignores the time gate (offers
 * are evaluated as at send time) so it can be run ahead of the day. A query
 * string can only make the route quieter.
 *
 * OUTPUT. Aggregate counts only. No addresses, no ids.
 */

import { timingSafeEqual } from 'node:crypto';
import { createResend } from '@/lib/email/resend';

import { createServiceRoleClient } from '@/lib/supabase/service';
import { budgetExhausted } from '@/lib/billing/dispatch-freshness';
import { lifecycleFrom, lifecycleReplyTo } from '@/lib/email/lifecycle';
import {
  runBlackWeekEmail,
  subscriptionFacts,
  type BatchSender,
  type ReadSubscription,
} from '@/lib/email/black-week-email';
import { SupabaseBlackWeekStore } from '@/lib/email/black-week-email-store';
import { getActiveSeasonalOffers } from '@/lib/stripe/seasonal-offer-server';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[black-week-email] DISPATCH_SECRET is not set; refusing every request.');
    return false;
  }
  const provided = request.headers.get('x-dispatch-secret') ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_.:\- ]{1,120}$/i.test(value) ? value : 'unexpected_response';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One batch call to Resend. A rate-limit answer is retried up to three times
 * with the SAME idempotency key, so a retry can never deliver a batch twice.
 * Anything else comes back as {ok:false}, never a throw.
 */
const resendBatch: BatchSender = async (emails, idempotencyKey) => {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: 'no_api_key' };
  const resend = createResend(key);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const { data, error } = await resend.batch.send(
        emails.map((e) => ({
          from: lifecycleFrom(),
          replyTo: lifecycleReplyTo(),
          to: e.to,
          subject: e.subject,
          html: e.html,
          text: e.text,
          headers: e.headers,
        })),
        { idempotencyKey },
      );
      if (!error) {
        const ids = (data?.data ?? []).map((d) => d.id ?? null);
        return { ok: true, ids };
      }
      const name = (error as { name?: string }).name ?? '';
      if (name === 'rate_limit_exceeded' && attempt < 3) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return { ok: false, reason: safeCode(error.message) };
    } catch (err) {
      return { ok: false, reason: safeCode(err instanceof Error ? err.message : 'unexpected_error') };
    }
  }
  return { ok: false, reason: 'rate_limited' };
};

const readSubscription: ReadSubscription = async (subscriptionId) => {
  try {
    const { stripe } = await import('@/lib/stripe/client');
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    return subscriptionFacts({
      status: sub.status,
      metadata: sub.metadata,
      items: sub.items,
    });
  } catch {
    return null;
  }
};

export async function POST(request: Request): Promise<Response> {
  if (!authorised(request)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const mode = new URL(request.url).searchParams.get('dry_run') === '1' ? 'dry_run' : 'send';
  const started = Date.now();

  try {
    const report = await runBlackWeekEmail({
      store: new SupabaseBlackWeekStore(createServiceRoleClient()),
      readSubscription,
      getOffers: (now) => getActiveSeasonalOffers(now),
      mode,
      send: mode === 'send' ? resendBatch : undefined,
      outOfTime: () => budgetExhausted(started, Date.now()),
    });
    console.log('[black-week-email]', JSON.stringify(report));
    return Response.json({ ok: true, ...report }, { status: 200 });
  } catch (err) {
    console.error('[black-week-email] run failed:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'run_failed' }, { status: 500 });
  }
}
