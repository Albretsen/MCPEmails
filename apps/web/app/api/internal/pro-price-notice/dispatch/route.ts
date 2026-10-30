/**
 * POST /api/internal/pro-price-notice/dispatch
 *
 * Sends the one Pro price notice email (src/lib/email/pro-price-notice.ts).
 * Called by pg_cron through public.dispatch_pro_price_notice() on the
 * announcement day (migration 20261024150000_pro_price_notice_cron).
 *
 * SAFE TO CALL ANY TIME. Outside the announcement day, or once
 * PRO_PRICE_CHANGE.announce is off, a sending call reads nothing and returns
 * `outside_window`. Every recipient is claimed in lifecycle_email_sends before
 * the send, so a second call the same day only sends to people the first one
 * did not reach. `?dry_run=1` reads and counts without writing or sending.
 *
 * AUTH. `X-Dispatch-Secret`, constant-time compared against DISPATCH_SECRET,
 * as the other dispatchers. No body is read: the route chooses its own
 * audience, so a caller holding the secret cannot choose who is emailed.
 * Output is counts only.
 */

import { timingSafeEqual } from 'node:crypto';
import { createResend } from '@/lib/email/resend';

import { createServiceRoleClient } from '@/lib/supabase/service';
import { lifecycleFrom, lifecycleReplyTo } from '@/lib/email/lifecycle';
import { runProPriceNotice, type NoticeSender } from '@/lib/email/pro-price-notice-run';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/** Well inside maxDuration at the pause below; a second cron call picks up the rest. */
const MAX_SENDS_PER_RUN = 60;

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[pro-price-notice] DISPATCH_SECRET is not set; refusing every request.');
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

const resendSender: NoticeSender = async (email) => {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: 'no_api_key' };
  try {
    const { data, error } = await createResend(key).emails.send(
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
  const dryRun = new URL(request.url).searchParams.get('dry_run') === '1';
  try {
    const report = await runProPriceNotice({
      db: createServiceRoleClient(),
      sender: dryRun ? null : resendSender,
      dryRun,
      maxSends: MAX_SENDS_PER_RUN,
      pauseMs: 600,
    });
    console.log('[pro-price-notice]', JSON.stringify(report));
    return Response.json(report, { status: 200 });
  } catch (err) {
    console.error('[pro-price-notice] run failed:', safeCode(err instanceof Error ? err.message : 'unexpected_error'));
    return Response.json({ error: 'run_failed' }, { status: 500 });
  }
}
