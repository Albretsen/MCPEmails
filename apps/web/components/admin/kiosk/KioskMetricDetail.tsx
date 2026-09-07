/**
 * The full-screen panel behind a tapped tile.
 *
 * WHY THIS EXISTS. The board is deliberately ten numbers with no detail: it is
 * read from across a room and every extra line on it costs the legibility of
 * the ones that matter. But the panel is a touchscreen, and the question that
 * follows every glance is the same one ("active users are up, up from what?"),
 * so the answer has to be one tap away rather than on a laptop somewhere. The
 * board stays a board; the detail is a layer over it.
 *
 * A URL, NOT CLIENT STATE, like everything else here. `?detail=` means the
 * refresh timer keeps the open panel open, the back button closes it, the idle
 * timer walks it home with everything else, and a panel can be linked to.
 *
 * IT COVERS THE BOARD RATHER THAN REPLACING IT. The board underneath is
 * rendered anyway (the page is one server render), and leaving it in place
 * means closing the panel is a paint rather than another round trip through a
 * dozen RPCs.
 *
 * EVERY PANEL IS AGGREGATES. Same rule as the board: this screen hangs on a
 * wall in a room with other people in it and is reachable with a shared token,
 * so no workspace names and no owner addresses, whatever the panel is about.
 */

import { Suspense } from 'react';
import Link from 'next/link';
import { KioskAlarm } from './KioskHealth';
import { kioskHref } from './kiosk-url';
import { KIOSK_DETAILS, type KioskDetailId } from './details/registry';
import type { KioskViewId } from './shared';
import { windowLabel } from './windows';

export function KioskMetricDetail({
  id,
  view,
  days,
  token,
}: {
  id: KioskDetailId;
  view: KioskViewId;
  days: number;
  token?: string;
}) {
  const entry = KIOSK_DETAILS[id];
  const Panel = entry.Panel;
  const close = kioskHref({ view, days, token });

  return (
    <section className="kiosk-detail" aria-label={`${entry.title} in detail`}>
      {/* The alarm again, not instead. This layer is fixed and covers the
          header it normally lives in, and an outage banner that a tapped tile
          can hide is worse than no banner: the whole point of it is that the
          board cannot look immaculate while the product is down. */}
      <KioskAlarm />
      <header className="kiosk-detail-head">
        <div className="kiosk-detail-title">
          <h2>{entry.title}</h2>
          <p>{entry.question}</p>
        </div>
        <span className="kiosk-detail-window">{entry.window === 'fixed' ? entry.fixedWindow : windowLabel(days)}</span>
        {/* A big target in the corner the thumb reaches, and a plain link so
            it works before any JavaScript has loaded. */}
        <Link href={close} className="kiosk-detail-close" prefetch={false} aria-label="Close detail">
          ✕
        </Link>
      </header>

      {/* Its own boundary: the board behind is already painted, so a panel that
          takes a second to gather its RPCs must not hold up anything else. */}
      <Suspense fallback={<div className="kiosk-detail-body"><p className="kiosk-empty">Loading…</p></div>}>
        <div className="kiosk-detail-body">
          <Panel days={days} />
        </div>
      </Suspense>
    </section>
  );
}
