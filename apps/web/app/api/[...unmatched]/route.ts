import { NextResponse } from 'next/server';

/**
 * A real 404 for any /api path that matches no route.
 *
 * WHY THIS EXISTS. Without it, an unmatched API path was answered by the
 * platform's own not-found handling, and that answer was wrong in two ways at
 * once. It carried an HTML body (`content-type: text/html`) to a caller that
 * asked for an API, and, on Vercel, its status varied by method:
 *
 *   GET 404 | HEAD 404 | POST 200 | PUT 200 | PATCH 200 | DELETE 200
 *
 * all six naming `x-matched-path: /_not-found`. Measured against production
 * 2026-08-30 on two randomly generated nonexistent paths.
 *
 * The 200 is the damaging half. The ordinary way to call an API is
 * `if (res.ok) return res.json()`, so a typo'd or removed endpoint did not
 * fail: it passed the `res.ok` check and then threw a JSON parse error on an
 * HTML document, at a place with nothing to do with the real mistake. It also
 * defeats the obvious way to check whether a route survived a deploy, and it
 * did exactly that here: a concurrent session POSTed to
 * /api/workspaces/invite-resend, read 200, and took it as proof the route was
 * live during a window in which it had in fact been reverted.
 *
 * Note the failure was NOT reproducible against a local `next start`, which
 * answers 404 under every method. It is introduced by the deployment platform
 * on paths that reach no function, which is why the fix is to make sure every
 * /api path reaches one rather than to change how not-found is rendered.
 *
 * WHY A CATCH-ALL ROUTE RATHER THAN A PROXY CHANGE. The proxy already matches
 * /api deliberately: every non-marketing path goes through `updateSession`,
 * which refreshes the Supabase session cookie for API calls too (see the header
 * of proxy.ts, and `routeRequest`, which is the actual dispatch: the matcher is
 * not the routing decision). Excluding /api there would stop long-lived
 * dashboard sessions from having their access token refreshed, and they would
 * begin failing with 401s once it expired, which a manual check with a freshly
 * issued token would not reveal.
 *
 * PRECEDENCE. A catch-all is the lowest-priority match in the App Router, so
 * every real route, static (`/api/usage`) or dynamic (`/api/workspaces/[id]`),
 * continues to win. This only ever answers paths that would otherwise have
 * reached nothing.
 */

/** Same body and status for every method: the path does not exist. */
function unmatched(): NextResponse {
  return NextResponse.json(
    { error: 'Not found.' },
    {
      status: 404,
      // An API caller that reached here is very likely looking at a stale or
      // mistyped URL, and a cached 404 would outlive the fix for it.
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

// Every method the platform was answering with a 200, plus the two it already
// answered correctly, so the behaviour no longer depends on the verb at all.
export const GET = unmatched;
export const HEAD = unmatched;
export const POST = unmatched;
export const PUT = unmatched;
export const PATCH = unmatched;
export const DELETE = unmatched;
export const OPTIONS = unmatched;
