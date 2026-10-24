/**
 * POST /api/internal/activation-help/dispatch
 *
 * The activation help dispatcher: a connection-help email after a failed
 * inbox connection and a first-call email after a connected inbox with no
 * tool call, each at most once per workspace, with a 20% holdout. Every rule
 * is in src/lib/email/activation-help.ts.
 *
 * Called every 15 minutes by pg_cron (dispatch-activation-help, migration
 * 20261024190500_activation_help_emails.sql).
 *
 * OFF BY DEFAULT, THREE TIMES.
 *   ACTIVATION_HELP_ENABLED    unless `on`, return immediately. No DB access.
 *   ACTIVATION_HELP_DRY_RUN    unless `false`, decide and report only: nothing
 *                              is claimed, nothing is written, nothing is sent.
 *   ACTIVATION_HELP_START_AT   ISO date. Workspaces created before it are never
 *                              emailed; unset means nobody is.
 *   ?dry_run=1                 forces a dry run for one call. A query string
 *                              can only make the route quieter.
 *
 * AUTH. `X-Dispatch-Secret`, constant-time compared against DISPATCH_SECRET,
 * exactly as the paywall follow-up dispatcher. No body is read: the route
 * selects its own work, so a caller holding the secret cannot choose who is
 * emailed.
 *
 * SENDER. From the lifecycle sender (Asgeir), Reply-To the support inbox, so a
 * reply lands where it is tracked and answered.
 *
 * OUTPUT. Aggregate counts plus, in a dry run, one line per candidate keyed by
 * a truncated sha256 of the workspace id. No addresses, no raw ids.
 */

import { timingSafeEqual } from 'node:crypto';
import { Resend } from 'resend';

import { createServiceRoleClient } from '@/lib/supabase/service';
import { budgetExhausted } from '@/lib/billing/dispatch-freshness';
import { lifecycleFrom } from '@/lib/email/lifecycle';
import { SUPPORT_EMAIL } from '@/lib/support/help-content.mjs';
import {
  activationHelpMaxPerRun,
  activationHelpMode,
  activationHelpStartAt,
  runActivationHelp,
  type Sender,
} from '@/lib/email/activation-help';
import { SupabaseActivationHelpStore } from '@/lib/email/activation-help-store';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[activation-help] DISPATCH_SECRET is not set; refusing every request.');
    return false;
  }
  const provided = request.headers.get('x-dispatch-secret') ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Keep anything unexpected out of the logs verbatim. */
function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_.:\- ]{1,120}$/i.test(value) ? value : 'unexpected_response';
}

/** One attempt, never a retry, Idempotency-Key set by the caller. */
const resendSender: Sender = async (email) => {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: 'no_api_key' };
  try {
    const resend = new Resend(key);
    const { data, error } = await resend.emails.send(
      {
        from: lifecycleFrom(),
        to: email.to,
        replyTo: SUPPORT_EMAIL,
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

  const configured = activationHelpMode();
  if (configured === 'off') {
    return Response.json({ skipped: 'ACTIVATION_HELP_ENABLED is not on' }, { status: 200 });
  }
  const forceDry = new URL(request.url).searchParams.get('dry_run') === '1';
  const mode = forceDry ? 'dry_run' : configured;

  const started = Date.now();
  const store = new SupabaseActivationHelpStore(createServiceRoleClient());

  try {
    const report = await runActivationHelp({
      store,
      mode,
      config: { startAt: activationHelpStartAt() },
      send: mode === 'send' ? resendSender : undefined,
      maxSends: activationHelpMaxPerRun(),
      outOfTime: () => budgetExhausted(started, Date.now()),
    });
    const body = {
      ok: true,
      ...report,
      // Per-candidate lines only in a dry run, where reviewing them is the point.
      entries: mode === 'dry_run' ? report.entries.slice(0, 200) : undefined,
    };
    console.log('[activation-help]', JSON.stringify(mode === 'dry_run' ? body : { ...body, entries: undefined }));
    return Response.json(body, { status: 200 });
  } catch (err) {
    console.error('[activation-help] run failed:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'run_failed' }, { status: 500 });
  }
}
