/**
 * Is the product up? Asked by the wall board every 45 seconds.
 *
 * WHY A ROUTE AND NOT A SERVER RENDER. The board's own tick is
 * `router.refresh()` every five minutes, and every other number on it is
 * cached for ten. Both are right for growth metrics and both are wrong for an
 * outage: five minutes of "all green" after the endpoint stopped answering is
 * five minutes of a display actively lying to the room, and the failure mode
 * of a wall display is that people believe it. This endpoint is uncached, its
 * data is read fresh (see kiosk-health.ts), and the board polls it on a much
 * faster clock than it refreshes itself.
 *
 * The 45 second cadence is set by the client. It is deliberately faster than
 * anything it observes: the synthetic monitor runs every five minutes, so the
 * board learns of a failed check within a minute of it being recorded, and the
 * end-to-end worst case from a real outage to a red screen is one monitor
 * cycle plus one poll.
 *
 * SAME DOOR AS THE BOARD. It sits under `/api/kiosk`, which is one of the two
 * paths the kiosk cookie is scoped to (src/lib/admin/kiosk-cookie.ts), so the
 * display authenticates with the cookie it was issued at bootstrap and no
 * token appears in any URL or access log. `?k=` still works for checking the
 * endpoint by hand with curl, exactly as on the version route beside it.
 *
 * IT NEVER RETURNS AN ERROR STATUS for a data problem. A 500 here would be
 * indistinguishable, from the board's side, from the site being down, and the
 * two want different words on the wall. A failed read comes back as a 200
 * carrying an explicitly unknown verdict, which the board paints amber.
 */

import { requireKioskAccess } from '@/lib/admin/require-kiosk';
import { fetchSystemHealth } from '@/lib/analytics/kiosk-health';

/** Never prerendered, never cached: a cached answer here is the bug itself. */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  await requireKioskAccess(new URL(request.url).searchParams.get('k') ?? undefined);
  const health = await fetchSystemHealth();
  return Response.json(health, {
    headers: { 'cache-control': 'no-store, max-age=0' },
  });
}
