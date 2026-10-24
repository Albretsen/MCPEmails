/**
 * "Is this pass notice still true?", asked by the billing lifecycle dispatcher
 * immediately before it sends pass_ending_7d or pass_ended. Reads user_passes
 * and user_billing, never Stripe. See pass-notices.ts for the queue side.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { hasEntitledSubscription, type BillingSnapshot, type PassStatus } from '@/lib/billing/pass';
import { RETRY_REASON, type Freshness } from '@/lib/billing/dispatch-freshness';

type Db = SupabaseClient<Database>;

// ---------------------------------------------------------------------------
// Freshness, asked by the dispatcher before every pass notice
// ---------------------------------------------------------------------------

interface PassRowForNotice {
  id: string;
  user_id: string;
  starts_at: string;
  ends_at: string;
  status: PassStatus;
}

/** Pure: is this notice still true, given what is stored now? */
export function passNoticeFreshness(input: {
  template: string;
  pass: PassRowForNotice | null;
  userPasses: readonly PassRowForNotice[];
  billing: BillingSnapshot | null;
  now: Date;
}): Freshness {
  const { pass, now } = input;
  if (!pass) return { send: false, reason: 'no_longer_due' };
  if (pass.status === 'refunded') return { send: false, reason: 'pass_refunded' };
  if (hasEntitledSubscription(input.billing)) return { send: false, reason: 'subscription_started' };

  const end = Date.parse(pass.ends_at);
  // Another live pass starts at or after this one's end: this pass does not end.
  const followed = input.userPasses.some(
    (other) =>
      other.id !== pass.id &&
      (other.status === 'active' || other.status === 'scheduled') &&
      Date.parse(other.starts_at) >= end - 60_000 &&
      Date.parse(other.ends_at) > now.getTime(),
  );
  if (followed) return { send: false, reason: 'pass_renewed' };

  if (input.template === 'pass_ending_7d') {
    // Past the end: the pass_ended notice says it instead.
    if (now.getTime() >= end) return { send: false, reason: 'no_longer_due' };
    return { send: true };
  }
  if (input.template === 'pass_ended') {
    if (now.getTime() < end) return { send: false, reason: RETRY_REASON };
    return { send: true };
  }
  return { send: false, reason: 'no_longer_due' };
}

/** The dispatcher's read for one pass notice row. A read failure retries. */
export async function checkPassNoticeFreshness(
  db: Db,
  row: { id: number; template: string; scope_key: string; user_id: string | null },
  now: Date = new Date(),
): Promise<Freshness> {
  try {
    const passes = db as unknown as {
      from(table: 'user_passes'): {
        select(columns: string): {
          eq(column: string, value: string): PromiseLike<{
            data: PassRowForNotice[] | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
    const { data: own, error: ownError } = await passes
      .from('user_passes')
      .select('id, user_id, starts_at, ends_at, status')
      .eq('id', row.scope_key);
    if (ownError) throw new Error(ownError.message);
    const pass = own?.[0] ?? null;
    if (!pass) return { send: false, reason: 'no_longer_due' };

    const [{ data: userPasses, error: listError }, { data: billing, error: billingError }] = await Promise.all([
      passes.from('user_passes').select('id, user_id, starts_at, ends_at, status').eq('user_id', pass.user_id),
      db.from('user_billing').select('plan, subscription_status').eq('user_id', pass.user_id).maybeSingle(),
    ]);
    if (listError) throw new Error(listError.message);
    if (billingError) throw new Error(billingError.message);

    return passNoticeFreshness({
      template: row.template,
      pass,
      userPasses: userPasses ?? [],
      billing: (billing as BillingSnapshot | null) ?? null,
      now,
    });
  } catch (err) {
    console.error(`[pass-notices] freshness check failed for row ${row.id}:`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { send: false, reason: RETRY_REASON };
  }
}
