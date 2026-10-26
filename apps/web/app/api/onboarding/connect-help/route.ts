/**
 * POST /api/onboarding/connect-help
 *
 * "Send this error to support" on the onboarding inbox step, shown after the
 * second failed connect (plan A5). It files an ordinary support ticket through
 * the /help form's own path (src/lib/support/tickets.ts: validation, rate
 * limits, storage, the support notification and the confirmation email).
 *
 * The browser sends closed-list facts only; the subject and message are
 * written here. Never the password, never the mailbox's own answer:
 *   { provider, code, reason?, phase?, host?, attempts?, note? }
 * `host` is the mail server name the route already returned (a plain hostname
 * or dropped). `note` is optional free text from the user, capped.
 *
 * Same release gate as /api/support/tickets (SUPPORT_RELEASE_GATE): a viewer
 * who cannot see Help & support gets the unmatched-path 404, and the panel
 * then shows the /help link instead.
 */
import { createServiceRoleClient } from '@/lib/supabase/service';
import { getTicketContextPreview } from '@/lib/support/context';
import { sendSupportConfirmationEmail, sendSupportTicketEmail } from '@/lib/support/emails';
import { FORM_MIN_FILL_MS, issueSupportFormToken } from '@/lib/support/form-token';
import { supportJson, supportMethodNotAllowed, supportNotFound } from '@/lib/support/http';
import { clientIp, hashSupportIp } from '@/lib/support/ip';
import { createSupabaseTicketStore, submitSupportTicket } from '@/lib/support/tickets';
import { getSupportViewer } from '@/lib/support/viewer';
import { buildConnectHelpTicket } from '@/lib/onboarding/connect-help';

export async function POST(request: Request): Promise<Response> {
  const viewer = await getSupportViewer();
  if (!viewer.visible) return supportNotFound(); // SUPPORT_RELEASE_GATE
  if (!viewer.user) return supportJson({ ok: false, error: 'invalid_email' }, 401);

  const raw = await request.text().catch(() => '');
  if (raw.length > 8 * 1024) return supportJson({ ok: false, error: 'message_too_long' }, 400);
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return supportJson({ ok: false, error: 'invalid_json' }, 400);
  }

  const ticket = buildConnectHelpTicket(body);
  if (!ticket) return supportJson({ ok: false, error: 'invalid_json' }, 400);

  let store;
  try {
    store = createSupabaseTicketStore(createServiceRoleClient());
  } catch (err) {
    console.error('[onboarding/connect-help] service client unavailable:', err instanceof Error ? err.message : String(err));
    return supportJson({ ok: false, error: 'server_error' }, 500);
  }

  // The form token exists to slow bots that post straight to the ticket API.
  // This request comes from a signed-in user pressing a button on a form we
  // rendered and wrote ourselves, so the token is issued here, dated past the
  // minimum fill time.
  const formToken = issueSupportFormToken(Date.now() - FORM_MIN_FILL_MS - 1000);
  const outcome = await submitSupportTicket(
    {
      rawBody: JSON.stringify({ ...ticket, formToken }),
      user: viewer.user,
      ipHash: hashSupportIp(clientIp(request.headers)),
    },
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
