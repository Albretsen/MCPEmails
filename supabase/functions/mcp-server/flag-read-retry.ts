/**
 * flag-read-retry.ts — one more try for a card flag that failed to read.
 *
 * The draft editor's two switches (`workspaces.draft_editor_enabled|hidden`,
 * `inboxes.draft_editor_hidden`) are each read with their own small query, and
 * both readers fail CLOSED: an unreadable flag means no card. That is the right
 * answer for a column that does not exist yet (a deploy that landed before its
 * migration), and it was the wrong one for the failure that actually happens in
 * production: 2026-10-12 16:13:51Z, PostgREST answered the inbox read with a
 * `502 Bad Gateway`, the draft was written fine, and the user got a tool result
 * with no card under a host header that then looked broken.
 *
 * A 502 is over in milliseconds. So a failed read is asked once more after a
 * short pause before the caller falls back. One retry, not a loop: this runs
 * inside a draft write the user is waiting on, and a flag that fails twice is
 * treated exactly as before.
 */

export interface FlagRead<T> {
  data: T | null;
  error: { message: string } | null;
}

/** Long enough for a gateway blip to pass, short enough not to be felt. */
export const FLAG_READ_RETRY_PAUSE_MS = 150;

/**
 * Run `read`; if it reports an error or throws, run it once more.
 *
 * Returns the last attempt's outcome, with a thrown error folded into `error`
 * so callers have one failure shape. `retried` says whether the second attempt
 * was needed, which is the number worth logging.
 */
export async function readFlagWithOneRetry<T>(
  read: () => PromiseLike<FlagRead<T>>,
  pauseMs: number = FLAG_READ_RETRY_PAUSE_MS,
): Promise<FlagRead<T> & { retried: boolean }> {
  const attempt = async (): Promise<FlagRead<T>> => {
    try {
      const { data, error } = await read();
      return { data: data ?? null, error: error ? { message: error.message } : null };
    } catch (thrown) {
      return {
        data: null,
        error: { message: thrown instanceof Error ? thrown.message : String(thrown) },
      };
    }
  };
  const first = await attempt();
  if (!first.error) return { ...first, retried: false };
  if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  return { ...(await attempt()), retried: true };
}
