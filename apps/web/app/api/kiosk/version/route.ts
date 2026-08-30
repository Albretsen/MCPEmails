/**
 * Which build the kiosk is looking at.
 *
 * WHY THIS EXISTS. The board is a wall display nobody touches for weeks, and
 * its five-minute tick is `router.refresh()`, a soft re-render. A soft refresh
 * cannot recover from a deploy: the tab keeps running the bundle it booted
 * with, so a shipped change can sit in production for up to a day, until the
 * board's once-daily hard reload happens to come round. That is exactly what
 * happened on 2026-08-29: the money tiles went live and the panel on the wall
 * carried on showing the previous board, with nothing on either side saying
 * so. A screen whose whole job is to be trusted at a glance must not be
 * capable of being silently a day out of date.
 *
 * WHY A ROUTE RATHER THAN A PROP. The board could pass the deployment id
 * through the server render it already does, but that only works if the
 * refresh reaches the new deployment, which depends on how Next and the
 * platform resolve a client running an older build. An explicit `no-store`
 * fetch does not depend on any of that: it asks production what production is
 * running, and the answer is either the id the tab booted with or it is not.
 *
 * It is behind the same door as the board itself. The deployment id is not
 * much of a secret, but this is an admin surface and the cost of keeping it
 * closed is one line.
 *
 * In practice that door is now the kiosk cookie, not `?k=`: the board polls
 * this route with no query string at all and the browser attaches the cookie
 * it was issued at bootstrap (src/lib/admin/kiosk-cookie.ts, audit finding
 * F-06 — a token in a query string is a token in an access log, and this route
 * is the one the display hits every five minutes for years). The `?k=` read
 * below is kept only so the endpoint can still be checked by hand with curl.
 */

import { currentDeployment } from '@/lib/admin/deployment';
import { requireKioskAccess } from '@/lib/admin/require-kiosk';

/** Never prerendered, never cached: a cached answer here is the bug itself. */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  await requireKioskAccess(new URL(request.url).searchParams.get('k') ?? undefined);
  return Response.json(
    { deployment: currentDeployment() },
    { headers: { 'cache-control': 'no-store, max-age=0' } },
  );
}
