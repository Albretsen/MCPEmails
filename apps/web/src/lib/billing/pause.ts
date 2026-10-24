/**
 * Pause a monthly subscription for 1 to 3 months. Pure: no I/O.
 *
 * MECHANICS (Documents/plans/pause-downgrade-20261024.md, section 12, proven
 * in Stripe test mode T6, T8, T10, T12). One subscriptions.update:
 *
 *   pause_collection: { behavior: 'void', resumes_at: <renewal N months after
 *                       the current period end> - 1 hour }
 *   cancel_at: ''      only when a cancel was scheduled (clears both fields)
 *   metadata: mcpe_pause_from = current period end (unix seconds),
 *             mcpe_pause_months = N, mcpe_pause_history = "from:months;..."
 *
 * The current period is already paid, so the pause starts at its end. The
 * renewals inside the pause are voided by Stripe (no dunning, no debt). One
 * hour before the renewal that bills again, Stripe clears pause_collection, so
 * that renewal is charged normally. The billing cycle anchor never moves.
 *
 * RESUME EARLY (decision D7). Re-anchoring charges nothing under flexible
 * billing (T7), so v1 moves resumes_at to the NEXT renewal boundary minus one
 * hour: the paid plan returns at the next renewal and is billed then. A pause
 * that has not started yet is simply removed.
 *
 * STATE. `pauseState` reads the subscription: none, scheduled (set, but the
 * paid period is still running) or paused (on Free until resumes_at).
 */

import { basePlanItem, getPlanByStripePriceId, type BillingInterval, type PlanId } from '@/lib/stripe/plans';

// ── Constants ────────────────────────────────────────────────────────────────

export const PAUSE_FROM_KEY = 'mcpe_pause_from';
export const PAUSE_MONTHS_KEY = 'mcpe_pause_months';
export const PAUSE_HISTORY_KEY = 'mcpe_pause_history';
/** '1' after Resume early, so the webhook does not also record an automatic resume. */
export const PAUSE_EARLY_KEY = 'mcpe_pause_early';

/** The lengths offered. */
export const PAUSE_LENGTHS = [1, 2, 3] as const;

/** At most this many paused months in any rolling 12 months. */
export const MAX_PAUSED_MONTHS_PER_YEAR = 3;

/** resumes_at sits this far before the renewal that bills again. */
export const RESUME_LEAD_SECONDS = 3600;

/** Plans that may pause. Business is out of v1 (decision D6). */
export const PAUSABLE_PLANS: readonly PlanId[] = ['personal', 'solo'];

// ── Shapes ───────────────────────────────────────────────────────────────────

/** The subset of a Stripe subscription this module reads. */
export interface PausableSubscription {
  id: string;
  status: string;
  currency?: string | null;
  billing_cycle_anchor?: number | null;
  cancel_at?: number | null;
  cancel_at_period_end?: boolean | null;
  pause_collection?: { behavior?: string | null; resumes_at?: number | null } | null;
  metadata?: Record<string, string> | null;
  items: {
    data: Array<{
      id: string;
      price: {
        id: string;
        unit_amount?: number | null;
        recurring?: { interval?: string | null; interval_count?: number | null } | null;
      };
      quantity?: number | null;
      current_period_start?: number | null;
      current_period_end?: number | null;
    }>;
  };
}

export type PauseStateName = 'none' | 'scheduled' | 'paused';

export interface PauseState {
  state: PauseStateName;
  /** Unix seconds the paid plan stops. Null when not paused. */
  pausedFrom: number | null;
  /** Unix seconds Stripe resumes collection. Null when not paused. */
  resumesAt: number | null;
  /** Months booked on the current pause (metadata), 0 when unknown. */
  months: number;
}

export interface PauseHistoryEntry {
  /** Unix seconds the pause started (or starts). */
  from: number;
  months: number;
}

// ── Small helpers ────────────────────────────────────────────────────────────

