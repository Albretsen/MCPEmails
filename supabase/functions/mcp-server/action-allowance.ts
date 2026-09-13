// ---------------------------------------------------------------------------
// The arithmetic around a workspace's action allowance, as pure functions.
//
// The allowance itself (150 billable email actions per UTC month on Free, the
// first 7 days after signup uncounted, every workspace from before 2026-09-12
// exempt, silent ceilings on paid plans) is computed in ONE place: the SQL
// function `workspace_action_allowance(p_workspace_id)` from migration
// 20260912200000. This module never re-derives the window or the cap. It only
// answers the two questions the edge function has to ask about the row that
// function returns:
//
//   1. Does this row mean "meter the call" or "let it through unmetered"?
//   2. Did THIS successful reservation cross the 80% line?
//
// Both are three-line decisions, and both used to be inlined in index.ts,
// where nothing tested them. The 80% one in particular is an equality on a
// rounded number, which is exactly the kind of arithmetic that quietly never
// fires (`>=` would fire on every call after the line; `>` would skip the line
// itself). Kept out of index.ts for the same reason as text-safety.ts: pure
// functions of their arguments, testable without booting the server.
// ---------------------------------------------------------------------------

/**
 * One row of `workspace_action_allowance()`, exactly as PostgREST returns it.
 *
 * `cap` and `remaining` are null when there is nothing to run out of (exempt).
 * `grace_ends_at` is null for anything that is not a non-exempt Free workspace.
 * Timestamps are ISO 8601 strings, which is what `reserve_action_usage` takes.
 */
export interface ActionAllowanceRow {
  plan: string;
  owner_id: string;
  exempt: boolean;
  exempt_reason: "early_member" | "comped" | "exemption" | null;
  cap: number | null;
  period_start: string;
  period_end: string;
  grace_ends_at: string | null;
  in_grace: boolean;
  used: number;
  remaining: number | null;
}

/** The two things the edge function can do with an allowance row. */
export type AllowanceDecision =
  | {
    kind: "allow_unmetered";
    /**
     * Why no reservation is made. `no_row` is an unknown workspace id (the
     * function returns nothing, and a call that cannot be attributed is not
     * refused on that account); `empty_window` is the defensive case where the
     * counting window has zero width, which `reserve_action_usage` would
     * reject with 22007 rather than answer.
     */
    reason: "no_row" | "exempt" | "in_grace" | "no_cap" | "empty_window";
  }
  | {
    kind: "meter";
    cap: number;
    periodStart: string;
    periodEnd: string;
  };

/**
 * Reads the allowance row into a decision.
 *
 * Order matters only for the reason string: an exempt workspace is reported as
 * exempt even though its `cap` is also null, because "early member" is the
 * fact a log line or a dashboard wants, and "no cap" is merely its consequence.
 */
export function allowanceDecision(row: ActionAllowanceRow | null | undefined): AllowanceDecision {
  if (!row) return { kind: "allow_unmetered", reason: "no_row" };
  if (row.exempt) return { kind: "allow_unmetered", reason: "exempt" };
  if (row.in_grace) return { kind: "allow_unmetered", reason: "in_grace" };
  if (row.cap === null || row.cap === undefined) return { kind: "allow_unmetered", reason: "no_cap" };
  if (!(Date.parse(row.period_start) < Date.parse(row.period_end))) {
    return { kind: "allow_unmetered", reason: "empty_window" };
  }
  return { kind: "meter", cap: row.cap, periodStart: row.period_start, periodEnd: row.period_end };
}

/**
 * True when a metered workspace has no allowance left RIGHT NOW.
 *
 * This is the pre-run check for an unattended automation: a rule with zero
 * remaining is paused before it opens the mailbox, rather than being allowed
 * to search, claim its first message and then be refused on the reservation.
 * An unmetered row is never exhausted, by definition.
 */
export function isAllowanceExhausted(row: ActionAllowanceRow | null | undefined): boolean {
  if (allowanceDecision(row).kind !== "meter") return false;
  return (row!.remaining ?? 0) <= 0;
}

/** The count at which the 80% warning fires: 120 for a cap of 150. */
export function warningThreshold(cap: number): number {
  return Math.ceil(0.8 * cap);
}

/**
 * True for every reservation whose `used_actions` (rows plus live reservations,
 * this call included) sits in the warning band: at or past the 80% line and
 * still below the cap.
 *
 * A band, not an equality, on purpose. The first version fired only on the call
 * whose count landed exactly on 120, and prod verification on 2026-09-13 showed
 * how that misses: the line can be stepped over by rows that were never a
 * reservation (a quantity above one, an operator backfill, a repaired ledger),
 * and a reservation that lands on 120 and then fails leaves the count at 119
 * for the next call to land on 120 again only by luck. The queue's unique
 * index on (workspace, template, period_start) makes every insert after the
 * first a 23505 no-op, so firing in the band costs one cheap refused insert
 * per call for the last fifth of the month and can never send twice.
 *
 * The threshold is compared against the reservation's `used_actions`, which
 * already includes the reservation being made, not against the allowance
 * row's `used`, which was read a moment earlier and excludes it.
 */
export function isWarningCrossing(used: number, cap: number): boolean {
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return false;
  return used >= warningThreshold(cap) && used < cap;
}
