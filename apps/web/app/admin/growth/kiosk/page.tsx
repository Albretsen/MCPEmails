/**
 * /admin/growth/kiosk: the wall-mounted version of the growth page.
 *
 * It is a different product from /admin/growth, not a stylesheet on top of it.
 * That page is a reporting tool: eleven sections, drill-downs, info dots,
 * exact-number tables, a window switcher. This one is read at a glance by
 * someone walking past a 10 inch panel, so it shows twelve numbers, fills the
 * screen exactly once, and has no controls at all.
 *
 * Three constraints shape it.
 *
 * ONE SCREEN. Everything that matters fits in 100dvh with no scrolling, at any
 * aspect ratio, without a media query (see admin-kiosk.css for how). Scrolling
 * still works, and there is a supporting-detail section below the fold,
 * because the panel is a touchscreen and someone who wants the retention curve
 * should be able to swipe up and read it.
 *
 * NO IDENTITY. The Active accounts roster from /admin/growth is deliberately
 * absent. It is the one section there that carries workspace names and owner
 * email addresses, and this screen is visible to everyone in the room and
 * reachable with a shared token rather than an operator login. Aggregates
 * only, on both halves of the page.
 *
 * UNATTENDED. Nobody presses anything. The board refreshes itself, pins itself
 * to dark, and states in words when a panel could not load, because a blank
 * tile on a wall reads as a zero and a zero here would send someone off to
 * investigate a query timeout as if it were a collapse in usage.
 */

import { Suspense } from 'react';
import { currentDeployment } from '@/lib/admin/deployment';
import { requireKioskAccess } from '@/lib/admin/require-kiosk';
import { KioskBoard, KIOSK_WINDOW_DAYS } from '../../../../components/admin/kiosk/board';
import { KioskDetail } from '../../../../components/admin/kiosk/detail';
import { KioskLive } from '../../../../components/admin/kiosk/KioskLive';
import '../../../../styles/admin-kiosk.css';

export const metadata = {
  title: 'Growth kiosk · MCP Emails',
  robots: { index: false, follow: false },
};

/**
 * The panel drives itself at a 2x device scale factor, so this viewport is
 * about 960 logical pixels wide. `viewport-fit=cover` and the locked scale
 * stop a stray pinch on the touchscreen from leaving the board zoomed in with
 * nobody around to zoom it back out.
 */
export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#0B1020',
};

/**
 * The board reads live counters and a token from the query string, so it can
 * never be prerendered. The underlying RPCs are still cached for ten minutes
 * each, which is what actually keeps this cheap to render every five.
 */
export const dynamic = 'force-dynamic';

export default async function GrowthKioskPage({
  searchParams,
}: {
  searchParams: Promise<{ k?: string }>;
}) {
  const params = await searchParams;
  await requireKioskAccess(params.k);

  const generatedAt = new Date().toISOString();

  return (
    <div className="kiosk">
      <div className="kiosk-board">
        <header className="kiosk-head">
          <h1 className="kiosk-wordmark">
            MCP Emails <em>Growth · last {KIOSK_WINDOW_DAYS} days</em>
          </h1>
          <KioskLive generatedAt={generatedAt} deployment={currentDeployment()} />
        </header>

        {/* One boundary for the whole board, not one per tile. A wall display
            that reassembles itself panel by panel every five minutes is
            visibly busy doing nothing; this way the old frame simply stays up
            until the new one is ready. */}
        <Suspense fallback={<BoardSkeleton />}>
          <KioskBoard />
        </Suspense>

        <p className="kiosk-scroll-hint" aria-hidden="true">Swipe up for detail</p>
      </div>

      <Suspense fallback={null}>
        <KioskDetail />
      </Suspense>
    </div>
  );
}

/**
 * Holds the grid open at the right shape while the first render lands, so the
 * board does not snap from a collapsed layout into its real one. Twelve tiles
 * in the same spans the real board uses.
 */
function BoardSkeleton() {
  const spans = [3, 3, 3, 3, 7, 5, 3, 3, 3, 3];
  return (
    <>
      {spans.map((span, index) => (
        <div
          key={index}
          className="kiosk-tile is-default kiosk-skeleton"
          style={{ gridColumn: `span ${span}` }}
          aria-hidden="true"
        />
      ))}
    </>
  );
}
