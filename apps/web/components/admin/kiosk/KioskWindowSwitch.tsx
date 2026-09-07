/**
 * The reporting-window switch in the kiosk header.
 *
 * WHY A SECOND CONTROL ON A BOARD THAT ARGUED FOR NONE. The five views answer
 * five different questions; this answers a different question about all of
 * them, and it is the one actually asked out loud in front of the panel. "Are
 * we up" means this week. "Is it working" means the whole run. A single 28 day
 * window answered neither and quietly reframed every tile as though it had.
 *
 * The default is still 28 days, the panel returns to it on its own with
 * everything else after ten idle minutes, and left alone this is still a board
 * with nothing pressed. Same trade as the view switch, and the same mechanics:
 * links, not client state, so the window survives a refresh and a deploy
 * reload, plus an optimistic pressed state so the tap is answered before the
 * server render lands.
 *
 * WHAT THE SWITCH CANNOT DO, and why the tiles rather than this strip say so:
 * `activity_log` rows are deleted at 90 days, so "All" gives every count drawn
 * from durable columns its true all-time value and gives the activity-derived
 * series exactly 90 days. The honest place to admit that is on the tile whose
 * number it changes, so the tiles print the window they actually got. See
 * windows.ts.
 */

'use client';

import Link from 'next/link';
import { useState } from 'react';
import { kioskHref } from './kiosk-url';
import type { KioskViewId } from './shared';
import { KIOSK_WINDOWS, type KioskWindowId } from './windows';

export function KioskWindowSwitch({
  view,
  days,
  token,
}: {
  view: KioskViewId;
  days: number;
  token?: string;
}) {
  // Pending state that expires by itself: the tap records the window it was
  // made from, so a new `days` from the server stops matching and the pill
  // stops waiting. Same idiom as the view switch, and for the same reason.
  const [pending, setPending] = useState<{ from: number; to: KioskWindowId } | null>(null);
  const waitingFor = pending && pending.from === days ? pending.to : null;

  return (
    <nav className="kiosk-windows" aria-label="Reporting window">
      {KIOSK_WINDOWS.map((window) => {
        const active = window.days === days;
        const waiting = waitingFor === window.id && !active;
        return (
          <Link
            key={window.id}
            href={kioskHref({ view, days: window.days, token })}
            className={`kiosk-window${active ? ' is-active' : ''}${waiting ? ' is-pending' : ''}`}
            prefetch={false}
            aria-current={active ? 'page' : undefined}
            onPointerDown={() => setPending({ from: days, to: window.id })}
          >
            {window.label}
          </Link>
        );
      })}
    </nav>
  );
}
