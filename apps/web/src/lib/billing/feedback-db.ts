/**
 * Writes to `public.cancellation_feedback` (migration 20261024220000), through
 * the normal service-role client: the generated types include the table.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { CancelReason } from '@/lib/billing/cancel-reasons';
import type { Database } from '@/types/database.types';

export type CancellationFeedbackSource = 'billing_card' | 'cancel_email';

/** What the app writes. Narrower than the table's Insert type, on purpose. */
export type CancellationFeedbackInsert = {
  stripe_customer_id: string | null;
  user_id: string | null;
  subscription_id: string;
  period_end: string | null;
  reason: CancelReason;
  detail: string | null;
  source: CancellationFeedbackSource;
};

/**
 * One answer per cancellation: a resubmit (a second tap in the email, or the
 * card after the email) replaces the first answer rather than adding a row.
 * The conflict target is the table's UNIQUE NULLS NOT DISTINCT
 * (subscription_id, period_end). Returns false on any database error.
 */
export async function upsertCancellationFeedback(
  db: SupabaseClient<Database>,
  row: CancellationFeedbackInsert,
): Promise<boolean> {
  const { error } = await db
    .from('cancellation_feedback')
    .upsert(row, { onConflict: 'subscription_id,period_end' });
  if (error) {
    console.error('[cancellation-feedback] upsert failed', { code: error.code, message: error.message });
    return false;
  }
  return true;
}
