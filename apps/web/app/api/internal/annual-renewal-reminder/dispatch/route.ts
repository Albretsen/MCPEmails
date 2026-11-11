/**
 * POST /api/internal/annual-renewal-reminder/dispatch
 *
 * Queues the annual renewal reminder (src/lib/billing/annual-renewal-reminder.ts)
 * for every annual subscription renewing in 27 to 30 days. Called daily by
 * pg_cron through public.dispatch_annual_renewal_reminder() (migration
 * 20261111140200). The rows are sent by the billing lifecycle dispatcher.
 *
 * MODES. ANNUAL_RENEWAL_REMINDER_ENABLED off (default) answers `skipped` and
 * reads nothing. dry_run reads and reports without writing. on queues.
 * `?dry_run=1` forces a dry run whatever the flag says (unless it is off), and
 * only a dry run accepts `?horizon_days=N` (30..400) to look further ahead.
 *
 * AUTH. `X-Dispatch-Secret`, constant-time compared against DISPATCH_SECRET,
 * as the other dispatchers. No body is read. Output is counts and masked
 * addresses only.
 */

import { timingSafeEqual } from 'node:crypto';

import { createServiceRoleClient } from '@/lib/supabase/service';
import {
  annualRenewalReminderMode,
  runAnnualRenewalReminder,
  stripeRenewalReader,
} from '@/lib/billing/annual-renewal-reminder';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[annual-renewal] DISPATCH_SECRET is not set; refusing every request.');
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
  const configured = annualRenewalReminderMode();
  if (configured === 'off') {
    return Response.json({ ok: true, skipped: 'ANNUAL_RENEWAL_REMINDER_ENABLED=off' });
  }
  const params = new URL(request.url).searchParams;
  const mode = params.get('dry_run') === '1' ? 'dry_run' : configured;
  const horizonRaw = Number(params.get('horizon_days'));
  try {
    const report = await runAnnualRenewalReminder({
      db: createServiceRoleClient(),
      stripe: await stripeRenewalReader(),
      mode,
      ...(mode === 'dry_run' && Number.isFinite(horizonRaw) && horizonRaw > 0 ? { horizonDays: horizonRaw } : {}),
    });
    console.log('[annual-renewal]', JSON.stringify({ ...report, wouldQueue: report.wouldQueue.length }));
    return Response.json({ ok: true, ...report });
  } catch (err) {
    console.error('[annual-renewal] run failed:', err instanceof Error ? err.message : String(err));
    return Response.json({ ok: false, error: 'run_failed' }, { status: 500 });
  }
}
