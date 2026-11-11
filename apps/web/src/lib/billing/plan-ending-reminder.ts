/**
 * Plan-ending reminder: one factual email 4 to 6 days before a scheduled stop.
 *
 * WHY. Most monthly stops are customers who switch off renewal within days of
 * paying, and several of them keep using MCPEmails heavily until the period
 * ends. They cancelled in the Stripe portal, where Pause is not offered, so
 * the first time they would hear of it is never. This tells them, once, that
 * the plan ends on a date, what Free means, and that keeping the plan or
 * pausing it is one click on the billing page.
 *
 * LEGAL LINE (PR #245). Nothing is added to /cancel or the Stripe portal
 * cancel flow. This runs days after the cancel, as its own message, and its
 * links go to the billing page, behind sign-in.
 *
 * WHO. A subscription with a scheduled stop (cancel_at set, or
 * cancel_at_period_end; scheduledToStop, never one field), still active, not
 * paused, whose stop is 4 to 6 whole days away, whose owner is not internal
 * and has not deleted the account, and whose owner workspace made at least one
 * successful MCP call in the last 7 days. Once per subscription and stop date:
 * the billing_email_sends row (holdout rows included, cancelled at birth) is
 * the ledger.
 *
 * EXPERIMENT `plan_ending_reminder`, 50/50 per subscription, assigned the
 * first time the subscription is eligible. `holdout` gets nothing but a
 * funnel event; `reminder` gets the email (template plan_ending_5d).
 *
 * FLAG PLAN_ENDING_REMINDER_ENABLED, read at call time:
 *   off      (default) the job returns at once; no link in any email changes.
 *   dry_run  the job reads everything and reports what it would do. No
 *            assignment, no ledger row, no funnel event, no email.
 *   on       assign, queue, send. The cancellation confirmation also gets
 *            the "Keep my plan" link and the pause deep link.
 * Anything else reads as off.
 *
 * This module is pure (no database, no Stripe): the runner takes a store, so
 * every rule is tested without either. The Supabase + Stripe store is
 * plan-ending-reminder-store.ts; the cron entry is
 * app/api/internal/plan-ending-reminder/route.ts.
 */

import { createHash } from 'node:crypto';

import { scheduledToStop } from '@/lib/analytics/revenue-math';
import { hashUnit, pickVariant } from '@/lib/experiments/bucketing';
import type { ExperimentVariant } from '@/lib/experiments/constants';
import type { LifecyclePayload } from '@/lib/email/billing-lifecycle';
import type { PlanId } from '@/lib/stripe/plans';

export {
  planEndingMode,
  planEndingLinksOn,
  planActionSource,
  planActionUrl,
  PLAN_ACTION_SOURCES,
  type PlanActionSource,
  type PlanEndingMode,
} from '@/lib/billing/plan-action-links';
import type { PlanEndingMode } from '@/lib/billing/plan-action-links';

// ---------------------------------------------------------------------------
// Experiment
// ---------------------------------------------------------------------------

export const PLAN_ENDING_EXPERIMENT = 'plan_ending_reminder';
export type PlanEndingVariant = 'holdout' | 'reminder';

/** Mirrors the seeded experiment row (20261111140300_plan_ending_reminder.sql). */
export const PLAN_ENDING_VARIANTS: ExperimentVariant[] = [
  { id: 'holdout', label: 'No reminder', weight: 50 },
  { id: 'reminder', label: 'Plan-ending reminder', weight: 50 },
];

/**
 * The experiment subject for a subscription: 32 lowercase hex, the shape
 * experiment_assignments.subject_id takes. Derived, so the same subscription
 * always lands on the same row.
 */
export function subjectIdForSubscription(subscriptionId: string): string {
  return createHash('sha256').update(`plan_ending:${subscriptionId}`).digest('hex').slice(0, 32);
}