function toInt(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function secondsOf(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * `baseSeconds` plus `months` calendar months, the way Stripe advances a
 * monthly billing period: the day of month is the ANCHOR's day, clamped to
 * the target month's length. An anchor on the 31st renews on 28 or 29 Feb,
 * then on 31 Mar again (not on the 28th). Time of day is kept from the base.
 *
 * `anchorSeconds` is the subscription's billing_cycle_anchor; without it the
 * base's own day is used.
 */
export function addBillingMonths(
  baseSeconds: number,
  months: number,
  anchorSeconds?: number | null,
): number {
  const base = new Date(baseSeconds * 1000);
  const anchorDay = anchorSeconds ? new Date(anchorSeconds * 1000).getUTCDate() : base.getUTCDate();
  const monthIndex = base.getUTCMonth() + months;
  const year = base.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const day = Math.min(anchorDay, daysInMonth(year, month));
  return secondsOf(
    new Date(
      Date.UTC(
        year,
        month,
        day,
        base.getUTCHours(),
        base.getUTCMinutes(),
        base.getUTCSeconds(),
      ),
    ),
  );
}

/**
 * The `pause_collection.resumes_at` for a pause of `months` that starts at
 * `periodEndSeconds`: the renewal boundary `months` later, minus one hour.
 */
export function pauseResumesAt(
  periodEndSeconds: number,
  months: number,
  anchorSeconds?: number | null,
): number {
  return addBillingMonths(periodEndSeconds, months, anchorSeconds) - RESUME_LEAD_SECONDS;
}

/** The renewal that bills again after a pause: resumes_at plus the lead. */
export function resumeBoundary(resumesAtSeconds: number): number {
  return resumesAtSeconds + RESUME_LEAD_SECONDS;
}

// ── History ──────────────────────────────────────────────────────────────────

/** "from:months;from:months" to entries. Malformed parts are dropped. */
export function parsePauseHistory(value: string | null | undefined): PauseHistoryEntry[] {
  if (!value) return [];
  const out: PauseHistoryEntry[] = [];
  for (const part of value.split(';')) {
    const [from, months] = part.split(':').map((x) => toInt(x));
    if (from != null && months != null && months > 0) out.push({ from, months });
  }
  return out;
}

/** Entries to the metadata string, newest last, at most 12 (Stripe caps a value at 500 chars). */
export function formatPauseHistory(entries: readonly PauseHistoryEntry[]): string {
  return [...entries]
    .sort((a, b) => a.from - b.from)
    .slice(-12)
    .map((e) => `${e.from}:${e.months}`)
    .join(';');
}

/**
 * Paused months already booked in the 12 months before `startSeconds`
 * (entries that start after start-minus-12-months), excluding the entry that
 * starts exactly at `excludeFrom` (the pause being extended).
 */
export function pausedMonthsInWindow(
  history: readonly PauseHistoryEntry[],
  startSeconds: number,
  excludeFrom?: number | null,
): number {
  const windowStart = addBillingMonths(startSeconds, -12);
  return history
    .filter((e) => e.from > windowStart && e.from !== excludeFrom)
    .reduce((total, e) => total + e.months, 0);
}

/** History with the entry starting at `from` set to `months` (added when missing; removed at 0). */
export function withHistoryEntry(
  history: readonly PauseHistoryEntry[],
  from: number,
  months: number,
): PauseHistoryEntry[] {
  const others = history.filter((e) => e.from !== from);
  return months > 0 ? [...others, { from, months }] : others;
}

// ── State ────────────────────────────────────────────────────────────────────

/** The plan item's period. Null fields when Stripe sent none. */
export function currentPeriod(subscription: PausableSubscription): { start: number | null; end: number | null } {
  const item = basePlanItem(subscription.items.data);
  return { start: item?.current_period_start ?? null, end: item?.current_period_end ?? null };
}

/**
 * none | scheduled | paused.
 *
 * A pause_collection whose resumes_at has passed reads as none: Stripe clears
 * it within the hour, and the paid plan is back from that moment. A pause set
 * outside our own flow (no mcpe_pause_from) starts at the current period start,
 * i.e. now: Stripe voids the next renewal, so the customer is not paying.
 */
export function pauseState(subscription: PausableSubscription, now: Date = new Date()): PauseState {
  const pc = subscription.pause_collection;
  const nowSec = secondsOf(now);
  if (!pc || !pc.behavior) return { state: 'none', pausedFrom: null, resumesAt: null, months: 0 };
  const resumesAt = pc.resumes_at ?? null;
  if (resumesAt != null && nowSec >= resumesAt) {
    return { state: 'none', pausedFrom: null, resumesAt: null, months: 0 };
  }
  const meta = subscription.metadata ?? {};
  const months = toInt(meta[PAUSE_MONTHS_KEY]) ?? 0;
  const from = toInt(meta[PAUSE_FROM_KEY]) ?? currentPeriod(subscription).start ?? nowSec;
  return {
    state: nowSec < from ? 'scheduled' : 'paused',
    pausedFrom: from,
    resumesAt,
    months,
  };
}

// ── Eligibility ──────────────────────────────────────────────────────────────

export type PauseRefusal =
  | 'plan_not_eligible'
  | 'not_monthly'
  | 'not_active'
  | 'past_due'
  | 'multiple_items'
  | 'downgrade_pending'
  | 'already_paused'
  | 'not_paused'
  | 'cap_reached'
  | 'invalid_months'
  | 'no_period';

export interface PauseFacts {
  planId: PlanId | null;
  interval: BillingInterval | null;
  periodEnd: number | null;
  anchor: number | null;
  /** The price the customer resumes on, per period, minor units. */
  amountCents: number | null;
  currency: string;
  cancelScheduled: boolean;
  history: PauseHistoryEntry[];
  pause: PauseState;
}

export function pauseFacts(subscription: PausableSubscription, now: Date = new Date()): PauseFacts {
  const item = basePlanItem(subscription.items.data);
  const resolved = item ? getPlanByStripePriceId(item.price.id) : null;
  return {
    planId: resolved?.plan.id ?? null,
    interval: resolved?.interval ?? null,
    periodEnd: item?.current_period_end ?? null,
    anchor: subscription.billing_cycle_anchor ?? null,
    amountCents: item?.price.unit_amount != null ? item.price.unit_amount * (item.quantity ?? 1) : null,
    currency: subscription.currency ?? 'usd',
    cancelScheduled: subscription.cancel_at_period_end === true || subscription.cancel_at != null,
    history: parsePauseHistory(subscription.metadata?.[PAUSE_HISTORY_KEY]),
    pause: pauseState(subscription, now),
  };
}

/** True when metadata says a downgrade is booked and not yet effective. */
function downgradePending(subscription: PausableSubscription, now: Date): boolean {
  const at = toInt(subscription.metadata?.mcpe_downgrade_effective_at);
  return at != null && at > secondsOf(now);
}

function commonRefusal(subscription: PausableSubscription, facts: PauseFacts, now: Date): PauseRefusal | null {
  if (!facts.planId || !PAUSABLE_PLANS.includes(facts.planId)) return 'plan_not_eligible';
  if (facts.interval !== 'month') return 'not_monthly';
  if (subscription.status === 'past_due' || subscription.status === 'unpaid') return 'past_due';
  if (subscription.status !== 'active') return 'not_active';
  if (subscription.items.data.length !== 1) return 'multiple_items';
  if (downgradePending(subscription, now)) return 'downgrade_pending';
  if (facts.periodEnd == null) return 'no_period';
  return null;
}

export interface PauseEligibility {
  eligible: boolean;
  reason: PauseRefusal | null;
  /** Lengths that fit under the cap, from PAUSE_LENGTHS. */
  lengths: number[];
}

/** May this subscription start a new pause, and for how long. */
export function pauseEligibility(subscription: PausableSubscription, now: Date = new Date()): PauseEligibility {
  const facts = pauseFacts(subscription, now);
  const refusal = commonRefusal(subscription, facts, now);
  if (refusal) return { eligible: false, reason: refusal, lengths: [] };
  if (facts.pause.state !== 'none') return { eligible: false, reason: 'already_paused', lengths: [] };
  const used = pausedMonthsInWindow(facts.history, facts.periodEnd!);
  const room = Math.max(0, MAX_PAUSED_MONTHS_PER_YEAR - used);
  const lengths = PAUSE_LENGTHS.filter((n) => n <= room);
  if (lengths.length === 0) return { eligible: false, reason: 'cap_reached', lengths: [] };
  return { eligible: true, reason: null, lengths };
}

/** May the current pause be extended, and by how many more months. */
export function extendEligibility(subscription: PausableSubscription, now: Date = new Date()): PauseEligibility {
  const facts = pauseFacts(subscription, now);
  if (facts.pause.state === 'none') return { eligible: false, reason: 'not_paused', lengths: [] };
  if (!facts.planId || !PAUSABLE_PLANS.includes(facts.planId)) return { eligible: false, reason: 'plan_not_eligible', lengths: [] };
  const from = facts.pause.pausedFrom!;
  const others = pausedMonthsInWindow(facts.history, from, from);
  const room = Math.max(0, MAX_PAUSED_MONTHS_PER_YEAR - others - facts.pause.months);
  const lengths = PAUSE_LENGTHS.filter((n) => n <= room);
  if (lengths.length === 0) return { eligible: false, reason: 'cap_reached', lengths: [] };
  return { eligible: true, reason: null, lengths };
}

// ── Stripe update parameters ─────────────────────────────────────────────────

/** The parameters for subscriptions.update. Typed loosely enough for the SDK. */
export interface PauseUpdate {
  pause_collection: { behavior: 'void'; resumes_at: number } | '';
  cancel_at?: '';
  metadata: Record<string, string>;
}

/** Start a pause of `months`. Throws on an ineligible subscription. */
export function pauseUpdate(subscription: PausableSubscription, months: number, now: Date = new Date()): {
  params: PauseUpdate;
  pausedFrom: number;
  resumesAt: number;
} {
  const eligibility = pauseEligibility(subscription, now);
  if (!eligibility.eligible) throw new Error(`pause refused: ${eligibility.reason}`);
  if (!eligibility.lengths.includes(months)) throw new Error('pause refused: invalid_months');
  const facts = pauseFacts(subscription, now);
  const from = facts.periodEnd!;
  const resumesAt = pauseResumesAt(from, months, facts.anchor);
  return {
    pausedFrom: from,
    resumesAt,
    params: {
      pause_collection: { behavior: 'void', resumes_at: resumesAt },
      ...(facts.cancelScheduled ? { cancel_at: '' as const } : {}),
      metadata: {
        [PAUSE_FROM_KEY]: String(from),
        [PAUSE_MONTHS_KEY]: String(months),
        [PAUSE_HISTORY_KEY]: formatPauseHistory(withHistoryEntry(facts.history, from, months)),
        [PAUSE_EARLY_KEY]: '',
      },
    },
  };
}

/** Add `extraMonths` to the current pause. Throws on an ineligible subscription. */
export function extendUpdate(subscription: PausableSubscription, extraMonths: number, now: Date = new Date()): {
  params: PauseUpdate;
  pausedFrom: number;
  resumesAt: number;
  months: number;
} {
  const eligibility = extendEligibility(subscription, now);
  if (!eligibility.eligible) throw new Error(`extend refused: ${eligibility.reason}`);
  if (!eligibility.lengths.includes(extraMonths)) throw new Error('extend refused: invalid_months');
  const facts = pauseFacts(subscription, now);
  const from = facts.pause.pausedFrom!;
  const months = facts.pause.months + extraMonths;
  const resumesAt = pauseResumesAt(from, months, facts.anchor);
  return {
    pausedFrom: from,
    resumesAt,
    months,
    params: {
      pause_collection: { behavior: 'void', resumes_at: resumesAt },
      metadata: {
        [PAUSE_MONTHS_KEY]: String(months),
        [PAUSE_HISTORY_KEY]: formatPauseHistory(withHistoryEntry(facts.history, from, months)),
      },
    },
  };
}

/** Whole billing months between `from` and `until`, at least 1 for a pause that started. */
function monthsBetween(from: number, until: number, anchor: number | null): number {
  let n = 0;
  while (n < 24 && addBillingMonths(from, n + 1, anchor) <= until) n += 1;
  return Math.max(1, n);
}

/**
 * Resume early (D7). Scheduled: the pause is removed, nothing was voided yet.
 * Paused: resumes_at moves to the next renewal minus one hour; inside that last
 * hour, collection resumes now. Returns the renewal that bills again, or the
 * current period end for a scheduled pause.
 */
export function resumeEarlyUpdate(subscription: PausableSubscription, now: Date = new Date()): {
  params: PauseUpdate;
  billsAt: number | null;
  kind: 'removed' | 'next_renewal';
} {
  const facts = pauseFacts(subscription, now);
  const nowSec = secondsOf(now);
  if (facts.pause.state === 'none') throw new Error('resume refused: not_paused');
  const from = facts.pause.pausedFrom!;

  if (facts.pause.state === 'scheduled') {
    return {
      kind: 'removed',
      billsAt: facts.periodEnd,
      params: {
        pause_collection: '',
        metadata: {
          [PAUSE_FROM_KEY]: '',
          [PAUSE_MONTHS_KEY]: '',
          [PAUSE_HISTORY_KEY]: formatPauseHistory(withHistoryEntry(facts.history, from, 0)),
          [PAUSE_EARLY_KEY]: '',
        },
      },
    };
  }

  const boundary = facts.periodEnd;
  const months = boundary != null ? monthsBetween(from, boundary, facts.anchor) : facts.pause.months;
  const metadata = {
    [PAUSE_MONTHS_KEY]: String(months),
    [PAUSE_HISTORY_KEY]: formatPauseHistory(withHistoryEntry(facts.history, from, months)),
    [PAUSE_EARLY_KEY]: '1',
  };
  if (boundary == null || boundary - RESUME_LEAD_SECONDS <= nowSec + 60) {
    return { kind: 'next_renewal', billsAt: boundary, params: { pause_collection: '', metadata } };
  }
  return {
    kind: 'next_renewal',
    billsAt: boundary,
    params: { pause_collection: { behavior: 'void', resumes_at: boundary - RESUME_LEAD_SECONDS }, metadata },
  };
}
