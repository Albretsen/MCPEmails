/**
 * A poll that only runs while someone can see it.
 *
 * Two panels used to poll on a bare `setInterval`, forever, in hidden tabs: the
 * dashboard's large-work runs (every 5 s, about 25k function calls a month,
 * nearly all of them "still nothing running") and the kiosk health panel.
 * This is the shared loop that replaced both.
 *
 * - While `document.visibilityState` is `hidden`, nothing is scheduled.
 * - On becoming visible again, it polls at once and resumes its cadence, so a
 *   returning tab never shows a minutes-old answer.
 * - The delay is read again after every poll (`intervalMs`), so a caller can
 *   poll fast while something is happening and slowly while idle.
 * - `now()` polls immediately and restarts the clock, for a user action that
 *   should be reflected without waiting for the next tick.
 *
 * Chained `setTimeout`, not `setInterval`: the next poll is scheduled only
 * after the previous one settles, so a slow response never stacks requests.
 */

export interface VisibilitySource {
  visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface VisiblePollOptions {
  /** One poll. Errors are the caller's to handle; a rejection is swallowed here. */
  poll: () => unknown;
  /** Delay before the next poll, read after each poll settles. */
  intervalMs: () => number;
  /** Poll once at start (if visible) instead of waiting one interval. */
  immediate?: boolean;
  /** Defaults to the global `document`. Injectable for tests. */
  doc?: VisibilitySource;
}

export interface VisiblePoll {
  /** Poll now and restart the clock. */
  now(): void;
  /** Stop for good: clears the timer and the visibility listener. */
  stop(): void;
}

export function startVisiblePoll({ poll, intervalMs, immediate = false, doc }: VisiblePollOptions): VisiblePoll {
  const source: VisibilitySource | undefined = doc ?? (typeof document === 'undefined' ? undefined : document);
  const hidden = () => source?.visibilityState === 'hidden';

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Bumped by every tick; a settling poll only reschedules if it is still the
  // latest, so `now()` during an in-flight poll cannot leave two clocks running.
  let generation = 0;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const schedule = () => {
    clear();
    if (stopped || hidden()) return;
    timer = setTimeout(tick, Math.max(0, intervalMs()));
  };

  async function tick() {
    clear();
    if (stopped || hidden()) return;
    const mine = ++generation;
    try {
      await poll();
    } catch {
      // The caller's poll owns its own error state.
    }
    if (mine === generation) schedule();
  }

  const onVisibility = () => {
    if (stopped) return;
    if (hidden()) clear();
    else void tick();
  };

  source?.addEventListener('visibilitychange', onVisibility);
  if (immediate) void tick();
  else schedule();

  return {
    now() {
      if (!stopped) void tick();
    },
    stop() {
      stopped = true;
      clear();
      source?.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
