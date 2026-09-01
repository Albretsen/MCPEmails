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
 * would report "0 of 500 done": technically honest, practically useless, and a
 * regression against the behaviour where the act phase at least ran.
 *
 * CUT FROM 8s TO 4s on 2026-09-01. The 8s figure was sized for work that no
 * longer happens. It was written when the act phase opened its OWN IMAP
 * connection, so the reserve had to cover a full TCP + TLS + AUTH handshake
 * (1.7s at p50 and 3.4s at p90 on Yahoo, and far worse when the provider's
 * 5-connection cap forces ImapClient.connect's 5s then 10s back-off) before a
 * single message could move. The shared ImapSession removed that connect:
 * search and act now run on one authenticated connection with the source
 * mailbox already SELECTed, so what this reserve actually has to cover is one
 * bulk `UID MOVE` (or `UID STORE` + `EXPUNGE`) over the page the search just
 * produced. Measured over thirty days of production that page is 32 UIDs at
 * p50 and 60 at p90, with 172 the largest ever observed, and one UID MOVE of
 * that size is a sub-second command on an already-selected mailbox.
 *
 * The 4s handed back to the search is the point of the change, not a side
 * effect of it. `searchPhaseMs` is the only thing that actually bounds the
 * search on these two tools, so the search phase had been running on 17s while
 * plain email_search over the same Yahoo accounts got 30s. That gap, and not
 * the mailboxes, is why email_search_and_move timed out on 13.4% of its Yahoo
 * calls (31 of 232) and email_search_and_delete on 24.1% (7 of 29), against
 * 0.80% (11 of 1380) for email_search running the same search function. This
 * makes the search phase 21s.
 *
 * Note what is deliberately NOT done to buy the same room: raising
 * BULK_WALL_CLOCK_BUDGET_MS. That 25s is measured against the client's
 * patience rather than the server's, and the margin it leaves is what carries
 * the activity-log write and the usage accounting that run after the provider
 * work finishes. Spending it would move the failure from "the search gave up
 * early" to "the client gave up on a call that had already succeeded", which is
 * the worse of the two on a mailbox-mutating tool.
 */
export const BULK_ACT_PHASE_RESERVE_MS = 4_000;

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
   *
   * The ceiling is OPTIONAL, and omitting it is the honest call on the two
   * sites that matter. Both search_and_move and search_and_delete used to pass
   * `SEARCH_TIMEOUT_MS` (30s) here, and it never once bound: with a 25s
   * whole-call budget the expression is `min(30_000, 25_000 - reserve)`, so the
   * budget always wins and the argument was dead code that made the line read
   * as though the search got thirty seconds. It did not; it got seventeen.
   * Passing nothing says what is true, which is that the whole-call budget is
   * the only bound. A caller with a genuinely tighter ceiling of its own still
   * passes it and still keeps it.
   */
  searchPhaseMs(searchCeilingMs?: number): number;
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
    searchPhaseMs: (searchCeilingMs: number = Number.POSITIVE_INFINITY) =>
      Math.max(1, Math.min(searchCeilingMs, remainingMs() - BULK_ACT_PHASE_RESERVE_MS)),
  };
}

// ---------------------------------------------------------------------------
// Bounding one provider search.
//
// ── Why this is not two lines at each call site ─────────────────────────────
// It was, and all three copies had the same two defects.
//
// `Promise.race([search, timer])` abandons the loser without cancelling it. On
// IMAP that means the socket carries on with a `UID SEARCH` or `UID FETCH`
// whose result nobody will ever read, and every polite way out of the session
// (`logout`, and therefore `ImapSession.close` and `invalidate`) is itself an
// IMAP command that queues behind the abandoned one. Production shows exactly
// that shape: plain email_search timeouts cluster at 30137 to 30166 ms, tight
// against their 30s timer, while search_and_move against a 17000 ms budget
// spread out to 36175 ms. The extra 19 seconds is a handler waiting for a
// LOGOUT to get a turn. Cancelling has to bypass the command lock, which is
// what `ImapSession.abort` (and `ImapClient.destroy` under it) is for, and it
// has to happen at the moment the timer fires rather than after the handler has
// returned.
//
// The second defect is quieter and outlives the request. `setTimeout` was never
// cleared, so a search that finished in 300 ms still left a 17-second timer
// pinned in the isolate, and a handler that simply returned on timeout orphaned
// the search promise entirely: nothing closed that connection until the
// abandoned command settled, and the isolate could be recycled first. Yahoo
// caps an account at 5 simultaneous IMAP connections, so each orphan burns one
// of five slots until the server's own idle timeout reclaims it, and the next
// call for that account pays ImapClient.connect's 5s/10s back-off for it.
//
// Living in this module rather than in a handler is deliberate: the search
// phase is the half of a bulk call that spends the budget above, and the two
// mailbox-mutating handlers plus email_search should not each carry their own
// slightly different version of this.
// ---------------------------------------------------------------------------

/**
 * Run one provider search under a hard deadline, cancelling it when the
 * deadline passes.
 *
 * `startSearch` is invoked immediately: the deadline covers the search as the
 * caller wrote it, connect included, not just the part after some setup.
 *
 * `cancel` is called BEFORE the rejection is delivered, so the socket is
 * already being torn down by the time the handler's own `finally` runs and asks
 * the session to close. It is best-effort by contract: it must not throw, and
 * a throw is swallowed here rather than replacing the timeout the caller needs
 * to see. Pass null when there is nothing to cancel (an HTTP provider, where
 * abandoning the fetch costs a socket the OS will reap and not a slot against a
 * five-connection cap).
 *
 * Rejects with `Error("search_timeout")`, the sentinel every call site already
 * matches on. The abandoned search keeps a rejection handler attached (the
 * `then` below registers one), so its eventual failure, which after a cancel is
 * near-certain, can never surface as an unhandled rejection.
 */
export async function raceSearchWithTimeout<T>(
  startSearch: () => Promise<T>,
  timeoutMs: number,
  cancel: (() => void) | null,
): Promise<T> {
  // Outside the try: a synchronous throw from `startSearch` is the caller's own
  // bug and should propagate untouched, with no timer to clean up.
  const search = startSearch();
  let timer: number | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        try {
          cancel?.();
        } catch {
          // A failed cancel is a leaked connection, which the provider's idle
          // timeout eventually reclaims. Reporting it instead of the timeout
          // would tell the caller the wrong thing about what went wrong.
        }
        reject(new Error("search_timeout"));
      }, timeoutMs);
      search.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
