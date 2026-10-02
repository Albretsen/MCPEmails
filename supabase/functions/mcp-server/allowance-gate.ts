// ---------------------------------------------------------------------------
// What happens when a workspace's action allowance is reserved against, runs
// low, or runs out: ONE decision, for the interactive tool call and for the
// unattended automation runner alike.
//
// ── WHAT WENT WRONG ────────────────────────────────────────────────────────
// Measured 2026-10-02. A Free workspace whose 150 actions were used entirely
// by its automations was never recorded as capped. The 80% notice did go out
// (the runner reserves each action through the same function a tool call
// does), but the allowance then ran out BETWEEN two runs, so nothing was ever
// refused: the dispatcher's pre-run check found zero remaining and paused the
// rules, and that check recorded nothing. No `usage_limit_events` row, no
// `paywall_reached` funnel row, no `usage_limit_reached` email with the price
// and the upgrade link. The admin board undercounted caps and the owner got
// only the per-rule `automation_paused_limit` notice. A workspace that was
// refused once by hand got all of it.
//
// ── THE RULE NOW ───────────────────────────────────────────────────────────
// Reaching the cap is one event however it was reached. `recordCapReached`
// below is the only place that writes it, and it is called from the three
// places an allowance can say no:
//
//   1. a tool call's reservation is refused            (interactive)
//   2. an automation's reservation is refused mid-run  (runner)
//   3. the dispatcher's pre-run check finds nothing left before a rule runs
//
// 1 and 2 are refused ACTIONS and write one `usage_limit_events` row each, as
// they always have. 3 is not a refused action: no message was matched and
// nothing was attempted, the rule is merely parked. A workspace with 120 rules
// parks 120 times in a few minutes, and the board reads that table's row count
// as "refusals" (growth_usage_cap, migration 20260912210000). So 3 writes the
// event ONCE per workspace per period, and only when no refusal has already
// been recorded for the period by any path. That one row is what puts the
// workspace into the capped counts, the funnel and the retention pair.
//
// The emails need no such care. `billing_email_sends` is unique on
// (workspace_id, template, period_start), and the `usage_limit_reached` notice
// is queued only off the RPC's once-per-period signal, so however many rules,
// runs, retries and tool calls arrive, in whatever order, the owner is told
// once.
//
// ── WHY A MODULE ───────────────────────────────────────────────────────────
// Same reason as action-allowance.ts: index.ts cannot be imported by most
// tests, and this is exactly the logic that must not differ between its two
// callers. The database is injected (`AllowanceGateIo`); index.ts supplies the
// real queries, and allowance-gate.test.ts drives the real triage engine
// through these functions against a ledger that enforces the same uniqueness
// the tables do.
// ---------------------------------------------------------------------------

import {
  type ActionAllowanceRow,
  allowanceDecision,
  type AllowanceDecision,
  isAllowanceExhausted,
  isWarningCrossing,
} from "./action-allowance.ts";
import type { TriageAllowanceCheck, TriagePlanLimit } from "./triage-engine.ts";

/** The three notices the edge function can queue. Composed and sent by the
 * web app's billing-lifecycle dispatcher; this side only writes the row. */
export type UsageEmailTemplate = "usage_warning_80" | "usage_limit_reached" | "automation_paused_limit";

/** One row for `billing_email_sends`, before the recipient is resolved. */
export interface UsageEmailInput {
  workspaceId: string;
  ownerId: string;
  template: UsageEmailTemplate;
  /** period_start ISO for the two usage_* templates, the rule id for the automation one. */
  scopeKey: string;
  periodStart: string;
  payload: Record<string, unknown>;
}

/** What `reserve_action_usage` answered. */
export interface ActionReservationRow {
  reservation_id: string | null;
  allowed: boolean;
  used_actions: number;
}

/**
 * Every database round trip the gate makes, and nothing else.
 *
 * None of these may throw. Each one that can fail says below which way it
 * fails, because the direction is the design: the allowance is a plan rule and
 * must never be the reason a customer cannot read their mail, and a notice
 * must never be sent twice.
 */
export interface AllowanceGateIo {
  /** `workspace_action_allowance()`. Null for an unknown workspace or a failed read. */
  loadAllowance(workspaceId: string): Promise<ActionAllowanceRow | null>;
  /**
   * `reserve_action_usage()`. `ok: false` means the RPC itself failed, which
   * fails OPEN. `row: null` with `ok: true` is an answer with no row in it,
   * read as a refusal exactly as it was before this module existed.
   */
  reserve(input: {
    workspaceId: string;
    toolName: string;
    cap: number;
    periodStart: string;
    periodEnd: string;
  }): Promise<{ ok: true; row: ActionReservationRow | null } | { ok: false }>;
  /**
   * `record_usage_limit_event()`: always appends to `usage_limit_events`,
   * appends the `paywall_reached` funnel row at most once per workspace per
   * period, and answers true on exactly the call that wrote the funnel row. A
   * failed write answers false: no funnel row means no email.
   */
  recordLimitEvent(input: {
    workspaceId: string;
    plan: string;
    usedActions: number;
    cap: number;
    periodStart: string;
  }): Promise<boolean>;
  /**
   * Is there already a `usage_limit_events` row for this workspace in this
   * period? A failed read answers FALSE, so the event is recorded: a spare
   * row costs a slightly high refusal count, a missing one costs a capped
   * workspace that the board never sees.
   */
  limitEventRecorded(workspaceId: string, periodStart: string): Promise<boolean>;
  /**
   * Is a live `usage_limit_reached` row queued (or already sent) for this
   * workspace and period? A failed read answers FALSE, so the per-rule notice
   * still goes: being told twice is better than not being told.
   */
  limitNoticeQueued(workspaceId: string, periodStart: string): Promise<boolean>;
  /** Insert-or-ignore on the queue's unique index. Best effort, never throws. */
  queueEmail(input: UsageEmailInput): Promise<void>;
}

