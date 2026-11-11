/**
 * POST /api/internal/inbox-alert/dispatch
 *
 * The broken-inbox alert dispatcher. Every rule is in
 * src/lib/retention/inbox-alert.ts. Called hourly by pg_cron through
 * public.dispatch_inbox_alert() (20261111140000_inbox_broken_alert.sql).
 *
 * MODE:
 *   INBOX_ALERT_ENABLED   off (default): return immediately, no DB access.
 *                         dry_run: read and report, write nothing, assign
 *                         nobody, send nothing.
 *                         on: live.
 *   INBOX_ALERT_MAX_PER_RUN  emails per run, default 25.
 *   ?dry_run=1            forces a dry run for one call. A query string can
 *                         only make the route quieter, never louder.
 *
 * AUTH. `X-Dispatch-Secret`, constant-time compared against DISPATCH_SECRET.
 * No body is read.
 *
 * SENDER. The transactional sender of the billing notices
 * (BILLING_EMAIL_FROM, default MCPEmails <hello@mcpemails.com>), replies to
 * support@. Resend idempotency key per (inbox, break, phase).
 *
 * OUTPUT. Counts plus, in a dry run, one line per decision keyed by inbox and
 * workspace id. Never an email address.
 */

import { timingSafeEqual } from 'node:crypto';
import { createResend } from '@/lib/email/resend';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { budgetExhausted } from '@/lib/billing/dispatch-freshness';
import { appUrl } from '@/lib/email/lifecycle';
import { inboxAlertMaxSends, inboxAlertMode, runInboxAlerts, type AlertSender } from '@/lib/retention/inbox-alert';
import { composeInboxAlert } from '@/lib/retention/inbox-alert-templates';
import { SupabaseInboxAlertStore } from '@/lib/retention/inbox-alert-store';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const DEFAULT_FROM = 'MCPEmails <hello@mcpemails.com>';
const SUPPORT_ADDRESS = 'support@mcpemails.com';

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[inbox-alert] DISPATCH_SECRET is not set; refusing every request.');
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(request.headers.get('x-dispatch-secret') ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_.:\- ]{1,120}$/i.test(value) ? value : 'unexpected_response';
}

const resendSender: AlertSender = async (input) => {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: 'no_api_key' };
  const email = composeInboxAlert({ ...input, baseUrl: appUrl() });
  try {
    const { data, error } = await createResend(key).emails.send(
      {
        from: process.env.BILLING_EMAIL_FROM ?? DEFAULT_FROM,
        replyTo: SUPPORT_ADDRESS,
        to: input.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    if (error) return { ok: false, reason: safeCode(error.message) };
    return { ok: true, id: data?.id ?? null };
  } catch (err) {
    return { ok: false, reason: safeCode(err instanceof Error ? err.message : 'unexpected_error') };
  }
};

export async function POST(request: Request): Promise<Response> {
  if (!authorised(request)) return Response.json({ error: 'Forbidden' }, { status: 403 });

  const configured = inboxAlertMode();
  if (configured === 'off') return Response.json({ skipped: 'INBOX_ALERT_ENABLED is off' }, { status: 200 });
  const mode = configured === 'on' && new URL(request.url).searchParams.get('dry_run') !== '1' ? 'on' : 'dry_run';

  const started = Date.now();
  try {
    const report = await runInboxAlerts({
      mode,
      store: new SupabaseInboxAlertStore(createServiceRoleClient()),
      send: resendSender,
      now: new Date(),
      maxSends: inboxAlertMaxSends(),
      outOfTime: () => budgetExhausted(started, Date.now()),
    });
    const body = {
      ok: true,
      mode: report.mode,
      candidates: report.candidates,
      counts: report.counts,
      truncated: report.truncated,
      entries: report.mode === 'dry_run' ? report.entries.slice(0, 200) : undefined,
    };
    console.log('[inbox-alert]', JSON.stringify({ ...body, entries: undefined }));
    if (report.mode === 'dry_run') console.log('[inbox-alert] dry run entries', JSON.stringify(report.entries.slice(0, 200)));
    return Response.json(body, { status: 200 });
  } catch (err) {
    console.error('[inbox-alert] run failed:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'run_failed' }, { status: 500 });
  }
}
