// ---------------------------------------------------------------------------
// rate-limit-headers.ts - RateLimit-* headers on an answered tools/call.
//
// A 429 already carries Retry-After and X-RateLimit-*; a successful call
// carried nothing, so a client could not pace itself before it hit the wall.
// Every answered tools/call now carries the IETF draft names
// (draft-ietf-httpapi-ratelimit-headers):
//
//   RateLimit-Limit      the limit of the tighter window
//   RateLimit-Remaining  calls left in it, this one excluded
//   RateLimit-Reset      seconds until it certainly has room again
//
// "The tighter window" is whichever of two leaves less room: the per-key
// rolling window (checkRateLimit) or the workspace's per-minute plan ceiling
// (checkPlanQuota). Both numbers are already in hand when the call is routed,
// so the headers cost no query. The windows roll, so Reset is an upper bound:
// the full width of the chosen window.
//
// Run: deno test supabase/functions/mcp-server/rate-limit-headers.test.ts
// ---------------------------------------------------------------------------

/** One window's room. */
export interface RateLimitHeadroom {
  limit: number;
  /** Calls left in the window, this one excluded. */
  remaining: number;
  /** Seconds until the window is certain to have room again. */
  resetSeconds: number;
}

/** The headers a browser client must be allowed to read (CORS Expose-Headers). */
export const RATE_LIMIT_HEADER_NAMES = ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"] as const;

/** A window's room from its limit and the calls already counted in it. */
export function headroom(limit: number, used: number, windowMs: number): RateLimitHeadroom {
  return {
    limit,
    remaining: Math.max(0, limit - used - 1),
    resetSeconds: Math.ceil(windowMs / 1_000),
  };
}

/** The window with less room. A tie goes to the workspace (the plan's own number). */
export function tighterHeadroom(
  key: RateLimitHeadroom | undefined,
  workspace: RateLimitHeadroom | undefined,
): RateLimitHeadroom | undefined {
  if (key && workspace) return workspace.remaining <= key.remaining ? workspace : key;
  return key ?? workspace;
}

/** The three headers for the tighter window; empty when neither gate counted. */
export function rateLimitHeaders(
  key: RateLimitHeadroom | undefined,
  workspace: RateLimitHeadroom | undefined,
): Record<string, string> {
  const pick = tighterHeadroom(key, workspace);
  if (!pick) return {};
  return {
    "RateLimit-Limit": String(pick.limit),
    "RateLimit-Remaining": String(pick.remaining),
    "RateLimit-Reset": String(pick.resetSeconds),
  };
}

/**
 * Stamp the headers on a tools/call answer that is a result, not a JSON-RPC
 * error (a 429 or another error carries its own headers or none).
 */
export function withRateLimitHeaders(
  http: Response,
  body: unknown,
  headers: Record<string, string>,
): Response {
  if (Object.keys(headers).length === 0) return http;
  if (body && typeof body === "object" && "error" in body && (body as { error?: unknown }).error) return http;
  for (const [name, value] of Object.entries(headers)) http.headers.set(name, value);
  return http;
}
