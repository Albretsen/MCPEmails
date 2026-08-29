// ---------------------------------------------------------------------------
// Wall-clock budget for bulk mailbox operations.
//
// ── The problem this exists to solve ────────────────────────────────────────
// Bulk tools are fine at the median and catastrophic in the tail. Thirty days
// of production said email_search_and_delete runs 2.4s at p50 and 139s at p99,
// with a 192s maximum; email_search_and_move 4.3s → 106s; email_read_batch
// 5.2s → 63s. Most MCP clients abandon a tool call somewhere between 30s and
// 60s, so roughly one call in eleven of search_and_delete was given up on by
// the client even when the server went on to succeed.
//
// For a DESTRUCTIVE operation that is the worst possible failure mode. The user
// asked to delete 500 messages, the client timed out, and nobody — not the
// user, not the model — knows whether zero, some, or all of them are gone. The
// only safe next step a model can take is to look, and it usually does not.
//
// The fix is not "be faster" (though the IMAP session reuse in imap-session.ts
// is worth several seconds of it). The fix is to make the server stop on OUR
// schedule rather than the client's, while it still owns the connection and can
// say precisely what happened. A budget-stopped call returns a normal, complete,
// successful tool result that happens to say "I did 140 of 500, here are the
// other 360, call me again". That is strictly more information than a client
// timeout can ever carry.
//
// ── Why the budget is checked and not raced ─────────────────────────────────
// A Promise.race against a timer would abandon an in-flight IMAP command mid
// socket read, leaving the caller with no idea whether the server applied it.
// Every stop here is COOPERATIVE: taken between units of work, at a point where
// the completed set is exactly known. That is the same discipline
// `shouldStopBulkRun` already uses for user cancellation, which is why a budget
// stop rides the same plumbing rather than inventing a parallel one.
// ---------------------------------------------------------------------------

/**
 * Wall-clock allowance for one whole bulk tool call, search phase included.
 *
 * 25 seconds, chosen against the client rather than against the server: the
 * Supabase Edge Function itself will happily run for minutes, so the binding
 * constraint is the MCP client, which gives up somewhere in the 30–60s band.
 * Sitting at 25s leaves headroom for the request/response hop, the activity-log
 * write and the usage accounting that run after the provider work finishes, so
 * a budget-stopped result actually reaches the client inside even the most
 * impatient 30s limit. It is deliberately below `SEARCH_TIMEOUT_MS` (30s) —
 * that constant bounds one provider search, this one bounds the entire call.
 */
export const BULK_WALL_CLOCK_BUDGET_MS = 25_000;

/**
 * Time held back from the search phase of a search_and_* call so the act phase
 * always gets a usable slice.
 *
 * Without this, a slow search could eat the whole budget and the operation
 * would report "0 of 500 done" — technically honest, practically useless, and a
 * regression against today's behaviour where the act phase at least ran. Eight
 * seconds is enough for the first folder group's connect plus a bulk UID MOVE,
 * so a budget-stopped call always makes real progress.
 */
export const BULK_ACT_PHASE_RESERVE_MS = 8_000;

/**
 * Why a bulk run stopped short of its input.
 *
 * `cancelled` is a human pressing Stop in the dashboard; `time_budget` is this
 * module. They are kept distinct all the way into the `bulk_runs` record
 * because they mean opposite things operationally: one is the product working,
 * the other is a mailbox big enough to need a second call.
 */
export type BulkStopReason = "cancelled" | "time_budget";

/** A monotonic-ish clock, injectable so tests do not have to sleep. */
export type NowFn = () => number;

/**
 * A single tool call's remaining wall-clock allowance.
 *
 * Created once at the top of a bulk handler and threaded down, so the search
 * phase and the act phase spend from the SAME pot. Before this existed a
 * search_and_delete could legitimately take 30s searching and then another 60s
 * deleting, because neither half knew about the other.
 */
