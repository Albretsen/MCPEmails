/* One bounded retry for provider streams.
 *
 * A retry is only safe while nothing has reached the caller: once a text delta
 * or a tool call was emitted, a second attempt would duplicate it. So the rule
 * is: at most ONE retry, only for errors marked retryable, only before the
 * first event, never after an abort.
 */

import { isAbortError, LlmError, type LlmEvent } from "./types.ts";

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const MAX_RETRIES = 1;
const BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 2_000;

export const realSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new LlmError("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LlmError("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export function retryDelayMs(err: LlmError): number {
  const asked = err.retryAfterSeconds;
  if (asked !== undefined && Number.isFinite(asked) && asked >= 0) return Math.min(asked * 1000, MAX_DELAY_MS);
  return BASE_DELAY_MS;
}

export async function* streamWithRetry(
  open: () => AsyncIterable<LlmEvent>,
  opts: { signal: AbortSignal; sleep?: Sleep },
): AsyncGenerator<LlmEvent, void, undefined> {
  const sleep = opts.sleep ?? realSleep;
  let retries = 0;
  while (true) {
    let emitted = false;
    try {
      for await (const event of open()) {
        emitted = true;
        yield event;
      }
      return;
    } catch (err) {
      if (opts.signal.aborted || isAbortError(err)) throw new LlmError("aborted");
      const llmErr = err instanceof LlmError ? err : new LlmError("network");
      if (emitted || !llmErr.retryable || retries >= MAX_RETRIES) throw llmErr;
      retries++;
      await sleep(retryDelayMs(llmErr), opts.signal);
    }
  }
}
