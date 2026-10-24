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
import type { Database } from '@/types/database.types';
import { toUsdMinor } from '@/lib/analytics/fx';

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
  payload: {
    amountCents?: number | null;
    currency?: string | null;
    planId?: string | null;
    declineCode?: string | null;
  } | null;
  /** When the row was queued. All four rows of a sequence share it. */
  created_at?: string | null;
  /**
   * Set on a dunning sequence when it is cancelled as payment_recovered:
   * 'customer' | 'retry' | 'unknown'. Null before 20261024225000.
   */
  recovered_by?: string | null;
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
  /**
   * Cash on the invoices in `recoveredAfterEmail`, in USD minor units: each
   * invoice converted at the rate of the month its sequence started (fx.ts).
   */
  recoveredCents: number;
  /** Always 'usd'. */
  currency: string;
  /** Invoice currencies left out of `recoveredCents` for want of a rate. */
  otherCurrencies: string[];
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
  const sequences = new Map<string, { sent: boolean; recovered: boolean; cents: number; currency: string; month: string }>();

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
        month: row.send_after.slice(0, 7),
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
    otherCurrencies: [],
  };
  // Summed in USD. This used to add every invoice up as-is and label the total
  // with whichever currency came last, which adds euros to dollars.
  let recoveredUsd = 0;
  const other = new Set<string>();
  for (const seq of sequences.values()) {
    if (seq.sent) recovery.emailed += 1;
    if (!seq.recovered) continue;
    if (seq.sent) {
      recovery.recoveredAfterEmail += 1;
      const usd = toUsdMinor(seq.cents, seq.currency, seq.month);
      if (usd === null) other.add(seq.currency);
      else recoveredUsd += usd;
    } else {
      recovery.recoveredBeforeEmail += 1;
    }
  }
  recovery.recoveredCents = Math.round(recoveredUsd);
  recovery.otherCurrencies = [...other].sort();

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

// ---------------------------------------------------------------------------
// Outcomes: by decline code, recovery rate, who fixed it.
//
// One SEQUENCE is one (customer, scope_key) pair over the four dunning
// templates, exactly as in summariseDunning. Its outcome is:
//
//   recovered  a row was cancelled with payment_recovered;
//   lost       not recovered, and either a row was cancelled with
//              subscription_deleted, or a customer.subscription.deleted for the
//              same customer arrived after the sequence was queued. The second
//              clause catches a sequence whose four emails had all gone out
//              before Stripe closed the subscription, which leaves no
//              subscription_deleted row behind;
//   open       neither, yet.
//
// "Closed" is recovered + lost, and the recovery rate is recovered / closed,
// withheld below MIN_SEQUENCES_FOR_RATE closed sequences.
// ---------------------------------------------------------------------------

/** The decline code Stripe uses when the bank wants the customer to confirm (SCA). */
export const SCA_DECLINE_CODE = 'authentication_required';

export type SequenceOutcome = 'recovered' | 'lost' | 'open';
export type RecoveredBy = 'customer' | 'retry' | 'unknown' | 'not_recorded';

export interface DeclineCodeRow {
  /** The decline code, or null when Stripe gave none. */
  code: string | null;
  /** True for authentication_required, which the page labels on its own. */
  sca: boolean;
  sequences: number;
  recovered: number;
  lost: number;
  open: number;
}

export interface OutcomeSummary {
  sequences: number;
  recovered: number;
  lost: number;
  open: number;
  /** recovered + lost: the denominator of the recovery rate. */
  closed: number;
  /** recovered / closed, or null while closed is below MIN_SEQUENCES_FOR_RATE. */
  recoveryRate: number | null;
  /** Median days from the first queued row to the payment_recovered cancel. */
  medianDaysToRecover: number | null;
  /** How many recovered sequences the median is taken over. */
  recoveredWithTiming: number;
  /** SCA first, then by sequence count. */
  byDeclineCode: DeclineCodeRow[];
  /** Recovered sequences by who fixed it. */
  recoveredBy: Record<RecoveredBy, number>;
}