/** The arm a subject would hash to, without writing an assignment (dry run). */
export function hashedVariant(subjectId: string): PlanEndingVariant {
  return pickVariant(PLAN_ENDING_VARIANTS, hashUnit(subjectId, PLAN_ENDING_EXPERIMENT)) as PlanEndingVariant;
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

const DAY_S = 86_400;
export const WINDOW_MIN_DAYS = 4;
export const WINDOW_MAX_DAYS = 6;
export const RECENT_USE_DAYS = 7;

export interface StoppingSubscription {
  id: string;
  customerId: string;
  status: string | null;
  cancelAtPeriodEnd: boolean | null;
  cancelAt: number | null;
  /** The base plan item's current_period_end (unix seconds). */
  currentPeriodEnd: number | null;
  paused: boolean;
  /** subscription.metadata.user_id, when the checkout wrote one. */
  metadataUserId: string | null;
  planId: PlanId | null;
  interval: 'month' | 'year' | null;
  /** May this subscription be paused right now (pause.ts pauseEligibility). */
  pauseEligible: boolean;
}

/**
 * The unix second the plan stops, or null when nothing is scheduled. cancel_at
 * when set (the portal's shape), else the period end under
 * cancel_at_period_end.
 */
export function stopAtSeconds(sub: Pick<StoppingSubscription, 'cancelAt' | 'cancelAtPeriodEnd' | 'currentPeriodEnd'>): number | null {
  if (!scheduledToStop({ cancel_at: sub.cancelAt, cancel_at_period_end: sub.cancelAtPeriodEnd })) return null;
  return sub.cancelAt ?? sub.currentPeriodEnd ?? null;
}

/** Whole days to the stop are 4, 5 or 6: three daily runs get a chance. */
export function inReminderWindow(stopAt: number, nowSeconds: number): boolean {
  const delta = stopAt - nowSeconds;
  return delta >= WINDOW_MIN_DAYS * DAY_S && delta < (WINDOW_MAX_DAYS + 1) * DAY_S;
}

export function planEndingScopeKey(subscriptionId: string, stopAt: number): string {
  return `${subscriptionId}:${stopAt}`;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface OwnerFacts {
  userId: string;
  email: string | null;
  workspaceId: string | null;
  internal: boolean;
  deleted: boolean;
  /** Grandfathered inboxes (user_usage_entitlements). Read-failure = true. */
  grandfathered: boolean;
  /** workspaces.free_action_cap_exempt on the owner workspace. */
  freeCapExempt: boolean;
  /** Whether pause is offered to this account (BILLING_PAUSE_ENABLED / internal). */
  pauseOffered: boolean;
}

export type SkipReason =
  | 'not_scheduled'
  | 'not_active'
  | 'paused'
  | 'outside_window'
  | 'no_plan'
  | 'no_owner'
  | 'account_deleted'
  | 'internal'
  | 'no_workspace'
  | 'no_recipient'
  | 'no_recent_use'
  | 'already_handled'
  | 'experiment_not_running'
  | 'error';

/** Cheap checks first: no database read for a subscription outside the window. */
export function subscriptionSkip(sub: StoppingSubscription, nowSeconds: number): SkipReason | null {
  const stopAt = stopAtSeconds(sub);
  if (stopAt == null) return 'not_scheduled';
  if (sub.status !== 'active' && sub.status !== 'trialing') return 'not_active';
  if (sub.paused) return 'paused';
  if (!inReminderWindow(stopAt, nowSeconds)) return 'outside_window';
  if (!sub.planId || sub.planId === 'free') return 'no_plan';
  return null;
}

export function ownerSkip(owner: OwnerFacts | null): SkipReason | null {
  if (!owner) return 'no_owner';
  if (owner.deleted) return 'account_deleted';
  if (owner.internal) return 'internal';
  if (!owner.workspaceId) return 'no_workspace';
  return null;
}

/** The queued payload. The composer reads only these fields. */
export function reminderPayload(sub: StoppingSubscription, owner: OwnerFacts, stopAt: number): LifecyclePayload {
  return {
    planId: sub.planId,
    interval: sub.interval,
    periodEnd: new Date(stopAt * 1000).toISOString(),
    grandfathered: owner.grandfathered,
    freeActionCapApplies: !owner.freeCapExempt && !owner.grandfathered,
    pauseOffered: owner.pauseOffered && sub.pauseEligible,
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface LedgerRow {
  stripeCustomerId: string;
  userId: string;
  recipient: string;
  scopeKey: string;
  payload: LifecyclePayload;
}

export interface PlanEndingStore {
  /** Every subscription that might be stopping (active / trialing). */
  listSubscriptions(): AsyncIterable<StoppingSubscription>;
  owner(sub: StoppingSubscription): Promise<OwnerFacts | null>;
  recipient(sub: StoppingSubscription, owner: OwnerFacts): Promise<string | null>;
  hadSuccessfulCallSince(workspaceId: string, sinceIso: string): Promise<boolean>;
  alreadyHandled(customerId: string, scopeKey: string): Promise<boolean>;
  /** Write (or read back) the assignment. Null when the experiment is not running. */
  assign(subjectId: string): Promise<PlanEndingVariant | null>;
  /** Insert the email row. True when this call inserted it. */
  queueReminder(row: LedgerRow): Promise<boolean>;
  /** Insert the holdout ledger row, cancelled at birth. True when inserted. */
  recordHoldout(row: LedgerRow): Promise<boolean>;
  funnel(workspaceId: string, stage: 'plan_ending_reminder_holdout', planId: PlanId): Promise<void>;
}

export interface RunEntry {
  subscription: string;
  outcome: SkipReason | 'queued' | 'holdout' | 'would_queue' | 'would_hold_out';
  stopAt?: string;
}

export interface RunReport {
  mode: Exclude<PlanEndingMode, 'off'>;
  scanned: number;
  inWindow: number;
  queued: number;
  holdout: number;
  skipped: Partial<Record<SkipReason, number>>;
  entries: RunEntry[];
  stoppedEarly: boolean;
}

/** Upper bound on one run, so a runaway pager cannot loop forever. */
export const MAX_SCANNED = 5000;

export async function runPlanEndingReminder(options: {
  store: PlanEndingStore;
  mode: Exclude<PlanEndingMode, 'off'>;
  now?: Date;
  outOfTime?: () => boolean;
}): Promise<RunReport> {
  const { store, mode } = options;
  const now = options.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const report: RunReport = { mode, scanned: 0, inWindow: 0, queued: 0, holdout: 0, skipped: {}, entries: [], stoppedEarly: false };
  const skip = (sub: StoppingSubscription, reason: SkipReason, stopAt?: number) => {
    report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
    // Out-of-window and unscheduled subscriptions are most of the list; only
    // the ones that got close are worth a line.
    if (reason !== 'not_scheduled' && reason !== 'outside_window') {
      report.entries.push({ subscription: sub.id, outcome: reason, ...(stopAt ? { stopAt: iso(stopAt) } : {}) });
    }
  };

  for await (const sub of store.listSubscriptions()) {
    if (report.scanned >= MAX_SCANNED || options.outOfTime?.()) {
      report.stoppedEarly = true;
      break;
    }
    report.scanned += 1;

    const early = subscriptionSkip(sub, nowSeconds);
    if (early) {
      skip(sub, early);
      continue;
    }
    const stopAt = stopAtSeconds(sub)!;
    report.inWindow += 1;
    try {
      await handleCandidate(sub, stopAt);
    } catch (err) {
      // One unreadable subscription must not stop the rest; tomorrow's run
      // (still inside the window) tries it again.
      console.error(`[plan-ending] ${sub.id} failed:`, err instanceof Error ? err.message : String(err));
      skip(sub, 'error', stopAt);
    }
  }
  return report;

  async function handleCandidate(sub: StoppingSubscription, stopAt: number): Promise<void> {
    const scopeKey = planEndingScopeKey(sub.id, stopAt);

    if (await store.alreadyHandled(sub.customerId, scopeKey)) {
      skip(sub, 'already_handled', stopAt);
      return;
    }
    const owner = await store.owner(sub);
    const ownerReason = ownerSkip(owner);
    if (ownerReason || !owner) {
      skip(sub, ownerReason ?? 'no_owner', stopAt);
      return;
    }
    const since = new Date(now.getTime() - RECENT_USE_DAYS * DAY_S * 1000).toISOString();
    if (!(await store.hadSuccessfulCallSince(owner.workspaceId!, since))) {
      skip(sub, 'no_recent_use', stopAt);
      return;
    }
    const recipient = await store.recipient(sub, owner);
    if (!recipient) {
      skip(sub, 'no_recipient', stopAt);
      return;
    }

    const subjectId = subjectIdForSubscription(sub.id);
    if (mode === 'dry_run') {
      const arm = hashedVariant(subjectId);
      report.entries.push({ subscription: sub.id, outcome: arm === 'reminder' ? 'would_queue' : 'would_hold_out', stopAt: iso(stopAt) });
      return;
    }

    const arm = await store.assign(subjectId);
    if (!arm) {
      skip(sub, 'experiment_not_running', stopAt);
      return;
    }
    const row: LedgerRow = {
      stripeCustomerId: sub.customerId,
      userId: owner.userId,
      recipient,
      scopeKey,
      payload: reminderPayload(sub, owner, stopAt),
    };
    if (arm === 'reminder') {
      if (await store.queueReminder(row)) {
        report.queued += 1;
        report.entries.push({ subscription: sub.id, outcome: 'queued', stopAt: iso(stopAt) });
      } else {
        skip(sub, 'already_handled', stopAt);
      }
    } else {
      if (await store.recordHoldout(row)) {
        report.holdout += 1;
        report.entries.push({ subscription: sub.id, outcome: 'holdout', stopAt: iso(stopAt) });
        await store.funnel(owner.workspaceId!, 'plan_ending_reminder_holdout', sub.planId!);
      } else {
        skip(sub, 'already_handled', stopAt);
      }
    }
  }
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}
