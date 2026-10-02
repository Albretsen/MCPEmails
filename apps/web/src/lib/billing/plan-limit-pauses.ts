/**
 * Lifting plan-limit pauses on automations when a workspace stops being capped.
 *
 * WHAT A PLAN-LIMIT PAUSE IS. When a workspace runs out of its action
 * allowance, the triage dispatcher (supabase/functions/mcp-server,
 * pauseRuleForPlanLimit in triage-engine.ts) writes three columns on each rule
 * it stops:
 *
 *   paused_reason = 'plan_limit'
 *   paused_until  = the end of the allowance period
 *   next_run_at   = paused_until
 *
 * The rule stays enabled, and the dispatcher only claims it again once
 * `paused_until` has passed. That is correct for a customer who stays on Free
 * and wrong for one who pays: nothing re-read the pause when the plan changed,
 * so a customer who bought Personal on the 1st kept every automation paused
 * until the 1st of the NEXT month. This module is the missing half.
 *
 * WHY IT ONLY CLEARS, AND NEVER DECIDES. Whether a workspace may run is the
 * dispatcher's question, answered from `workspace_action_allowance()` before
 * every run. Lifting a pause here only makes a rule eligible to be asked
 * again. If the workspace is in fact still out of allowance (a downgrade
 * between two paid plans, say), the dispatcher pauses the rule again on its
 * next cycle without opening the mailbox, and the "paused" notice is one per
 * workspace per period, so nobody is mailed twice. A lift that turns out to be
 * unnecessary therefore costs one allowance read per rule and nothing else.
 *
 * WHY IT CANNOT THROW. Every caller has just written billing or entitlement
 * state that matters more than this does. The Stripe webhook in particular
 * rolls its ledger row back and answers 500 on any throw, which would re-run
 * the plan write for the sake of a schedule nudge. Every failure in here is
 * logged and swallowed.
 *
 * IDEMPOTENT BY CONSTRUCTION. Only rows that still carry
 * `paused_reason = 'plan_limit'` are read, and every write repeats that
 * predicate, so a replayed webhook (or two events for one purchase racing each
 * other) finds nothing left to do and does not move `next_run_at` a second
 * time.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';

/** Mirrors TRIAGE_PAUSE_REASON_PLAN_LIMIT in mcp-server/triage-engine.ts. */
export const PLAN_LIMIT_PAUSE_REASON = 'plan_limit';

/**
 * The resumed rules are spread over at most this many one-minute slots.
 *
 * The dispatcher runs once a minute and claims at most 20 rules per run
 * (MAX_RULES_PER_INVOCATION), across every workspace. A workspace can hold 200
 * rules, so making them all due in the same second would put one customer's
 * backlog in front of everybody else's for ten minutes. Fifteen minutes is
 * also the shortest cadence a rule can have, so no rule resumes later than it
 * would have run anyway.
 */
export const RESUME_WINDOW_MINUTES = 15;

/**
 * Rules made due per one-minute slot: half of one dispatcher run, so the other
 * half stays free for other workspaces. Only exceeded when the backlog would
 * not otherwise fit inside RESUME_WINDOW_MINUTES.
 */
export const RESUME_RULES_PER_MINUTE = 10;

export interface ResumeSlot {
  /** ISO. What `next_run_at` becomes for every rule in this slot. */
  nextRunAt: string;
  ruleIds: string[];
}

/**
 * Assign rule ids to one-minute slots starting at `now`.
 *
 * The first slot is `now` itself, so a workspace with a handful of rules
 * resumes on the very next dispatcher cycle. Pure, so the spread is testable
 * without a database.
 */
export function resumeSlots(ruleIds: string[], now: Date): ResumeSlot[] {
  if (ruleIds.length === 0) return [];
  const perSlot = Math.max(
    RESUME_RULES_PER_MINUTE,
    Math.ceil(ruleIds.length / RESUME_WINDOW_MINUTES),
  );
  const slots: ResumeSlot[] = [];
  for (let start = 0; start < ruleIds.length; start += perSlot) {
    slots.push({
      nextRunAt: new Date(now.getTime() + slots.length * 60_000).toISOString(),
      ruleIds: ruleIds.slice(start, start + perSlot),
    });
  }
  return slots;
}

export interface LiftResult {
  /** Rules whose pause was cleared by THIS call. Zero on a replay. */
  lifted: number;
  /** True when any read or write failed. Already logged; nothing to handle. */
  failed: boolean;
}

/**
 * Clear every plan-limit pause in the given workspaces and make the rules due.
 *
 * Touches `paused_reason`, `paused_until` and `next_run_at`, and nothing else:
 * `enabled`, `disabled_reason` and `consecutive_failures` belong to the user
 * and to the failure counter, and a plan limit was never either of those.
 *
 * A rule the user switched off while it was paused has its pause cleared but
 * keeps `next_run_at = null`. Off means "not scheduled" everywhere else in the
 * product (the automations API nulls it on disable and sets it on enable), and
 * leaving the stale pause behind would keep the rule paused after the user
 * turned it back on.
 *
 * Never throws. See the header.
 */
