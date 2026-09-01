/**
 * /admin/growth/kiosk: the wall-mounted version of the growth page.
 *
 * It is a different product from /admin/growth, not a stylesheet on top of it.
 * That page is a reporting tool: eleven sections, drill-downs, info dots,
 * exact-number tables, a window switcher. This one is read at a glance by
 * someone walking past a 10 inch panel, so it shows ten numbers, fills the
 * screen exactly once, and has exactly one control.
 *
 * THAT ONE CONTROL, added 2026-09-01, needs defending, because this file used
 * to say "no controls at all" and meant it. The argument for zero still holds
 * for the panel's resting state: nobody presses anything, and a board that must
 * be configured before it says something true is a board that eventually says
 * something stale. What changed is that the single screen was being asked five
 * different questions and the tile that gave way was always whichever answered
 * the one nobody had asked that morning. So the default view still shows the
 * whole business and is what the panel returns to on its own after ten idle
 * minutes (see KioskLive); the other four exist for the two minutes somebody is
 * standing in front of it. Nothing about the unattended behaviour changed: left
 * alone, this is still a board with no controls.
 *
 * Four constraints shape it.
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
 *
 * THE FOURTH CONSTRAINT, added 2026-08-30: IT HAS TO NOTICE AN OUTAGE. Every
 * number above is a business metric that moves in weeks, and a board made only
 * of those can sit on a wall looking immaculate while the product it reports on
 * has not answered a request since breakfast. The health provider wrapping
 * everything below polls a dedicated uncached endpoint every 45 seconds and
 * owns three things: a banner across the top, a tile in the supporting strip,
 * and a state class on this root that tints the whole screen. It is the only
 * part of the board allowed to shout, and the only part that renders nothing
 * at all when it has nothing to say.
 */

import { Suspense } from 'react';
import { currentDeployment } from '@/lib/admin/deployment';
import { requireKioskAccess } from '@/lib/admin/require-kiosk';
import { fetchSystemHealth } from '@/lib/analytics/kiosk-health';
import { KioskBoard } from '../../../../components/admin/kiosk/board';
import { KioskDetail } from '../../../../components/admin/kiosk/detail';
import { KioskLive } from '../../../../components/admin/kiosk/KioskLive';
import { KioskViewSwitch } from '../../../../components/admin/kiosk/KioskViewSwitch';
import { KioskAlarm, KioskHealthProvider } from '../../../../components/admin/kiosk/KioskHealth';
import { KIOSK_VIEWS, KIOSK_WINDOW_DAYS, resolveKioskView } from '../../../../components/admin/kiosk/shared';
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
 * The board reads live counters and a per-request credential (a cookie, or a
 * `?k=` bootstrap on the very first load), so it can never be prerendered. The
 * underlying RPCs are still cached for ten minutes each, which is what actually
 * keeps this cheap to render every five.
 */
export const dynamic = 'force-dynamic';

export default async function GrowthKioskPage({
  searchParams,
}: {
  searchParams: Promise<{ k?: string; view?: string }>;
}) {
  const params = await searchParams;
  await requireKioskAccess(params.k);

  // An unknown or missing `?view=` resolves to the default rather than 404ing.
  // The panel's URL is typed by hand once, into a Chromium autostart line on a
  // Pi with no keyboard, and a typo there must leave a working board on the
  // wall rather than an error page nobody is present to dismiss.
  const view = resolveKioskView(params.view);
  const meta = KIOSK_VIEWS.find((entry) => entry.id === view) ?? KIOSK_VIEWS[0];

  const generatedAt = new Date().toISOString();

  // Awaited in the shell rather than streamed in a boundary like the board
  // below it, because the provider has to wrap everything to own the root
  // element's alarm class, and a provider cannot be handed its initial value by
  // a child. It costs the first paint a handful of indexed counts (see
  // kiosk-health.ts) and buys a hard reload that is never briefly unjudged: a
  // board that renders green for a second before admitting an outage is a board
  // someone will walk past at exactly the wrong second.
  const health = await fetchSystemHealth();

  return (
    <KioskHealthProvider initial={health}>
      <div className="kiosk-board">
        <header className="kiosk-head">
          <div className="kiosk-head-top">
            <h1 className="kiosk-wordmark">
              MCP Emails <em>{meta.question} · last {KIOSK_WINDOW_DAYS} days</em>
            </h1>
            {/* The switch sits between the wordmark and the clock so the two
                things that never move on this board stay at the two edges,
                which is what makes a changed view legible from a distance:
                the strip is the only part of the header that lights up. */}
            <KioskViewSwitch current={view} token={params.k} />
            <KioskLive
              generatedAt={generatedAt}
              deployment={currentDeployment()}
              view={view}
              token={params.k}
            />
          </div>
          {/* Inside the header, not in a grid row of its own. The header row is
              `auto` and everything below it is a fraction of the remainder, so
              the banner appearing squeezes the board rather than pushing a row
              off the bottom of the screen. */}
          <KioskAlarm />
        </header>

        {/* One boundary for the whole board, not one per tile. A wall display
            that reassembles itself panel by panel every five minutes is
            visibly busy doing nothing; this way the old frame simply stays up
            until the new one is ready. */}
        {/* Keyed on the view so switching swaps the whole board in one paint
            rather than reconciling ten tiles into ten different ones, which on
            a wall reads as the numbers scrambling in place. */}
        <Suspense key={view} fallback={<BoardSkeleton />}>
          <KioskBoard view={view} />
        </Suspense>

        <p className="kiosk-scroll-hint" aria-hidden="true">Swipe up for detail</p>
      </div>

      <Suspense fallback={null}>
        <KioskDetail />
      </Suspense>
    </KioskHealthProvider>
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