/** The allowance notices are about the Free allowance, and only about it.
 *
 * A paid workspace at 80% of its silent ceiling gets no mail: the ceiling is
 * never named to customers (plans.ts, "paid ceilings are not public"), and an
 * email reading "20,000 of 25,000" would name it. A paid workspace that
 * actually reaches the ceiling is refused, and its automations pause, exactly
 * as before; the human remedy in the refusal text is the notice. */
export function allowanceNoticesApply(plan: string | null | undefined): boolean {
  return plan === "free";
}

/** What reserving one billable action came to. */
export type BillableActionReservation =
  /** No reservation was made and none is owed: the bare insert in writeActionUsage is correct. */
  | { outcome: "unmetered"; reason: string }
  /** Reserved. `usedActions` counts this reservation, so 120 here IS the 80% crossing. */
  | { outcome: "reserved"; reservationId: string; usedActions: number }
  /** Refused by the cap. Everything the refusal text and `_meta` need. */
  | {
    outcome: "refused";
    plan: string;
    usedActions: number;
    cap: number;
    periodStart: string;
    periodEnd: string;
  };

type MeterDecision = Extract<AllowanceDecision, { kind: "meter" }>;

/** The payload both usage_* notices print their numbers from. */
function usagePayload(allowance: ActionAllowanceRow, decision: MeterDecision, used: number): Record<string, unknown> {
  return {
    used, cap: decision.cap, period_start: decision.periodStart, period_end: decision.periodEnd, plan: allowance.plan,
  };
}

/**
 * Records that a workspace reached its cap, and tells the owner once.
 *
 * Both records are written by one RPC because they answer different questions
 * and must be allowed to disagree: `usage_limit_events` takes every call made
 * here, the funnel's `paywall_reached` row is written at most once per
 * workspace per period. The RPC answers true on exactly the call that wrote
 * the funnel row, and that one signal is what queues the "limit reached"
 * email. So the first of an interactive refusal, a mid-run refusal and a
 * pre-run pause queues it, and every later one, of any kind, does not.
 *
 * The notice already says that automations are paused and when they resume
 * (billing-lifecycle.ts), which is why an automation-caused cap needs no
 * template of its own and no extra payload.
 */
async function recordCapReached(
  io: AllowanceGateIo,
  workspaceId: string,
  allowance: ActionAllowanceRow,
  decision: MeterDecision,
  usedActions: number,
): Promise<void> {
  const firstRefusalOfPeriod = await io.recordLimitEvent({
    workspaceId, plan: allowance.plan, usedActions, cap: decision.cap, periodStart: decision.periodStart,
  });
  if (allowanceNoticesApply(allowance.plan) && firstRefusalOfPeriod) {
    await io.queueEmail({
      workspaceId, ownerId: allowance.owner_id, template: "usage_limit_reached",
      scopeKey: decision.periodStart, periodStart: decision.periodStart,
      payload: usagePayload(allowance, decision, usedActions),
    });
  }
}

/**
 * Reserves one billable action against the workspace's allowance.
 *
 * The one path both the interactive tool call and the unattended automation
 * runner take, so the two cannot disagree about whether a workspace has
 * allowance left. In order: read the allowance row; let unmetered rows
 * through with no reservation; reserve with the row's cap and window; on
 * success queue the 80% notice from the crossing call; on refusal record the
 * event and queue the 100% notice from the first refusal of the period.
 *
 * Fail-open is confined to INFRASTRUCTURE: an allowance lookup or reservation
 * RPC that errors lets the call through, logged. Fail-closed is confined to a
 * REAL refusal, i.e. the reservation RPC answering `allowed: false`. Nothing
 * else refuses. The kill switch and the billable-tool check are the callers'
 * job, because they differ between the two callers.
 */