export interface WorkBudget {
  /** Milliseconds left before the call must stop. Never negative. */
  remainingMs(): number;
  /** True once the allowance is spent. Checked between units of work. */
  exhausted(): boolean;
  /**
   * The slice the search phase may use: whatever is left minus the act-phase
   * reserve, and never more than the caller's own per-search ceiling.
   */
  searchPhaseMs(searchCeilingMs: number): number;
  /** Total allowance, for reporting. */
  totalMs: number;
  /** Milliseconds spent so far, for reporting. */
  elapsedMs(): number;
}

export function createWorkBudget(
  totalMs: number = BULK_WALL_CLOCK_BUDGET_MS,
  now: NowFn = Date.now,
): WorkBudget {
  const startedAt = now();
  const remainingMs = () => Math.max(0, totalMs - (now() - startedAt));
  return {
    totalMs,
    remainingMs,
    elapsedMs: () => now() - startedAt,
    exhausted: () => remainingMs() <= 0,
    // The floor of 1ms matters: handing Promise.race a 0ms timer would reject
    // the search before it was even issued, turning a tight-but-survivable
    // budget into a hard search_timeout error. Better to let one search run and
    // have the act phase report an honest zero.
    searchPhaseMs: (searchCeilingMs: number) =>
      Math.max(1, Math.min(searchCeilingMs, remainingMs() - BULK_ACT_PHASE_RESERVE_MS)),
  };
}

/**
 * Where a caller should go to finish a budget-stopped operation.
 *
 * The remaining ids are returned VERBATIM rather than a "re-run the same
 * search" instruction. Re-running the search is the obvious cheap answer and it
 * is wrong for exactly the reason `bulk_plans` refuses to store a search: mail
 * that arrived during the first pass would match the second one, so a resumed
 * delete could destroy messages the user never saw, let alone approved. An
 * explicit id list can only ever affect the set the first call already resolved.
 */
export interface BulkContinuation {
  tool: string;
  action: string;
  /** The ids that were NOT processed. Exact, ordered, and safe to replay. */
  message_ids: string[];
}

/**
 * Consolidated tool + action a caller should use to finish the remainder.
 *
 * Keyed by the LEGACY operation name because that is what the bulk handlers
 * know themselves as internally; the values are the public consolidated names,
 * which are the only ones a client can actually call. `inbox_list`,
 * `email_delete` and `email_organize` are contractually fixed names — see the
 * tool-surface notes in index.ts before touching them.
 */
const CONTINUATION_BY_OPERATION: Record<string, { tool: string; action: string }> = {
  email_search_and_delete: { tool: "email_delete", action: "delete_batch" },
  email_delete_batch: { tool: "email_delete", action: "delete_batch" },
  email_search_and_move: { tool: "email_organize", action: "move_batch" },
  email_move_batch: { tool: "email_organize", action: "move_batch" },
  email_copy_batch: { tool: "email_organize", action: "copy_batch" },
  email_flag: { tool: "email_organize", action: "flag" },
  email_read_batch: { tool: "email_read", action: "read_batch" },
};

export function continuationFor(
  operation: string,
  remainingIds: string[],
): BulkContinuation | null {
  const target = CONTINUATION_BY_OPERATION[operation];
  if (!target || remainingIds.length === 0) return null;
  return { tool: target.tool, action: target.action, message_ids: remainingIds };
}

/**
 * The sentence a model reads when a bulk call stopped early.
 *
 * Written to be unambiguous about the two things that actually matter and are
 * easy to get wrong when skimming a JSON blob: how many messages were affected,
 * and how many were NOT. For a delete it says both in words, because "succeeded:
 * 140" next to "total: 500" is a subtraction the model has to notice it needs to
 * perform, and the consequence of not noticing is a user believing their mailbox
 * is clean when 360 messages are still in it.
 *
 * It deliberately does not instruct the model to do anything ("you must now
 * call…"). Stating the mechanical fact of where the remainder is leaves the
 * decision with the model and its user, which is the same rule the usage-cap
 * message follows.
 */
