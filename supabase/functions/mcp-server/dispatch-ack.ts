// ---------------------------------------------------------------------------
// Answer a cron dispatch at once, and run its work behind the response.
//
// Measured 2026-10-26: /triage-dispatch runs for its whole 40 second budget
// (TRIAGE_TIME_BUDGET_MS; median 39 s, every call over 5 s), while
// public.dispatch_triage_rules() calls it through pg_net with the default
// 5 second timeout. The rules ran and the function answered 200, but pg_net had
// already given up, so about 70% of production's pg_net responses were
// "Timeout of 5000 ms reached" (curl books the wait for a shared connection
// as "DNS time", which made it look like a resolver fault). The pg_net worker
// also holds its next batch until every request in the current one settles,
// so each timed-out batch made the other every-minute dispatchers (scheduled
// sends, reminders, inbox watch) start about 5 seconds late.
//
// Raising the pg_net timeout would make that wait 40 to 60 seconds instead.
// Answering 202 straight away and letting the runtime hold the isolate open for
// the work (`EdgeRuntime.waitUntil`) frees the worker in milliseconds. Where
// there is no runtime hook (tests, plain Deno, self-hosting) the work is
// awaited and its own response returned, exactly as before.
// ---------------------------------------------------------------------------

import { type BackgroundRuntime, backgroundRuntime } from "./request-pipeline.ts";

/**
 * Starts `work` now. With a runtime hook, returns a 202 at once and hands the
 * work to the hook; a rejection is reported through `onFailure`, since nobody
 * is left to receive it. Without a hook, or if the hook refuses the work,
 * returns the work's own response.
 */
export function acknowledgeThenRun(
  name: string,
  work: () => Promise<Response>,
  onFailure: (name: string, error: unknown) => void,
  runtime: BackgroundRuntime | null = backgroundRuntime(),
): Promise<Response> {
  const running = work();
  if (runtime?.waitUntil) {
    const settled = running
      .then(async (res) => {
        // Drain the body so the response is fully released.
        await res.body?.cancel();
      })
      .catch((error) => onFailure(name, error));
    try {
      runtime.waitUntil(settled);
      return Promise.resolve(
        new Response(JSON.stringify({ accepted: true }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      );
    } catch (error) {
      // A hook that refuses the work must not lose it: answer once it is done.
      onFailure("wait_until", error);
    }
  }
  return running;
}