export async function reserveBillableAction(
  io: AllowanceGateIo,
  workspaceId: string,
  toolName: string,
  /**
   * The allowance row when the caller is already reading it (handleRequest
   * issues it alongside the rate-limit checks). Only the READ moves earlier;
   * the reservation below still runs here, after every refusal that must not
   * leave one behind. The automation runner passes nothing and reads it here.
   */
  preloadedAllowance?: Promise<ActionAllowanceRow | null>,
): Promise<BillableActionReservation> {
  const allowance = await (preloadedAllowance ?? io.loadAllowance(workspaceId));
  const decision = allowanceDecision(allowance);
  if (decision.kind !== "meter" || !allowance) return { outcome: "unmetered", reason: decision.kind === "meter" ? "no_row" : decision.reason };

  const reservation = await io.reserve({
    workspaceId, toolName, cap: decision.cap, periodStart: decision.periodStart, periodEnd: decision.periodEnd,
  });
  // Fail open only when the reservation subsystem itself is unavailable.
  if (!reservation.ok) return { outcome: "unmetered", reason: "reservation_error" };
  const result = reservation.row;

  if (result?.allowed && result.reservation_id) {
    if (allowanceNoticesApply(allowance.plan) && isWarningCrossing(result.used_actions, decision.cap)) {
      await io.queueEmail({
        workspaceId, ownerId: allowance.owner_id, template: "usage_warning_80",
        scopeKey: decision.periodStart, periodStart: decision.periodStart,
        payload: usagePayload(allowance, decision, result.used_actions),
      });
    }
    return { outcome: "reserved", reservationId: result.reservation_id, usedActions: result.used_actions };
  }

  const usedActions = result?.used_actions ?? decision.cap;
  await recordCapReached(io, workspaceId, allowance, decision, usedActions);
  return {
    outcome: "refused", plan: allowance.plan, usedActions, cap: decision.cap,
    periodStart: decision.periodStart, periodEnd: decision.periodEnd,
  };
}

/** The shape the automation runner pauses on, from a refusal. */
export function planLimitOfRefusal(refusal: Extract<BillableActionReservation, { outcome: "refused" }>): TriagePlanLimit {
  return { paused_until: refusal.periodEnd, period_start: refusal.periodStart, used: refusal.usedActions, cap: refusal.cap };
}

/**
 * The dispatcher's pre-run check: may this workspace's rule run at all?
 *
 * Asked once per due rule, after the lease is won and before the mailbox is
 * opened. Unmetered rows and lookup failures both answer "allowed":
 * `isAllowanceExhausted` is false for anything that does not meter, and a null
 * row is one of them.
 *
 * An exhausted allowance is the cap being reached, whoever used it up, so it
 * is recorded through `recordCapReached` like a refusal. ONCE per workspace
 * per period, though, and not once per rule: see the header for why a parked
 * rule is not a refused action. The guard is a read of `usage_limit_events`,
 * so it also holds across dispatcher invocations (20 rules each, a minute
 * apart) and steps aside when an interactive call was refused first. Two
 * invocations racing past it write two rows and still one funnel row and one
 * email, because the RPC and the queue each enforce their own once.
 */
export async function checkAutomationAllowance(
  io: AllowanceGateIo,
  workspaceId: string,
): Promise<TriageAllowanceCheck> {
  const allowance = await io.loadAllowance(workspaceId);
  const decision = allowanceDecision(allowance);
  if (!allowance || decision.kind !== "meter" || !isAllowanceExhausted(allowance)) return { allowed: true };
  if (!(await io.limitEventRecorded(workspaceId, decision.periodStart))) {
    await recordCapReached(io, workspaceId, allowance, decision, allowance.used);
  }
  return {
    allowed: false,
    limit: {
      paused_until: decision.periodEnd,
      period_start: decision.periodStart,
      used: allowance.used,
      cap: decision.cap,
    },
  };
}

/**
 * Queues the per-rule `automation_paused_limit` notice, unless the owner is
 * already being told by the `usage_limit_reached` one.
 *
 * The two say the same thing to the same person about the same cause: the
 * limit notice carries the numbers, the reset date, the price and the upgrade
 * link, and a line that automations are paused and resume by themselves. The
 * only thing the per-rule notice adds is one rule's name. Since a cap reached
 * by automations now queues the limit notice first (both callers record the
 * cap BEFORE the rule is paused), sending this one as well would be two near
 * identical emails a few minutes apart. So it goes only when there is no live
 * limit notice for the period, which is the case it still earns its place in:
 * the limit notice could not be queued, or was never due because the period's
 * funnel row was already taken by something else.
 *
 * One notice per workspace per period either way, enforced by the queue's
 * unique index: a second rule paused in the same period is a 23505 and is
 * dropped. The allowance is re-read here rather than carried through the
 * engine, because the owner and the plan are ours to resolve, not the
 * engine's to know.
 */
export async function queueAutomationPausedNotice(
  io: AllowanceGateIo,
  input: { workspaceId: string; ruleId: string; ruleName: string; limit: TriagePlanLimit },
): Promise<void> {
  const allowance = await io.loadAllowance(input.workspaceId);
  if (!allowance || !allowanceNoticesApply(allowance.plan)) return;
  if (await io.limitNoticeQueued(input.workspaceId, input.limit.period_start)) return;
  await io.queueEmail({
    workspaceId: input.workspaceId,
    ownerId: allowance.owner_id,
    template: "automation_paused_limit",
    scopeKey: input.ruleId,
    periodStart: input.limit.period_start,
    payload: {
      rule_id: input.ruleId,
      rule_name: input.ruleName,
      used: input.limit.used,
      cap: input.limit.cap,
      period_end: input.limit.paused_until,
    },
  });
}