export async function liftPlanLimitPauses(
  db: SupabaseClient<Database>,
  workspaceIds: string[],
  options: { now?: Date; label?: string } = {},
): Promise<LiftResult> {
  const label = options.label ?? 'lift';
  if (workspaceIds.length === 0) return { lifted: 0, failed: false };

  try {
    const { data: paused, error: readError } = await db
      .from('triage_rules')
      .select('id, enabled')
      .in('workspace_id', workspaceIds)
      .eq('paused_reason', PLAN_LIMIT_PAUSE_REASON)
      .is('deleted_at', null);

    if (readError) {
      console.error(
        `[plan-limit-pauses] ${label}: could not read paused rules; automations stay paused: ${readError.message}`,
      );
      return { lifted: 0, failed: true };
    }
    if (!paused || paused.length === 0) return { lifted: 0, failed: false };

    // Sorted so the slot a rule lands in does not depend on the order the
    // database happened to return the rows in.
    const ids = (enabled: boolean) =>
      paused.filter((rule) => rule.enabled === enabled).map((rule) => rule.id).sort();

    const cleared = { paused_reason: null, paused_until: null };
    const writes: Array<{ patch: typeof cleared & { next_run_at?: string }; ruleIds: string[] }> =
      resumeSlots(ids(true), options.now ?? new Date()).map((slot) => ({
        patch: { ...cleared, next_run_at: slot.nextRunAt },
        ruleIds: slot.ruleIds,
      }));
    const switchedOff = ids(false);
    if (switchedOff.length > 0) writes.push({ patch: cleared, ruleIds: switchedOff });

    let lifted = 0;
    let failed = false;
    for (const write of writes) {
      // The pause predicate is repeated on the write: between the read above
      // and this statement the dispatcher may have resumed the rule itself, or
      // a concurrent delivery of the same purchase may have got here first.
      const { data, error } = await db
        .from('triage_rules')
        .update(write.patch)
        .in('id', write.ruleIds)
        .eq('paused_reason', PLAN_LIMIT_PAUSE_REASON)
        .is('deleted_at', null)
        .select('id');
      if (error) {
        // Carry on with the remaining slots: resuming most of the rules beats
        // resuming none of them.
        failed = true;
        console.error(
          `[plan-limit-pauses] ${label}: could not lift ${write.ruleIds.length} pause(s): ${error.message}`,
        );
        continue;
      }
      lifted += data?.length ?? 0;
    }

    console.log(
      `[plan-limit-pauses] ${label}: lifted ${lifted} of ${paused.length} plan-limit pause(s) across ${workspaceIds.length} workspace(s)`,
    );
    return { lifted, failed };
  } catch (err) {
    // The label rides in the object, not the message: with a second argument
    // the first one is a format string, and the label is caller-supplied.
    console.error('[plan-limit-pauses] unexpected failure, swallowed:', {
      label,
      error: err instanceof Error ? err.message : String(err),
    });
    return { lifted: 0, failed: true };
  }
}

/**
 * The owner's live workspaces whose projected plan is about to CHANGE to
 * `newPlan`, for a `newPlan` that is not Free. Call it BEFORE the projection
 * is written; lift the pauses for the ids it returns AFTER.
 *
 * This is the "transition" test. `customer.subscription.updated` arrives on
 * every renewal, card change and proration for a customer who is already on
 * the plan it names, and none of those should touch a schedule. Comparing
 * against `workspaces.plan` rather than `user_billing.plan` is deliberate: the
 * projection is the column `workspace_action_allowance()` reads, so it is the
 * one that decided the pause.
 *
 * Any change INTO a paid plan counts, not only Free to paid. An upgrade between
 * paid plans raises the allowance too, and a downgrade between them is handled
 * by the dispatcher pausing again (see the header).
 *
 * Never throws. A failed read returns no ids, which means no lift: the plan
 * write this sits beside must not depend on it.
 */
export async function workspacesEnteringPaidPlan(
  db: SupabaseClient<Database>,
  ownerId: string,
  newPlan: string | null,
): Promise<string[]> {
  // `null` is the webhook's "leave the plan as it is" sentinel.
  if (newPlan === null || newPlan === 'free') return [];
  try {
    const { data, error } = await db
      .from('workspaces')
      .select('id, plan')
      .eq('owner_id', ownerId)
      .is('deleted_at', null);
    if (error) {
      console.error(
        `[plan-limit-pauses] could not read the workspaces of ${ownerId}; no pauses will be lifted: ${error.message}`,
      );
      return [];
    }
    return (data ?? []).filter((workspace) => workspace.plan !== newPlan).map((w) => w.id);
  } catch (err) {
    console.error('[plan-limit-pauses] workspace read failed, swallowed:', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
