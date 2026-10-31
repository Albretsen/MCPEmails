/**
 * POST /api/internal/forward-notices/dispatch
 *
 * Sends the emails about rule forwards waiting for approval. Called every minute
 * by pg_cron through public.dispatch_forward_approval_notices(), only when a
 * notice is due. Every rule is in src/lib/approvals/forward-notices.ts.
 *
 * AUTH. `X-Dispatch-Secret`, constant-time compared against DISPATCH_SECRET. No
 * body is read: the route claims its own work, so a caller holding the secret
 * cannot choose who gets mail.
 *
 * OUTPUT. Counts only, never an address.
 */
import { timingSafeEqual } from 'node:crypto';

import { dispatchForwardNotices, type NoticeSender } from '@/lib/approvals/forward-notices';
import { SupabaseForwardNoticeStore } from '@/lib/approvals/forward-notices-store';
import { createResend } from '@/lib/email/resend';
import { createServiceRoleClient } from '@/lib/supabase/service';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const SUPPORT_ADDRESS = 'support@mcpemails.com';
const DEFAULT_FROM = 'MCPEmails <hello@mcpemails.com>';

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[forward-notices] DISPATCH_SECRET is not set; refusing every request.');
    return false;
  }
  const provided = request.headers.get('x-dispatch-secret') ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Keep anything unexpected out of the ledger and the logs verbatim. */
function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_.:\- ]{1,120}$/i.test(value) ? value : 'unexpected_response';
}

const resendSender: NoticeSender = async (email) => {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: 'no_api_key' };
  try {
    const { data, error } = await createResend(key).emails.send(
      {
        from: process.env.BILLING_EMAIL_FROM ?? DEFAULT_FROM,
        replyTo: SUPPORT_ADDRESS,
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: {
          'List-Unsubscribe': `<${email.unsubscribe}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
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
  const summary = await dispatchForwardNotices(
    new SupabaseForwardNoticeStore(createServiceRoleClient()),
    resendSender,
  );
  return Response.json({ ok: true, ...summary });
}
