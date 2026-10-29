/**
 * The webhook's entry points for the abandoned-checkout reminder: the Resend
 * sender and the Supabase store wired to abandoned-checkout.ts. Both functions
 * NEVER THROW: they run in `after()`, past the webhook's 200, and a reminder
 * that fails must not touch anyone's billing.
 */

import type Stripe from 'stripe';
import { createResend } from '@/lib/email/resend';

import { createServiceRoleClient } from '@/lib/supabase/service';
import { lifecycleFrom } from '@/lib/email/lifecycle';
import {
  checkoutSessionIdOrNull,
  handleExpiredSession,
  recordRecovery,
  type ExpiredSession,
  type Sender,
} from '@/lib/email/abandoned-checkout';
import { SupabaseReminderStore } from '@/lib/email/abandoned-checkout-store';

function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_.:\- ]{1,120}$/i.test(value) ? value : 'unexpected_response';
}

/**
 * One attempt, never a retry, Idempotency-Key set by the caller. From is the
 * lifecycle sender (a real, read mailbox) with no Reply-To, so "reply and tell
 * me" reaches the person the email says it comes from.
 */
const resendSender: Sender = async (email) => {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: 'no_api_key' };
  try {
    const resend = createResend(key);
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

export function toExpiredSession(session: Stripe.Checkout.Session): ExpiredSession {
  return {
    id: session.id,
    mode: session.mode ?? null,
    status: session.status ?? null,
    created: session.created,
    expiresAt: session.expires_at ?? null,
    locale: session.locale ?? null,
    metadata: (session.metadata as Record<string, string> | null) ?? null,
  };
}

/** checkout.session.expired. Logs the outcome by session id, never the person. */
export async function remindAbandonedCheckout(session: Stripe.Checkout.Session): Promise<void> {
  try {
    const outcome = await handleExpiredSession({
      session: toExpiredSession(session),
      store: new SupabaseReminderStore(createServiceRoleClient()),
      send: resendSender,
    });
    console.log('[abandoned-checkout] %s: %s', session.id, outcome);
  } catch (err) {
    console.error('[abandoned-checkout] %s: failed, swallowed: %s', session.id, err instanceof Error ? err.message : String(err));
  }
}

/** checkout.session.completed. Credits the newest reminder row, sent or holdout. */
export async function creditAbandonedCheckout(session: Stripe.Checkout.Session): Promise<void> {
  const userId = session.metadata?.user_id;
  if (!userId) return;
  try {
    const result = await recordRecovery({
      userId,
      completedSessionId: session.id,
      recoveredFrom: checkoutSessionIdOrNull(session.metadata?.recovered_from),
      store: new SupabaseReminderStore(createServiceRoleClient()),
    });
    if (result === 'recovered') console.log('[abandoned-checkout] %s: recovery recorded', session.id);
  } catch (err) {
    console.error('[abandoned-checkout] %s: recovery write failed, swallowed: %s', session.id, err instanceof Error ? err.message : String(err));
  }
}
