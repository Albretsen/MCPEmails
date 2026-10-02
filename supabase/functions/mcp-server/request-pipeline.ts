// ---------------------------------------------------------------------------
// The two decisions the tools/call pipeline makes about its own bookkeeping.
//
// Measured 2026-10-02: every tools/call paid about 2.1 s that the logged
// `duration_ms` never saw. The function runs in us-east-1, the database is in
// Europe (about 124 ms per PostgREST round trip), and roughly 15 round trips
// ran one after another around the handler: 8 before the timer started and 6
// after it stopped. index.ts now overlaps the reads in front of the handler
// and moves the writes behind the response. What is left in this module is the
// part of that with a rule in it, kept out of index.ts for the same reason as
// action-allowance.ts: pure functions of their arguments, testable without
// booting the server.
//
//   1. settleAfterResponse: the activity log row, the usage meter and the
//      first-use markers are written AFTER the client has its answer when the
//      runtime can keep the isolate alive for them, and awaited exactly as
//      before when it cannot.
//   2. firstUseAlreadyRecorded: an activated workspace has nothing left to
//      mark, so it pays none of markFirstProductUse's four round trips.
// ---------------------------------------------------------------------------

/** The slice of the edge runtime this module needs. */
export interface BackgroundRuntime {
  waitUntil?: (promise: Promise<unknown>) => unknown;
}

/** One post-response write. `name` is what a failure is logged under. */
export type PostResponseTask = [name: string, run: () => Promise<unknown>];

/**
 * The runtime's background-task hook, or null where there is none.
 *
 * Supabase's edge runtime exposes `EdgeRuntime.waitUntil`. Deno's test runner,
 * plain `deno run` and a self-hosted Deno do not, and reading an undeclared
 * global by its bare name is a ReferenceError there, so it is read off
 * `globalThis`. Looked up per call, not once at load, so a test can install
 * and remove it.
 */
export function backgroundRuntime(): BackgroundRuntime | null {
  const runtime = (globalThis as { EdgeRuntime?: BackgroundRuntime }).EdgeRuntime;
  return runtime && typeof runtime.waitUntil === "function" ? runtime : null;
}

/**
 * Starts every task now and decides who waits for them.
 *
 * All tasks are STARTED before this returns in either mode: the activity log
 * insert is issued at the same moment it always was, which is what the
 * activity_log-based rate limiters depend on. Only the waiting moves. With a
 * runtime hook the returned promise is already resolved and the hook keeps the
 * isolate alive until the writes settle; without one the returned promise IS
 * the writes, so the caller's `await` behaves exactly as the old serial awaits
 * did (tests, self-hosting, any runtime that would otherwise drop the work).
 *
 * A task that throws or rejects is reported through `onFailure` and never
 * propagates: bookkeeping must not be able to fail a tool call whose work is
 * already done, and one failed write must not cancel its siblings. Each task
 * still logs its own PostgREST `error` the way it always has; `onFailure`
 * covers what those checks cannot see (a rejected fetch, a thrown bug).
 */
export function settleAfterResponse(
  tasks: PostResponseTask[],
  onFailure: (name: string, error: unknown) => void,
  runtime: BackgroundRuntime | null = backgroundRuntime(),
): Promise<void> {
  const settled = Promise.all(tasks.map(async ([name, run]) => {
    try {
      await run();
    } catch (error) {
      onFailure(name, error);
    }
  })).then(() => undefined);

  if (runtime?.waitUntil) {
    try {
      runtime.waitUntil(settled);
      return Promise.resolve();
    } catch (error) {
      // A hook that refuses the work must not lose it: fall through and let
      // the caller wait, which is the pre-existing behaviour.
      onFailure("wait_until", error);
    }
  }
  return settled;
}

/**
 * The two activation timestamps on a workspace row, as PostgREST returns them.
 * Both are written once by markFirstProductUse and never cleared.
 */
export interface FirstUseMarkers {
  analytics_first_tool_used_at?: string | null;
  onboarding_value_activated_at?: string | null;
}

/**
 * True when markFirstProductUse has nothing left to write for this call.
 *
 * The first-tool marker must already be set. The value marker must be set too,
 * unless this call could not set it anyway: value activation needs a resolved
 * inbox and a tool other than inbox_list (see markFirstProductUse).
 *
 * Fails toward doing the work. Unknown markers (the plan check failed open, or
 * the caller did not go through it) and a row that lacks either column both
 * answer false, and the full marker path runs as it did before. That path is
 * guarded by `IS NULL` updates, so running it needlessly costs round trips and
 * never correctness. The opposite mistake would silently stop recording
 * activations, which is why absence is never read as "already recorded".
 */
export function firstUseAlreadyRecorded(
  markers: FirstUseMarkers | null | undefined,
  inboxId: string | null,
  toolName: string,
): boolean {
  if (!markers || !markers.analytics_first_tool_used_at) return false;
  const canValueActivate = inboxId !== null && toolName !== "inbox_list";
  return !canValueActivate || Boolean(markers.onboarding_value_activated_at);
}
