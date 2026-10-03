// ---------------------------------------------------------------------------
// provider-concurrency.ts — issuing provider requests a few at a time while
// keeping every observable result exactly what a one-at-a-time loop produces.
//
// Kept out of index.ts for the usual reason (index.ts cannot be imported
// without booting the server) and because the two rules in here are the whole
// of what makes the change safe, so they are worth testing on their own:
//
//   * results come back in ITEM order, whatever order the requests finished in;
//   * when work fails, the failure that is reported is the one a serial loop
//     would have reported: the lowest-index one.
//
// The caps live with the callers, next to the provider they protect. Both
// providers meter concurrent requests per mailbox (Graph documents four per
// app per mailbox; Gmail answers 429 "Too many concurrent requests for user"),
// which is why nothing here is ever unbounded.
// ---------------------------------------------------------------------------

/**
 * `task` over every item, at most `limit` running at once, results in the
 * order of `items`.
 *
 * Items are STARTED in index order. If a task rejects, no further item is
 * started, everything already running is allowed to settle, and the rejection
 * of the lowest index is thrown. That is the error a `for` loop with `await`
 * would have thrown, because every lower index was started before the failing
 * one. A `limit` of 1 is that loop.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.min(items.length, Math.max(1, Math.floor(limit) || 1));
  const failures = new Map<number, unknown>();
  let next = 0;

  const worker = async (): Promise<void> => {
    while (failures.size === 0 && next < items.length) {
      const index = next++;
      try {
        results[index] = await task(items[index], index);
      } catch (error) {
        failures.set(index, error);
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));

  if (failures.size > 0) throw failures.get(Math.min(...failures.keys()));
  return results;
}
