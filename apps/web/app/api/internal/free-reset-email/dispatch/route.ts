/**
 * POST /api/internal/free-reset-email/dispatch
 *
 * The monthly "your Free actions reset" email (src/lib/email/free-reset-email.ts
 * has every rule). Called by pg_cron through public.dispatch_free_reset_email()
 * on the 2nd of each month (20261111180000_free_reset_email.sql).
 *
 * OFF UNTIL STARTED.
 *   LIFECYCLE_EXPANSION_START_AT   unset, unparseable or in the future: the
 *                                  route returns before touching the database.
 *   LIFECYCLE_EXPANSION_DRY_RUN    unless exactly `false`, decide and count
 *                                  only: nothing is claimed, written or sent.
 *   ?dry_run=1                     forces a dry run for one call. A query
 *                                  string can only make the route quieter.
 *   ?as_of=<ISO time>              STAGING AND DEVELOPMENT ONLY (ignored when
 *                                  APP_ENV is production or unset): run as if
 *                                  it were that moment, so the 2nd-of-month
 *                                  run can be checked end to end any day.
 *
 * AUTH. `X-Dispatch-Secret`, constant-time compared against DISPATCH_SECRET.
 * No body is read: the route selects its own work.
 *
 * OUTPUT. Aggregate counts plus, in a dry run, one line per candidate keyed by
 * a truncated sha256 of the workspace id. No addresses, no raw ids.
 */

import { timingSafeEqual } from 'node:crypto';
import { createResend } from '@/lib/email/resend';

import { createServiceRoleClient } from '@/lib/supabase/service';
import { budgetExhausted } from '@/lib/billing/dispatch-freshness';
import { lifecycleFrom, lifecycleReplyTo } from '@/lib/email/lifecycle';
import { expansionConfig, expansionCovers } from '@/lib/email/lifecycle-region';
import { isProduction } from '@/lib/env/app-env';
import { freeResetMaxPerRun, runFreeReset, type Sender } from '@/lib/email/free-reset-email';
import { SupabaseFreeResetStore } from '@/lib/email/free-reset-email-store';
import { paywallEmailPassLine, recordPassOfferShownOnce } from '@/lib/billing/pass-offer';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[free-reset] DISPATCH_SECRET is not set; refusing every request.');
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

/** One attempt, never a retry, Idempotency-Key set by the caller. */
const resendSender: Sender = async (email) => {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: 'no_api_key' };
  try {
    const resend = createResend(key);
    const { data, error } = await resend.emails.send(
      {
        from: lifecycleFrom(),
        replyTo: lifecycleReplyTo(),
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: email.headers,
      },
      { idempotencyKey: email.idempotencyKey },
    );
    if (error) return { ok: false, reason: safeCode(error.message) };
    return { ok: true, id: data?.id ?? null };
  } catch (err) {
    return { ok: false, reason: safeCode(err instanceof Error ? err.message : 'unexpected_error') };
  }
};

export async function POST(request: Request): Promise<Response> {
  if (!authorised(request)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const expansion = expansionConfig();
  const params = new URL(request.url).searchParams;
  const asOf = isProduction() ? null : params.get('as_of');
  const asOfDate = asOf ? new Date(asOf) : null;
  const now = asOfDate && Number.isFinite(asOfDate.getTime()) ? asOfDate : new Date();
  if (!expansionCovers(expansion, now.getTime())) {
    return Response.json({ skipped: 'LIFECYCLE_EXPANSION_START_AT is unset or in the future' }, { status: 200 });
  }
  const forceDry = params.get('dry_run') === '1';
  const mode = forceDry ? 'dry_run' : 'send';
  const started = Date.now();

  try {
    const report = await runFreeReset({
      store: new SupabaseFreeResetStore(createServiceRoleClient()),
      mode,
      expansion,
      now,
      send: resendSender,
      maxSends: freeResetMaxPerRun(),
      outOfTime: () => budgetExhausted(started, Date.now()),
      passOffer: (workspaceId, at) => paywallEmailPassLine(workspaceId, at, { surface: 'free_reset_email' }),
      onPassOfferShown: async (workspaceId) => {
        await recordPassOfferShownOnce(createServiceRoleClient(), workspaceId, 'free_reset_email');
      },
    });
    const body = {
      ok: true,
      ...report,
      entries: report.mode === 'dry_run' ? report.entries.slice(0, 300) : undefined,
    };
    console.log('[free-reset]', JSON.stringify({ ...body, entries: undefined }));
    return Response.json(body, { status: 200 });
  } catch (err) {
    console.error('[free-reset] run failed:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'run_failed' }, { status: 500 });
  }
}
