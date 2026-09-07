/**
 * The numbers behind /admin/growth/dunning.
 *
 * THE QUESTION THIS ANSWERS is "did anyone get a dunning email, and did it
 * work". Before this there was nothing: the queue was a table nobody looked at,
 * and the only way to know whether a customer had been written to about their
 * failed card was to open a SQL client. A recovery mechanism you cannot see is
 * one you cannot tell is broken, and the way this feature fails is silently.
 *
 * WHAT "RECOVERED" MEANS HERE, EXACTLY.
 *
 * A dunning sequence counts as recovered when at least one of its emails was
 * SENT and the sequence was then cancelled with reason `payment_recovered`. In
 * plain terms: we wrote to them about the failed card, and afterwards the money
 * arrived.
 *
 * That is a correlation and the page says so. Stripe retries the card on its
 * own schedule whether or not we send anything, so some of these would have
 * recovered in silence. The honest counterpart is printed next to it: sequences
 * that recovered BEFORE any email went out, which is Stripe's retry working
 * unaided. The gap between the two is the only thing resembling a measurement
 * available at this volume, and with six paying subscriptions it is a handful
 * of cases, not a rate.
 *
 * NO PERCENTAGES BELOW A DENOMINATOR. Same rule as every other panel on the
 * growth board. At n=1 a percentage is a decoration on a coin flip.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Percentages are withheld until a denominator can carry one. */
export const MIN_SEQUENCES_FOR_RATE = 5;

export interface DunningRow {
  template: string;
  category: string | null;
  stripe_customer_id: string;
  scope_key: string;
  send_after: string;
  sent_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  last_error: string | null;
  attempts: number | null;
  recipient: string;
  payload: { amountCents?: number | null; currency?: string | null; planId?: string | null } | null;
}

export interface StateCounts {
  pending: number;
  due: number;
  sent: number;
  cancelled: number;
  failing: number;
}

export interface RecoveryCounts {
  /** Dunning sequences that reached at least one send. */
  emailed: number;
  /** Emailed, then the invoice was paid. */
  recoveredAfterEmail: number;
  /** Paid before any email went out: Stripe's own retry, unaided. */
  recoveredBeforeEmail: number;
  /** Cash on the invoices in `recoveredAfterEmail`, in minor units. */
  recoveredCents: number;
  currency: string;
}

export interface DunningSummary {
  states: StateCounts;
  byTemplate: Array<{ template: string; sent: number; pending: number; cancelled: number }>;
  recovery: RecoveryCounts;
  /** Cancellations grouped by why, so "suppressed" cannot hide inside "cancelled". */
  cancelReasons: Array<{ reason: string; count: number }>;
  /** Rows that have failed at least once and are not finished. The alarm. */
  stuck: Array<{
    template: string;
    scope: string;
    attempts: number;
    lastError: string | null;
    dueSince: string;
  }>;
  lastSentAt: string | null;
  total: number;
}

