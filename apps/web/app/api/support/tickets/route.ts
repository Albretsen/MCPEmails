/**
 * POST /api/support/tickets: file a support ticket from the /help form.
 *
 * Thin by design; the flow lives in src/lib/support/tickets.ts.
 * While Help & support is internal-only, every method answers a non-visible
 * caller with the same 404 as an unmatched /api path, and a visible caller
 * with 405 on anything but POST.
 */
import { createServiceRoleClient } from '@/lib/supabase/service';
import { getTicketContextPreview } from '@/lib/support/context';
import { sendSupportConfirmationEmail, sendSupportTicketEmail } from '@/lib/support/emails';
import { supportJson, supportMethodNotAllowed, supportNotFound } from '@/lib/support/http';
import { clientIp, hashSupportIp } from '@/lib/support/ip';
import { readBodyWithLimit } from '@/lib/support/read-body';
import { createSupabaseTicketStore, submitSupportTicket } from '@/lib/support/tickets';
import { getSupportViewer } from '@/lib/support/viewer';

/** Far above any valid ticket (5000 chars of CJK is ~15 KB of UTF-8). */
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request): Promise<Response> {
  const viewer = await getSupportViewer();
  if (!viewer.visible) return supportNotFound(); // SUPPORT_RELEASE_GATE

  const read = await readBodyWithLimit(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return supportJson({ ok: false, error: read.reason === 'too_large' ? 'message_too_long' : 'invalid_json' }, 400);
  }
  const rawBody = read.text;

  let store;
  try {
    store = createSupabaseTicketStore(createServiceRoleClient());
  } catch (err) {
    console.error('[support] service client unavailable:', err instanceof Error ? err.message : String(err));
    return supportJson({ ok: false, error: 'server_error' }, 500);
  }

  const outcome = await submitSupportTicket(
    { rawBody, user: viewer.user, ipHash: hashSupportIp(clientIp(request.headers)) },
    {
      store,
      loadContext: getTicketContextPreview,
      sendTicket: sendSupportTicketEmail,
      sendConfirmation: sendSupportConfirmationEmail,
      now: Date.now,
    },
  );
  return supportJson(outcome.body, outcome.status);
}

async function otherMethod(): Promise<Response> {
  const viewer = await getSupportViewer();
  if (!viewer.visible) return supportNotFound(); // SUPPORT_RELEASE_GATE
  return supportMethodNotAllowed('POST');
}

export const GET = otherMethod;
export const HEAD = otherMethod;
export const PUT = otherMethod;
export const PATCH = otherMethod;
export const DELETE = otherMethod;
export const OPTIONS = otherMethod;
