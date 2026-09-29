/**
 * POST /api/internal/paywall-followup/dispatch
 *
 * The paywall follow-up dispatcher (three lifecycle emails after a workspace's
 * first paywall; see src/lib/email/paywall-followup.ts for every rule).
 *
 * NOT SCHEDULED. No cron calls this yet. 20260929110000_paywall_followup_ledger
 * creates public.dispatch_paywall_followup() but deliberately does not pass it
 * to cron.schedule; that is a manual step after sign-off.
 *
 * OFF BY DEFAULT, TWICE.
 *   PAYWALL_FOLLOWUP_ENABLED   unless `on`, return immediately. No DB access.
 *   PAYWALL_FOLLOWUP_DRY_RUN   unless `false`, select and render only: nothing
 *                              is claimed, nothing is written, nothing is sent.
 *   ?dry_run=1                 forces a dry run for one call even when sending
 *                              is enabled. A query string can only make the
 *                              route quieter, never louder.
 *
 * AUTH. `X-Dispatch-Secret`, constant-time compared against DISPATCH_SECRET,
 * exactly as the billing lifecycle dispatcher. No body is read: the route
 * selects its own work, so even a caller holding the secret cannot choose who
 * is emailed.
 *
 * OUTPUT. Aggregate counts plus, in a dry run, one line per candidate keyed by
 * a truncated sha256 of the workspace id. No addresses, no raw ids: this lands
 * in a Vercel log and a cron response body.
 */

import { timingSafeEqual } from 'node:crypto';
import { Resend } from 'resend';

import { createServiceRoleClient } from '@/lib/supabase/service';
import { budgetExhausted } from '@/lib/billing/dispatch-freshness';
import { lifecycleFrom } from '@/lib/email/lifecycle';
import {
  paywallFollowupMaxPerRun,
  paywallFollowupMode,
  runPaywallFollowup,
  type Sender,
} from '@/lib/email/paywall-followup';
import { SupabasePaywallFollowupStore } from '@/lib/email/paywall-followup-store';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[paywall-followup] DISPATCH_SECRET is not set; refusing every request.');
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

/**
 * One attempt, never a retry, Idempotency-Key set by the caller. Same posture
 * as sendBillingLifecycleEmail: a failure comes back as {ok:false}, never as a
 * throw. From is the lifecycle sender (a real, read mailbox), and no Reply-To
 * is set, so a reply reaches the person the email says it comes from.
 */
const resendSender: Sender = async (email) => {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: 'no_api_key' };
  try {
    const resend = new Resend(key);
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

  const configured = paywallFollowupMode();
  if (configured === 'off') {
    return Response.json({ skipped: 'PAYWALL_FOLLOWUP_ENABLED is not on' }, { status: 200 });
  }
  const forceDry = new URL(request.url).searchParams.get('dry_run') === '1';
  const mode = forceDry ? 'dry_run' : configured;

  const started = Date.now();
  const store = new SupabasePaywallFollowupStore(createServiceRoleClient());

  try {
    const report = await runPaywallFollowup({
      store,
      mode,
      send: mode === 'send' ? resendSender : undefined,
      maxSends: paywallFollowupMaxPerRun(),
      outOfTime: () => budgetExhausted(started, Date.now()),
    });
    const body = {
      ok: true,
      ...report,
      consentColumnMissing: store.consentColumnMissing,
      // Per-candidate lines only in a dry run, where reviewing them is the point.
      entries: mode === 'dry_run' ? report.entries.slice(0, 200) : undefined,
    };
    console.log('[paywall-followup]', JSON.stringify({ ...body, entries: undefined }));
    return Response.json(body, { status: 200 });
  } catch (err) {
    console.error('[paywall-followup] run failed:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'run_failed' }, { status: 500 });
  }
}
