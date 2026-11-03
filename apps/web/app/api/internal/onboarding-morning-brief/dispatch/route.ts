/**
 * POST /api/internal/onboarding-morning-brief/dispatch
 *
 * Sends the one "Email me this tomorrow at 8" email (onboarding A9, WP-F) for
 * every opt-in whose send_at has passed. Called every 15 minutes by pg_cron
 * (dispatch-onboarding-morning-brief, migration 20261026221917), which only
 * posts when something is due.
 *
 * ONCE. Each row is claimed (status scheduled -> claimed) with a conditional
 * update before the send, then marked sent or failed. A claimed or failed row
 * is never retried. Rows older than 24 hours past due are skipped, not sent:
 * a "tomorrow at 8" email that arrives in the afternoon two days later is
 * worse than none.
 *
 * WHO. Only the opted-in user's own address, read from public.users. v1:
 * internal accounts only, checked again here, plus the global opt-out.
 *
 * AUTH. X-Dispatch-Secret, constant-time compared against DISPATCH_SECRET.
 * No body is read.
 */
import { timingSafeEqual } from 'node:crypto';

import { createResend } from '@/lib/email/resend';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { lifecycleFrom, lifecycleReplyTo } from '@/lib/email/lifecycle';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import { isInternalViewer } from '@/lib/onboarding/variant';
import { assistLocale, morningBriefEmail } from '@/lib/onboarding/assist';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const MAX_PER_RUN = 50;
const STALE_MS = 24 * 60 * 60 * 1000;

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(request.headers.get('x-dispatch-secret') ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorised(request)) return Response.json({ error: 'Forbidden' }, { status: 403 });
  const db = createServiceRoleClient();
  const now = Date.now();
  const { data: due, error } = await db
    .from('onboarding_morning_brief_optins')
    .select('workspace_id, user_id, locale, client, send_at')
    .eq('status', 'scheduled')
    .lte('send_at', new Date(now).toISOString())
    .order('send_at', { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) return Response.json({ error: 'read_failed' }, { status: 500 });

  const report = { due: due?.length ?? 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of due ?? []) {
    const finish = (status: 'sent' | 'failed' | 'skipped') => db.from('onboarding_morning_brief_optins')
      .update({ status, sent_at: status === 'sent' ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
      .eq('workspace_id', row.workspace_id);

    const { data: claimed } = await db.from('onboarding_morning_brief_optins')
      .update({ status: 'claimed', updated_at: new Date().toISOString() })
      .eq('workspace_id', row.workspace_id)
      .eq('status', 'scheduled')
      .select('workspace_id');
    if (!claimed?.length) continue;

    const { data: user } = await db.from('users').select('email, unsubscribed_at').eq('id', row.user_id).maybeSingle();
    const email = user?.email ?? null;
    const stale = now - Date.parse(row.send_at) > STALE_MS;
    if (!email || user?.unsubscribed_at || stale || !(await isInternalViewer(email, db))) {
      await finish('skipped');
      report.skipped += 1;
      continue;
    }

    const key = process.env.RESEND_API_KEY;
    const message = morningBriefEmail(assistLocale(row.locale), row.client);
    let ok = false;
    if (key) {
      try {
        const { error: sendError } = await createResend(key).emails.send(
          { from: lifecycleFrom(), to: email, replyTo: lifecycleReplyTo(), subject: message.subject, html: message.html, text: message.text },
          { idempotencyKey: `onboarding-morning-brief-${row.workspace_id}-${row.send_at}` },
        );
        ok = !sendError;
      } catch {
        ok = false;
      }
    }
    await finish(ok ? 'sent' : 'failed');
    if (ok) {
      report.sent += 1;
      await recordProductFunnelEvent(db, { workspaceId: row.workspace_id, stage: 'morning_brief_sent', outcome: 'success', category: 'unknown' });
    } else {
      report.failed += 1;
    }
  }
  return Response.json({ ok: true, ...report });
}
