/**
 * The five-way view switch in the kiosk header.
 *
 * LINKS, NOT CLIENT STATE. The board ships almost no JavaScript on purpose and
 * a view here is a URL: a refresh, a deploy reload, a bookmark and a walk-past
 * all land somewhere defined, and the panel's own five-minute
 * `router.refresh()` keeps refreshing whatever view is on screen without this
 * component having to know that it exists.
 *
 * WHY IT IS NEVERTHELESS A CLIENT COMPONENT, since 2026-09-07. Switching view
 * is a full server render of a dozen cached RPCs and a Stripe call, so one to
 * two seconds pass between the finger landing and the new board painting. With
 * nothing moving in that gap the tap reads as ignored, and an ignored tap on a
 * touchscreen gets repeated: the operator pressed Money three times and got
 * three renders. So the tapped pill lights up on `pointerdown`, before
 * navigation has even started, and the pending flag clears itself when the
 * server sends back a board whose `current` is the view that was asked for.
 * The links, the URLs and the no-JavaScript-in-the-board rule are all
 * untouched; this adds a few hundred bytes and one piece of state.
 *
 * WHY THE TOKEN IS FORWARDED WHEN IT IS PRESENT, given that the whole point of
 * the 2026-08-30 cookie work (finding F-06) was to get `KIOSK_TOKEN` out of
 * URLs. Because the proxy strips `?k=` from the address bar the moment the
 * browser proves it kept the kiosk cookie, a request that still carries the
 * token is, by construction, a browser whose cookie is not working: a locked
 * down profile, cookies cleared on exit, a policy nobody remembers setting.
 * Dropping the token from these links in that state would give the panel five
 * buttons that all lead to a 404 nobody is present to dismiss. So the token
 * rides along exactly and only in the case where it is the sole credential the
 * display has, which is the same trade `kioskUrlRedirect` already makes.
 *
 * NO PREFETCH. Next would otherwise prefetch all five boards as they scroll
 * into view, which on this page means five full server renders, each firing a
 * dozen cached RPCs and a Stripe call, on a display where nobody has pressed
 * anything. The switch is touched a handful of times a week; paying for the
 * render at the moment of the tap is obviously right here.
 */

'use client';

import Link from 'next/link';
import { useState } from 'react';
import { kioskHref } from './kiosk-url';
import { KIOSK_VIEWS, type KioskViewId } from './shared';

export function KioskViewSwitch({
  current,
  token,
  days,
}: {
  current: KioskViewId;
  /** The `?k=` bootstrap token, when this request carried one. See above. */
  token?: string;
  /** The window in force, carried across a view change. */
  days: number;
}) {
  // The tap remembers which board it was made FROM, which is what lets the
  // pending state expire without an effect: the moment the server sends back a
  // different `current`, the stored `from` no longer matches and the pill stops
  // being painted as pending. No cleanup, no cascading render, and it covers
  // the case nobody thinks about (the five-minute refresh landing mid
  // navigation) for free.
  const [pending, setPending] = useState<{ from: KioskViewId; to: KioskViewId } | null>(null);
  const waitingFor = pending && pending.from === current ? pending.to : null;

  return (
    <nav className="kiosk-views" aria-label="Board view">
      {KIOSK_VIEWS.map((view) => {
        const active = view.id === current;
        // A tap on the view already showing is not pending anything.
        const waiting = waitingFor === view.id && !active;
        return (
          <Link
            key={view.id}
            href={kioskHref({ view: view.id, days, token })}
            className={`kiosk-view${active ? ' is-active' : ''}${waiting ? ' is-pending' : ''}`}
            prefetch={false}
            aria-current={active ? 'page' : undefined}
            // pointerdown, not click: on a touchscreen the click event does not
            // fire until the finger lifts, which is most of the delay this is
            // here to cover.
            onPointerDown={() => setPending({ from: current, to: view.id })}
          >
            {view.label}
          </Link>
        );
      })}
    </nav>
  );
}
