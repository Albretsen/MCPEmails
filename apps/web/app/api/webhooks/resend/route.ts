/**
 * POST /api/webhooks/resend
 *
 * Resend delivery feedback. `email.complained` and permanent `email.bounced`
 * set `users.unsubscribed_at` (the existing global opt-out from every
 * non-transactional email) for the recipient, so the paywall follow-up and
 * the billing win-backs stop, while receipts, dunning, invites and auth mail
 * keep sending. Every rule and the reasoning live in
 * src/lib/email/resend-webhook.ts.
 *
 * AUTH. Svix signature over the RAW body (svix-id / svix-timestamp /
 * svix-signature), checked against RESEND_WEBHOOK_SECRET (the endpoint's
 * `whsec_...` signing secret from the Resend dashboard). Unset secret: 500 on
 * every request, never processed unsigned. Missing or invalid signature: 401.
 *
 * RESPONSES. 2xx for everything handled or deliberately ignored (other event
 * types, transient bounces, unknown recipients), so Svix stops retrying. 500
 * only when the database write failed, so Svix retries; the write is
 * idempotent, so a retry or a replay of the same svix-id is harmless.
 *
 * LOGS carry counts and the event type, never an address.
 */

import { NextResponse } from 'next/server';

import { createServiceRoleClient } from '@/lib/supabase/service';
import { applySuppression, classifyResendEvent, verifySvixSignature } from '@/lib/email/resend-webhook';
import { SupabaseSuppressionStore } from '@/lib/email/resend-webhook-store';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request): Promise<NextResponse> {
  // Read at call time: a module-scope capture survives a warm lambda.
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[resend-webhook] RESEND_WEBHOOK_SECRET is not set; refusing every request.');
    return NextResponse.json({ error: 'Webhook not configured.' }, { status: 500 });
  }

  const body = await request.text();
  const verified = verifySvixSignature({
    secret,
    id: request.headers.get('svix-id'),
    timestamp: request.headers.get('svix-timestamp'),
    signature: request.headers.get('svix-signature'),
    body,
  });
  if (!verified.ok) {
    console.warn(`[resend-webhook] rejected: ${verified.reason}`);
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    // Signed but unparseable: retrying will not fix it.
    return NextResponse.json({ ignored: 'malformed' }, { status: 200 });
  }

  const classified = classifyResendEvent(payload);
  if (classified.action === 'ignore') {
    return NextResponse.json({ ignored: classified.reason }, { status: 200 });
  }

  try {
    const outcome = await applySuppression(new SupabaseSuppressionStore(createServiceRoleClient()), classified);
    console.log('[resend-webhook]', JSON.stringify(outcome));
    return NextResponse.json({ ok: true, ...outcome }, { status: 200 });
  } catch (err) {
    console.error('[resend-webhook] suppression failed:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Suppression failed.' }, { status: 500 });
  }
}
