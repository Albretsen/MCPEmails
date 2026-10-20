/**
 * POST /api/legal/contract-request: the public cancellation and withdrawal
 * form on /cancel.
 *
 * Public on purpose, with no release gate and no session: §312k BGB and the
 * withdrawal function of Directive (EU) 2023/2673 both require that a
 * customer can end the contract without logging in. Abuse is bounded by the
 * honeypot, the signed form token and the support rate limits; the flow lives
 * in src/lib/legal/contract-request.ts.
 */
import {
  createSupabaseContractRequestStore,
  sendViaResend,
  submitContractRequest,
} from '@/lib/legal/contract-request';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { SUPPORT_INBOX } from '@/lib/support/emails';
import { supportJson, supportMethodNotAllowed } from '@/lib/support/http';
import { clientIp, hashSupportIp } from '@/lib/support/ip';

/** Far above any valid request (a 2000-character CJK reason is ~6 KB). */
const MAX_BODY_BYTES = 32 * 1024;

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text().catch(() => '');
  if (rawBody.length > MAX_BODY_BYTES) return supportJson({ ok: false, error: 'reason_too_long' }, 400);

  let store;
  try {
    store = createSupabaseContractRequestStore(createServiceRoleClient());
  } catch (err) {
    console.error('[contract-request] service client unavailable:', err instanceof Error ? err.message : String(err));
    return supportJson({ ok: false, error: 'server_error' }, 500);
  }

  const outcome = await submitContractRequest(
    { rawBody, ipHash: hashSupportIp(clientIp(request.headers)) },
    {
      store,
      sendNotice: (email, replyTo, ref) => sendViaResend('notice', ref, { to: SUPPORT_INBOX, replyTo, ...email }),
      sendReceipt: (email, to, ref) => sendViaResend('receipt', ref, { to, replyTo: SUPPORT_INBOX, ...email }),
      now: Date.now,
      baseUrl: (process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com').replace(/\/+$/, ''),
    },
  );
  return supportJson(outcome.body, outcome.status);
}

async function otherMethod(): Promise<Response> {
  return supportMethodNotAllowed('POST');
}

export const GET = otherMethod;
export const HEAD = otherMethod;
export const PUT = otherMethod;
export const PATCH = otherMethod;
export const DELETE = otherMethod;
export const OPTIONS = otherMethod;