/** One customer.subscription.deleted, from stripe_webhook_events. */
export interface DeletionRow {
  stripe_customer_id: string | null;
  event_created: string | null;
  /** Stripe cancellation_details.reason; null on rows from before it was recorded. */
  cancellation_reason: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function normaliseRecoveredBy(value: string | null | undefined): RecoveredBy {
  return value === 'customer' || value === 'retry' || value === 'unknown' ? value : 'not_recorded';
}

export function summariseOutcomes(rows: DunningRow[], deletions: DeletionRow[] = []): OutcomeSummary {
  type Seq = {
    customer: string;
    code: string | null;
    startedAt: number | null;
    recoveredAt: number | null;
    recovered: boolean;
    deletedCancel: boolean;
    recoveredBy: string | null;
  };
  const sequences = new Map<string, Seq>();

  for (const row of rows) {
    if (!DUNNING_TEMPLATES.has(row.template)) continue;
    const key = `${row.stripe_customer_id}:${row.scope_key}`;
    const seq: Seq =
      sequences.get(key) ?? {
        customer: row.stripe_customer_id,
        code: null,
        startedAt: null,
        recoveredAt: null,
        recovered: false,
        deletedCancel: false,
        recoveredBy: null,
      };
    if (!seq.code && row.payload?.declineCode) seq.code = row.payload.declineCode;
    const created = row.created_at ? Date.parse(row.created_at) : NaN;
    if (Number.isFinite(created) && (seq.startedAt == null || created < seq.startedAt)) {
      seq.startedAt = created;
    }
    if (row.cancel_reason === 'payment_recovered') {
      seq.recovered = true;
      const at = row.cancelled_at ? Date.parse(row.cancelled_at) : NaN;
      if (Number.isFinite(at) && (seq.recoveredAt == null || at < seq.recoveredAt)) seq.recoveredAt = at;
    }
    if (row.cancel_reason === 'subscription_deleted') seq.deletedCancel = true;
    if (row.recovered_by && !seq.recoveredBy) seq.recoveredBy = row.recovered_by;
    sequences.set(key, seq);
  }

  const deletedAt = new Map<string, number[]>();
  for (const d of deletions) {
    if (!d.stripe_customer_id || !d.event_created) continue;
    const at = Date.parse(d.event_created);
    if (!Number.isFinite(at)) continue;
    const list = deletedAt.get(d.stripe_customer_id) ?? [];
    list.push(at);
    deletedAt.set(d.stripe_customer_id, list);
  }

  const byCode = new Map<string, DeclineCodeRow>();
  const recoveredBy: Record<RecoveredBy, number> = { customer: 0, retry: 0, unknown: 0, not_recorded: 0 };
  const days: number[] = [];
  let recovered = 0;
  let lost = 0;
  let open = 0;

  for (const seq of sequences.values()) {
    let outcome: SequenceOutcome = 'open';
    if (seq.recovered) {
      outcome = 'recovered';
    } else if (
      seq.deletedCancel ||
      (deletedAt.get(seq.customer) ?? []).some((at) => seq.startedAt == null || at >= seq.startedAt)
    ) {
      outcome = 'lost';
    }

    const codeKey = seq.code ?? '';
    const bucket: DeclineCodeRow =
      byCode.get(codeKey) ??
      { code: seq.code, sca: seq.code === SCA_DECLINE_CODE, sequences: 0, recovered: 0, lost: 0, open: 0 };
    bucket.sequences += 1;
    bucket[outcome] += 1;
    byCode.set(codeKey, bucket);

    if (outcome === 'recovered') {
      recovered += 1;
      recoveredBy[normaliseRecoveredBy(seq.recoveredBy)] += 1;
      if (seq.startedAt != null && seq.recoveredAt != null && seq.recoveredAt >= seq.startedAt) {
        days.push((seq.recoveredAt - seq.startedAt) / DAY_MS);
      }
    } else if (outcome === 'lost') {
      lost += 1;
    } else {
      open += 1;
    }
  }

  const closed = recovered + lost;
  return {
    sequences: sequences.size,
    recovered,
    lost,
    open,
    closed,
    recoveryRate: closed >= MIN_SEQUENCES_FOR_RATE ? recovered / closed : null,
    medianDaysToRecover: median(days),
    recoveredWithTiming: days.length,
    byDeclineCode: [...byCode.values()].sort(
      (a, b) =>
        Number(b.sca) - Number(a.sca) ||
        b.sequences - a.sequences ||
        (a.code ?? '').localeCompare(b.code ?? ''),
    ),
    recoveredBy,
  };
}

// ---------------------------------------------------------------------------
// Involuntary share of churn, by month (UTC).
// ---------------------------------------------------------------------------

export type ChurnReason = 'payment_failed' | 'cancellation_requested' | 'other' | 'not_recorded';

export interface ChurnMonth {
  /** 'YYYY-MM', UTC. */
  month: string;
  payment_failed: number;
  cancellation_requested: number;
  /** Any other reason Stripe gave (payment_disputed), or none at all ('none'). */
  other: number;
  /** Deletions from before the reason was stored. */
  not_recorded: number;
  total: number;
  /** payment_failed / deletions with a recorded reason; null below MIN_SEQUENCES_FOR_RATE. */
  involuntaryShare: number | null;
}

export function churnReason(raw: string | null): ChurnReason {
  if (raw == null) return 'not_recorded';
  if (raw === 'payment_failed' || raw === 'cancellation_requested') return raw;
  return 'other';
}

/** Newest month first. */
export function summariseChurn(deletions: DeletionRow[]): ChurnMonth[] {
  const months = new Map<string, ChurnMonth>();
  for (const d of deletions) {
    if (!d.event_created) continue;
    const at = new Date(d.event_created);
    if (Number.isNaN(at.getTime())) continue;
    const month = at.toISOString().slice(0, 7);
    const bucket: ChurnMonth =
      months.get(month) ?? {
        month,
        payment_failed: 0,
        cancellation_requested: 0,
        other: 0,
        not_recorded: 0,
        total: 0,
        involuntaryShare: null,
      };
    bucket[churnReason(d.cancellation_reason)] += 1;
    bucket.total += 1;
    months.set(month, bucket);
  }
  for (const bucket of months.values()) {
    const recorded = bucket.total - bucket.not_recorded;
    bucket.involuntaryShare = recorded >= MIN_SEQUENCES_FOR_RATE ? bucket.payment_failed / recorded : null;
  }
  return [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
}

// ---------------------------------------------------------------------------
// Reach of the failed-payment banner: payment_fix_clicked funnel rows.
// ---------------------------------------------------------------------------

export interface FixClickRow {
  workspace_id: string;
  outcome: string;
  occurred_at: string;
}

export interface FixClickSummary {
  clicks: number;
  /** Sent on to Stripe (the open invoice or the portal). */
  sentToStripe: number;
  /** Bounced to settings: no customer, or a Stripe error. */
  bounced: number;
  workspaces: number;
  lastClickAt: string | null;
}

export function summariseFixClicks(rows: FixClickRow[]): FixClickSummary {
  const workspaces = new Set<string>();
  let sentToStripe = 0;
  let bounced = 0;
  let lastClickAt: string | null = null;
  for (const row of rows) {
    workspaces.add(row.workspace_id);
    if (row.outcome === 'success') sentToStripe += 1;
    else bounced += 1;
    if (!lastClickAt || row.occurred_at > lastClickAt) lastClickAt = row.occurred_at;
  }
  return { clicks: rows.length, sentToStripe, bounced, workspaces: workspaces.size, lastClickAt };
}

type PageResult = { data: unknown[] | null; error: { message: string } | null };

const DUNNING_COLUMNS =
  'template, category, stripe_customer_id, scope_key, send_after, sent_at, cancelled_at, cancel_reason, last_error, attempts, recipient, payload, created_at';

/**
 * Every row in the queue, paged.
 *
 * PostgREST silently truncates a row-returning select at 1000 however large the
 * requested limit, so this pages with `.range()` rather than asking for
 * everything and believing the answer. The table holds a few hundred rows a
 * year and is pruned at 180 days, so this is one request in practice and two
 * only if something has gone very wrong, which is exactly when a truncated
 * count would mislead.
 *
 * Read ahead of migration 20261024225000, the select drops only
 * `recovered_by` and keeps the rest of the board.
 */
export async function fetchDunningRows(
  db: SupabaseClient<Database>,
  hardCap = 5000,
): Promise<{ rows: DunningRow[]; truncated: boolean }> {
  const PAGE = 1000;
  const rows: DunningRow[] = [];
  let withRecoveredBy = true;

  for (let from = 0; from < hardCap; from += PAGE) {
    const read = async (columns: string): Promise<PageResult> =>
      (await db
        .from('billing_email_sends')
        .select(columns)
        .order('id', { ascending: false })
        .range(from, from + PAGE - 1)) as PageResult;

    let result = await read(withRecoveredBy ? `${DUNNING_COLUMNS}, recovered_by` : DUNNING_COLUMNS);
    if (result.error && withRecoveredBy && /recovered_by/.test(result.error.message)) {
      withRecoveredBy = false;
      result = await read(DUNNING_COLUMNS);
    }

    if (result.error) throw new Error(result.error.message);
    const page = (result.data ?? []) as DunningRow[];
    rows.push(...page);
    if (page.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/**
 * Every customer.subscription.deleted in the webhook ledger, paged like
 * fetchDunningRows. The ledger is never pruned, so the counts go back to its
 * first row; the reason exists only from migration 20261024225000 on, and
 * `reasonColumn` is false while that migration is still pending.
 */
export async function fetchSubscriptionDeletions(
  db: SupabaseClient<Database>,
  hardCap = 5000,
): Promise<{ rows: DeletionRow[]; reasonColumn: boolean }> {
  const PAGE = 1000;
  const rows: DeletionRow[] = [];
  let reasonColumn = true;

  for (let from = 0; from < hardCap; from += PAGE) {
    const read = async (columns: string): Promise<PageResult> =>
      (await db
        .from('stripe_webhook_events')
        .select(columns)
        .eq('event_type', 'customer.subscription.deleted')
        .order('event_id', { ascending: true })
        .range(from, from + PAGE - 1)) as PageResult;

    let result = await read(
      reasonColumn ? 'stripe_customer_id, event_created, cancellation_reason' : 'stripe_customer_id, event_created',
    );
    if (result.error && reasonColumn && /cancellation_reason/.test(result.error.message)) {
      reasonColumn = false;
      result = await read('stripe_customer_id, event_created');
    }
    if (result.error) throw new Error(result.error.message);

    const page = ((result.data ?? []) as Array<Partial<DeletionRow>>).map((r) => ({
      stripe_customer_id: r.stripe_customer_id ?? null,
      event_created: r.event_created ?? null,
      cancellation_reason: r.cancellation_reason ?? null,
    }));
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return { rows, reasonColumn };
}

/** Every payment_fix_clicked funnel row, paged. */
export async function fetchFixClicks(db: SupabaseClient<Database>, hardCap = 5000): Promise<FixClickRow[]> {
  const PAGE = 1000;
  const rows: FixClickRow[] = [];
  for (let from = 0; from < hardCap; from += PAGE) {
    const { data, error } = await db
      .from('product_funnel_events')
      .select('workspace_id, outcome, occurred_at')
      .eq('stage', 'payment_fix_clicked')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as FixClickRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}
