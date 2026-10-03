import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

/**
 * Checkout-cancel feedback: the answer to "what stopped you?" on return from
 * an abandoned Stripe checkout.
 *
 * The funnel records that a checkout was abandoned and nothing about why. This
 * is the why, kept out of `product_funnel_events` because the "Other" answer is
 * free text and that table is a bounded vocabulary by design. See
 * supabase/migrations/20261002180000_checkout_cancel_feedback.sql.
 */

/**
 * The fixed answers, in the order the card shows them. `other` is last.
 *
 * `just_checking_price` is the honest exit for someone who was never going to
 * pay today, which cart-abandonment research puts as the single largest group;
 * without it they pick whichever real objection is nearest and pollute it. It
 * sits last of the fixed answers so it is not the easy first pick.
 * `payment_method` deliberately covers both "my card was refused" and "you do
 * not take what I pay with": Stripe already records a decline, and neither it
 * nor the funnel can see a missing method or the wrong currency.
 */
export const CHECKOUT_FEEDBACK_REASONS = [
  'price_too_high',
  'compare_plans',
  'want_to_try_first',
  'payment_method',
  'just_checking_price',
  'other',
] as const;

export type CheckoutFeedbackReason = (typeof CHECKOUT_FEEDBACK_REASONS)[number];

/** Matches the CHECK constraint on `checkout_cancel_feedback.detail`. */
export const CHECKOUT_FEEDBACK_DETAIL_MAX = 500;

/**
 * Answers accepted per workspace per 24 hours. The card shows once per
 * cancelled checkout, so a real user sends one; this only stops a script from
 * filling the table through an authenticated session.
 */
export const CHECKOUT_FEEDBACK_DAILY_LIMIT = 5;

export interface CheckoutFeedback {
  reason: CheckoutFeedbackReason;
  detail: string | null;
}

/**
 * Validate a request body. Returns null for anything that is not an answer.
 *
 * `detail` is kept only for `other`: a fixed answer with stray text attached
 * is still that fixed answer, and the column's CHECK refuses the combination.
 * An `other` with nothing typed is a valid answer (it says "none of these").
 * Text is trimmed and cut to the column limit rather than rejected, because
 * losing the first 500 characters of an honest answer over a length rule would
 * be the wrong trade.
 */
export function parseCheckoutFeedback(body: unknown): CheckoutFeedback | null {
  if (!body || typeof body !== 'object') return null;
  const { reason, detail } = body as Record<string, unknown>;
  if (typeof reason !== 'string') return null;
  if (!(CHECKOUT_FEEDBACK_REASONS as readonly string[]).includes(reason)) return null;

  let text: string | null = null;
  if (reason === 'other' && typeof detail === 'string') {
    const trimmed = detail.trim().slice(0, CHECKOUT_FEEDBACK_DETAIL_MAX);
    text = trimmed.length > 0 ? trimmed : null;
  }
  return { reason: reason as CheckoutFeedbackReason, detail: text };
}

/**
 * Store one answer. Best-effort and never throws: a feedback card must not be
 * able to produce an error on the page it sits on.
 *
 * `db` is the service-role client; the table has no member policy. `target` is
 * read here from the workspace's latest successful `checkout_started`, so the
 * plan an answer is filed under is the one the server saw them aim at.
 */
export async function recordCheckoutFeedback(
  db: SupabaseClient<Database>,
  input: { workspaceId: string; userId: string; feedback: CheckoutFeedback },
): Promise<void> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error: countError } = await db
      .from('checkout_cancel_feedback')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', input.workspaceId)
      .gte('created_at', since);
    if (countError) {
      console.error('[checkout-feedback] limit check failed', { error: countError.message });
      return;
    }
    if ((count ?? 0) >= CHECKOUT_FEEDBACK_DAILY_LIMIT) return;

    const { data: started } = await db
      .from('product_funnel_events')
      .select('category')
      .eq('workspace_id', input.workspaceId)
      .eq('stage', 'checkout_started')
      .eq('outcome', 'success')
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: row, error } = await db
      .from('checkout_cancel_feedback')
      .insert({
        workspace_id: input.workspaceId,
        user_id: input.userId,
        reason: input.feedback.reason,
        detail: input.feedback.detail,
        target: started?.category ?? null,
      })
      .select('id')
      .single();
    if (error || !row) {
      console.error('[checkout-feedback] insert failed', { error: error?.message ?? 'no row returned' });
      return;
    }

    // Tell the owner. Same pipeline as the signup mail: emit_system_event
    // writes the audit row and pokes the system-notify Edge Function, which
    // owns delivery. The payload is ids and the fixed reason only, per the
    // system_events contract: what the user typed and who they are stay in
    // their own tables and are read by the notifier at send time.
    const { error: notifyError } = await db.rpc('emit_system_event', {
      p_event_type: 'checkout.feedback',
      p_payload: { feedback_id: row.id, workspace_id: input.workspaceId, reason: input.feedback.reason },
    });
    if (notifyError) console.error('[checkout-feedback] notify failed', { error: notifyError.message });
  } catch (err) {
    console.error('[checkout-feedback] record failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