export function bulkPartialNotice(opts: {
  operation: string;
  total: number;
  succeeded: number;
  failed: number;
  remaining: number;
  reason: BulkStopReason;
  /** Delete only: false means "moved to Trash", true means gone for good. */
  permanent?: boolean;
  budgetMs?: number;
}): string {
  const { operation, total, succeeded, failed, remaining, reason } = opts;
  const isDelete = operation === "email_search_and_delete" || operation === "email_delete_batch";
  const isMove = operation === "email_search_and_move" || operation === "email_move_batch";

  const verb = isDelete
    ? (opts.permanent ? "permanently deleted" : "deleted (moved to Trash)")
    : isMove
    ? "moved"
    : operation === "email_copy_batch"
    ? "copied"
    : operation === "email_read_batch"
    ? "read"
    : "processed";

  const cause = reason === "cancelled"
    ? "The run was cancelled from the dashboard."
    : `This stopped on a ${Math.round((opts.budgetMs ?? BULK_WALL_CLOCK_BUDGET_MS) / 1000)}-second ` +
      "time limit so the result could be returned before the client gave up. It is not an error, " +
      "and nothing failed.";

  const head = `PARTIAL RESULT — this operation did NOT finish. ` +
    `${succeeded} of ${total} messages were ${verb}. ` +
    `${remaining} messages were NOT ${verb} and are unchanged.`;

  const failures = failed > 0 ? ` A further ${failed} could not be ${verb}; see results.` : "";

  const rest = remaining > 0
    ? ` The exact ids still to do are in remaining_message_ids, and continuation names the tool ` +
      `and action that will finish them. Those ids are the only messages a follow-up call ` +
      `would affect.`
    : "";

  return `${head}${failures} ${cause}${rest}`;
}

/**
 * The extra result fields a partial bulk operation carries.
 *
 * `partial: true` is the machine-readable flag; the notice is the human/model
 * one. Both are present on purpose — a client that renders only text and a
 * client that renders only structuredContent must each be able to tell that the
 * job is unfinished.
 */
export interface BulkPartialFields {
  partial: true;
  stopped_reason: BulkStopReason;
  total_requested: number;
  remaining: number;
  remaining_message_ids: string[];
  continuation: BulkContinuation | null;
  partial_notice: string;
}

export function bulkPartialFields(opts: {
  operation: string;
  total: number;
  succeeded: number;
  failed: number;
  remainingIds: string[];
  reason: BulkStopReason;
  permanent?: boolean;
  budgetMs?: number;
}): BulkPartialFields {
  return {
    partial: true,
    stopped_reason: opts.reason,
    total_requested: opts.total,
    remaining: opts.remainingIds.length,
    remaining_message_ids: opts.remainingIds,
    continuation: continuationFor(opts.operation, opts.remainingIds),
    partial_notice: bulkPartialNotice({
      operation: opts.operation,
      total: opts.total,
      succeeded: opts.succeeded,
      failed: opts.failed,
      remaining: opts.remainingIds.length,
      reason: opts.reason,
      permanent: opts.permanent,
      budgetMs: opts.budgetMs,
    }),
  };
}

/**
 * Ids the run never got to.
 *
 * Derived by subtracting what was attempted from what was asked for, rather
 * than by tracking a cursor, so it stays correct however the provider helper
 * chose to order its work — IMAP groups by source folder and will finish group
 * three before group two if the ids arrived that way. A cursor would silently
 * mis-report the remainder in exactly that case.
 */
export function remainingIds(
  requested: string[],
  succeeded: string[],
  failed: { id: string }[],
): string[] {
  const done = new Set<string>(succeeded);
  for (const f of failed) done.add(f.id);
  return requested.filter((id) => !done.has(id));
}
