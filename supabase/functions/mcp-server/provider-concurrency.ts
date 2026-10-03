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

/** Reads issued ahead of the loop that consumes them. See {@link createReadAhead}. */
export interface ReadAhead<R> {
  /**
   * The read for `index`, starting it now if it is not already running, along
   * with every later index below `index + width` that has not been started.
   * Must be called with indexes in increasing order, once each. A `width` of 1
   * reads nothing ahead: the read starts when it is asked for.
   */
  take(index: number, width: number): Promise<R>;
  /** Wait for every read that was started and never taken. Never rejects. */
  drain(): Promise<void>;
}

/**
 * Let a loop that must CONSUME results strictly in order start a few of the
 * reads behind them early.
 *
 * This is the shape `email_read_batch` needs and a plain bounded map is not:
 * what the loop does with message i (how much of the shared body budget it may
 * have, whether an auth failure ends the call, whether the time budget is
 * gone) depends on messages 0..i-1, so the decisions stay in the loop, in
 * order, untouched. Only the provider round trip is moved earlier.
 *
 * At most `width` reads are outstanding, counting the one being awaited, and
 * at most `width` results are ever held unconsumed, so memory is bounded by the
 * window and not by the batch.
 *
 * A read that fails rejects when it is TAKEN, in its turn. Reads started and
 * then abandoned (the loop returned early) are marked handled so they cannot
 * surface as unhandled rejections; `drain` waits for them.
 */
export function createReadAhead<R>(
  count: number,
  start: (index: number) => Promise<R>,
): ReadAhead<R> {
  const pending = new Map<number, Promise<R>>();
  let next = 0;
  return {
    take(index, width) {
      if (next < index) next = index;
      const until = Math.min(count, index + Math.max(1, Math.floor(width) || 1));
      while (next < until) {
        const i = next++;
        // An async wrapper, so a `start` that throws before returning a
        // promise is that read's rejection and not the caller's.
        const read = (async () => await start(i))();
        read.catch(() => {});
        pending.set(i, read);
      }
      const read = pending.get(index);
      if (!read) {
        return Promise.reject(new Error(`read-ahead: index ${index} was already taken or is out of range`));
      }
      pending.delete(index);
      return read;
    },
    async drain() {
      const abandoned = [...pending.values()];
      pending.clear();
      await Promise.allSettled(abandoned);
    },
  };
}
