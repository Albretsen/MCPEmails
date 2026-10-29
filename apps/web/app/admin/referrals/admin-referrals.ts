import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

/**
 * Reads and CSV shaping for /admin/referrals. Service-role only: the three
 * referral tables have no user policy that would show another person's rows.
 *
 * Every read pages with .range() under a total order (PostgREST cuts a select
 * off at 1000 rows without an error).
 */

type Db = SupabaseClient<Database>;
export type ReviewRow = Pick<
  Database['public']['Tables']['referrals']['Row'],
  'id' | 'status' | 'hold_reason' | 'void_reason' | 'attached_via' | 'attached_at' | 'first_charge_at' | 'qualifies_at' | 'updated_at' | 'referrer_user_id' | 'friend_user_id'
>;
export type RewardRow = Database['public']['Tables']['referral_rewards']['Row'];

const PAGE = 1000;
/** The review list is for reading, not for bookkeeping: a ceiling, said on the page. */
export const REVIEW_LIMIT = 500;

export async function fetchReviewRows(db: Db): Promise<{ rows: ReviewRow[]; truncated: boolean }> {
  const { data, error } = await db
    .from('referrals')
    .select('id, status, hold_reason, void_reason, attached_via, attached_at, first_charge_at, qualifies_at, updated_at, referrer_user_id, friend_user_id')
    .in('status', ['held', 'voided'])
    .order('updated_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(REVIEW_LIMIT + 1);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ReviewRow[];
  return { rows: rows.slice(0, REVIEW_LIMIT), truncated: rows.length > REVIEW_LIMIT };
}

export async function fetchAllRewards(db: Db): Promise<RewardRow[]> {
  const out: RewardRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('referral_rewards')
      .select('id, referral_id, side, kind, amount_cents, currency, stripe_customer_id, stripe_balance_txn_id, entitlement_until, issued_at')
      .order('issued_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as RewardRow[];
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

/** The first eight characters of a uuid: enough to find a row, not a whole identifier on screen. */
export function shortId(id: string | null | undefined): string {
  return id ? String(id).slice(0, 8) : '';
}

/** RFC 4180 field: quoted when it holds a comma, quote or line break; a leading = + - @ is defused for spreadsheets. */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const REWARD_CSV_COLUMNS = [
  'issued_at', 'reward_id', 'referral_id', 'side', 'kind', 'amount_cents', 'amount', 'currency',
  'stripe_customer_id', 'stripe_balance_txn_id', 'entitlement_until',
] as const;

/**
 * One line per reward row, oldest first. `amount` is the decimal amount in the
 * row's currency, and a clawback side carries a positive amount like the rest:
 * the side says which way it went. For bookkeeping the credit is a discount.
 */
export function rewardsCsv(rows: RewardRow[]): string {
  const lines = [REWARD_CSV_COLUMNS.join(',')];
  for (const r of rows) {
    const amount = typeof r.amount_cents === 'number' ? (r.amount_cents / 100).toFixed(2) : '';
    lines.push([
      r.issued_at, r.id, r.referral_id, r.side, r.kind, r.amount_cents, amount, r.currency,
      r.stripe_customer_id, r.stripe_balance_txn_id, r.entitlement_until,
    ].map(csvField).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
