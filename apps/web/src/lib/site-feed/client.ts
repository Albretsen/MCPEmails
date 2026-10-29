/**
 * The only code that talks to albretsen.no.
 *
 * Every call has a timeout and a small retry budget, and none of them throws:
 * the feed is decoration on someone else's site, and a slow or broken
 * albretsen.no must cost this app one short cron run, never an error.
 *
 * The bearer key is passed in by the caller, put on the request, and never
 * logged or returned.
 */

export const SITE_FEED_BASE_URL = 'https://albretsen.no';

const TIMEOUT_MS = 5_000;
const BACKOFF_MS = [300, 900];

export type SiteResponse = {
  /** HTTP status, or 0 when no response arrived (timeout, DNS, reset). */
  status: number;
  ok: boolean;
  /** Parsed JSON body when there was one. */
  body?: unknown;
};

export type SiteClientOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Retries after the first attempt, on a network error or a 5xx. */
  retries?: number;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One request with timeout and retries. Never throws. */
export async function siteRequest(
  path: string,
  init: { method: 'GET' | 'POST'; key?: string; json?: unknown },
  options: SiteClientOptions = {},
): Promise<SiteResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? realSleep;
  const retries = options.retries ?? BACKOFF_MS.length;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.key) headers.Authorization = `Bearer ${init.key}`;
  if (init.json !== undefined) headers['Content-Type'] = 'application/json';

  let last: SiteResponse = { status: 0, ok: false };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
    try {
      const response = await fetchImpl(`${SITE_FEED_BASE_URL}${path}`, {
        method: init.method,
        headers,
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        cache: 'no-store',
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      last = { status: response.status, ok: response.ok, body };
      if (response.status < 500) return last;
    } catch {
      last = { status: 0, ok: false };
    }
  }
  return last;
}
