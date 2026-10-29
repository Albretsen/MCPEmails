/**
 * POST /api/internal/first-30-days/dispatch
 *
 * The first-30-days retention dispatcher: the M2 stuck-note draft (to
 * Asgeir's own mailbox, never the customer) and the M3 day-8 week-1 summary.
 * Every rule is in src/lib/retention/first-30-days.ts.
 *
 * Called hourly by pg_cron through public.dispatch_first_30_days()
 * (20261024170000_first_30_days.sql).
 *
 * MODE (src/lib/retention/first-30-days-go-live.ts):
 *   FIRST30_ENABLED   unless `on`, return immediately. No DB access.
 *   FIRST30_DRY_RUN   `false` forces live, any other value forces dry run.
 *                     Unset: retention_switches('first30').mode decides, and
 *                     an unreadable row means dry run.
 *   ?dry_run=1        forces a dry run for one call. A query string can only
 *                     make the route quieter, never louder.
 *
 * Dry runs log every decision to first30_dry_run_log and probe the draft
 * mailbox once a day. On the first run at or after auto_go_live_at the route
 * evaluates the go-live criteria once and switches itself live or holds.
 *
 * AUTH. `X-Dispatch-Secret`, constant-time compared against DISPATCH_SECRET,
 * like the paywall follow-up dispatcher. No body is read.
 *
 * OUTPUT. Counts plus, in a dry run, one line per candidate decision keyed by
 * workspace id. Never an email address.
 */

import { timingSafeEqual } from 'node:crypto';
import { createResend } from '@/lib/email/resend';

import { createServiceRoleClient } from '@/lib/supabase/service';
import { budgetExhausted } from '@/lib/billing/dispatch-freshness';
import { lifecycleFrom } from '@/lib/email/lifecycle';
import {
  first30DraftMailbox,
  first30MaxPerRun,
  first30Mode,
  first30StartAt,
  type Sender,
} from '@/lib/retention/first-30-days';
import { SupabaseFirst30Store } from '@/lib/retention/first-30-days-store';
import {
  createDraftMailboxProbe,
  createImapDraftWriter,
  createInternalNoticeWriter,
  firstThatWorks,
} from '@/lib/retention/first-30-days-draft';
import { dispatchFirst30 } from '@/lib/retention/first-30-days-go-live';
import { SupabaseGoLiveStore } from '@/lib/retention/first-30-days-go-live-store';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[first-30-days] DISPATCH_SECRET is not set; refusing every request.');
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

/** One attempt, Idempotency-Key from the caller, never throws. From is the lifecycle sender. */
const resendSender: Sender = async (email) => {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: 'no_api_key' };
  try {
    const resend = createResend(key);
    const { data, error } = await resend.emails.send(
      {
        from: lifecycleFrom(),
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

  if (first30Mode() === 'off') {
    return Response.json({ skipped: 'FIRST30_ENABLED is not on' }, { status: 200 });
  }
  const forceDryRun = new URL(request.url).searchParams.get('dry_run') === '1';

  const started = Date.now();
  const db = createServiceRoleClient();
  const mailbox = first30DraftMailbox();

  try {
    const result = await dispatchFirst30({
      env: process.env,
      store: new SupabaseFirst30Store(db),
      goLive: new SupabaseGoLiveStore(db),
      liveSenders: () => ({
        send: resendSender,
        writeDraft: firstThatWorks(createImapDraftWriter(db, mailbox), createInternalNoticeWriter(resendSender, mailbox)),
      }),
      notify: resendSender,
      notifyTo: mailbox,
      probe: createDraftMailboxProbe(db, mailbox),
      startAt: first30StartAt(),
      maxActions: first30MaxPerRun(),
      outOfTime: () => budgetExhausted(started, Date.now()),
      forceDryRun,
    });
    const report = result.report;
    const body = {
      ...(report ?? {}),
      ok: !result.error,
      mode: result.mode,
      source: result.source,
      runId: result.runId,
      probe: result.probe,
      decision: result.decision
        ? { outcome: result.decision.outcome, notified: result.decision.notified, failed: result.decision.result.criteria.filter((c) => !c.pass).map((c) => c.id) }
        : null,
      logError: result.logError,
      error: result.error,
      entries: result.mode === 'dry_run' && report ? report.entries.slice(0, 200) : undefined,
    };
    console.log('[first-30-days]', JSON.stringify({ ...body, entries: undefined }));
    if (result.error) {
      console.error('[first-30-days] run failed:', result.error);
      return Response.json({ ...body, error: 'run_failed' }, { status: 500 });
    }
    return Response.json(body, { status: 200 });
  } catch (err) {
    console.error('[first-30-days] run failed:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'run_failed' }, { status: 500 });
  }
}