/** `asgeir@mcpemails.com` to `a****r@mcpemails.com`. */
export function maskAddress(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '****';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local[0] ?? '*'}****${domain}`;
  return `${local[0]}****${local[local.length - 1]}${domain}`;
}

const DUNNING_TEMPLATES = new Set(['dunning_1', 'dunning_3', 'dunning_7', 'dunning_14']);

/**
 * ATTEMPTS >= 5 is the point claim_billing_emails stops handing a row out. A
 * row that reaches it is not retried again and will sit in the table unsent
 * until somebody looks, which is what the "needs a person" list is for.
 */
const MAX_ATTEMPTS = 5;

export function summariseDunning(rows: DunningRow[], now = new Date()): DunningSummary {
  const states: StateCounts = { pending: 0, due: 0, sent: 0, cancelled: 0, failing: 0 };
  const perTemplate = new Map<string, { sent: number; pending: number; cancelled: number }>();
  const reasons = new Map<string, number>();
  const stuck: DunningSummary['stuck'] = [];
  let lastSentAt: string | null = null;

  // A dunning "sequence" is one (customer, invoice) pair: four rows sharing a
  // scope_key. Recovery is a property of the sequence, not of a row.
  const sequences = new Map<string, { sent: boolean; recovered: boolean; cents: number; currency: string }>();

  for (const row of rows) {
    const bucket =
      perTemplate.get(row.template) ?? { sent: 0, pending: 0, cancelled: 0 };
    perTemplate.set(row.template, bucket);

    if (row.sent_at) {
      states.sent += 1;
      bucket.sent += 1;
      if (!lastSentAt || row.sent_at > lastSentAt) lastSentAt = row.sent_at;
    } else if (row.cancelled_at) {
      states.cancelled += 1;
      bucket.cancelled += 1;
      const reason = row.cancel_reason ?? 'unknown';
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    } else {
      states.pending += 1;
      bucket.pending += 1;
      if (Date.parse(row.send_after) <= now.getTime()) states.due += 1;
      const attempts = row.attempts ?? 0;
      if (attempts > 0) {
        states.failing += 1;
        // Only the ones nothing will pick up again are worth a person's time.
        if (attempts >= MAX_ATTEMPTS) {
          stuck.push({
            template: row.template,
            scope: row.scope_key,
            attempts,
            lastError: row.last_error,
            dueSince: row.send_after,
          });
        }
      }
    }

    if (!DUNNING_TEMPLATES.has(row.template)) continue;
    const key = `${row.stripe_customer_id}:${row.scope_key}`;
    const seq =
      sequences.get(key) ?? {
        sent: false,
        recovered: false,
        cents: 0,
        currency: (row.payload?.currency ?? 'usd').toLowerCase(),
      };
    if (row.sent_at) seq.sent = true;
    if (row.cancel_reason === 'payment_recovered') seq.recovered = true;
    // The amount is identical on every row of a sequence; take it once.
    if (!seq.cents && row.payload?.amountCents) seq.cents = row.payload.amountCents;
    sequences.set(key, seq);
  }

  const recovery: RecoveryCounts = {
    emailed: 0,
    recoveredAfterEmail: 0,
    recoveredBeforeEmail: 0,
    recoveredCents: 0,
    currency: 'usd',
  };
  for (const seq of sequences.values()) {
    if (seq.sent) recovery.emailed += 1;
    if (!seq.recovered) continue;
    if (seq.sent) {
      recovery.recoveredAfterEmail += 1;
      recovery.recoveredCents += seq.cents;
      recovery.currency = seq.currency;
    } else {
      recovery.recoveredBeforeEmail += 1;
    }
  }

  return {
    states,
    byTemplate: [...perTemplate.entries()]
      .map(([template, counts]) => ({ template, ...counts }))
      .sort((a, b) => a.template.localeCompare(b.template)),
    recovery,
    cancelReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    stuck: stuck.sort((a, b) => a.dueSince.localeCompare(b.dueSince)),
    lastSentAt,
    total: rows.length,
  };
}

/**
 * Every row in the queue, paged.
 *
 * PostgREST silently truncates a row-returning select at 1000 however large the
 * requested limit, so this pages with `.range()` rather than asking for
 * everything and believing the answer. The table holds a few hundred rows a
 * year and is pruned at 180 days, so this is one request in practice and two
 * only if something has gone very wrong, which is exactly when a truncated
 * count would mislead.
 */
export async function fetchDunningRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  hardCap = 5000,
): Promise<{ rows: DunningRow[]; truncated: boolean }> {
  const PAGE = 1000;
  const rows: DunningRow[] = [];

  for (let from = 0; from < hardCap; from += PAGE) {
    const { data, error } = await db
      .from('billing_email_sends')
      .select(
        'template, category, stripe_customer_id, scope_key, send_after, sent_at, cancelled_at, cancel_reason, last_error, attempts, recipient, payload',
      )
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1);

    if (error) throw new Error(error.message);
    const page = (data ?? []) as DunningRow[];
    rows.push(...page);
    if (page.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}
