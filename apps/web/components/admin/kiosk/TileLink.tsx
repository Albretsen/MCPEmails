/**
 * The invisible hit area that turns a tile into a touch target.
 *
 * WHY AN OVERLAY LINK rather than wrapping each tile's contents in an anchor.
 * The tiles are flex columns whose children measure themselves against the
 * tile's own height (see `.kiosk-big`, `.kiosk-spark`); putting an `<a>` in
 * between adds a box that does not participate in that sizing and every
 * headline on the board shifts. A stretched link over `position: relative` on
 * the tile leaves the layout untouched and gives the whole tile, not just its
 * label, to the finger. Ten inches of panel and a thumb is the only pointer
 * this display has ever seen.
 *
 * WHY IT IS A CLIENT COMPONENT, for one `<Link>`. The destination has to carry
 * the view, the window and (when the cookie is not working) the bootstrap
 * token that the current request came in with, and threading all three down to
 * every tile on five boards is the kind of plumbing that gets one tile wrong
 * and sends the operator to a detail panel for a different window than the
 * tile they tapped. Reading them off the URL that is already in the address bar
 * cannot drift.
 *
 * `aria-label` rather than visible text: the tile's own `<h2>` is right there,
 * and a screen reader announcing "Active users, link" twice is worse than once.
 */

'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { KIOSK_PATH } from './kiosk-url';

export function TileLink({ detail, label }: { detail: string; label: string }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const [pressed, setPressed] = useState(false);

  // Everything the current URL carries, plus the panel to open. Built from the
  // live search params so `view`, `days` and `k` survive without being passed
  // through five boards.
  const next = new URLSearchParams(params?.toString() ?? '');
  next.set('detail', detail);

  return (
    <Link
      // `pathname` rather than the constant when they agree, so a future
      // mount of the board under another path still links to itself.
      href={`${pathname || KIOSK_PATH}?${next.toString()}`}
      className={`kiosk-tile-hit${pressed ? ' is-pressed' : ''}`}
      prefetch={false}
      aria-label={`${label} in detail`}
      // The panel behind this is a server render of several RPCs, so the tile
      // has to answer the finger itself. Pointer events, not `:active`, because
      // Chromium drops `:active` the moment the touch starts to move.
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
    >
      <span className="kiosk-tile-hint" aria-hidden="true" />
    </Link>
  );
}
