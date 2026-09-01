/**
 * The five-way view switch in the kiosk header.
 *
 * A SERVER COMPONENT, and links rather than buttons. The board ships almost no
 * JavaScript on purpose, and a view here is a URL: a refresh, a deploy reload,
 * a bookmark and a walk-past all land somewhere defined, and the panel's own
 * five-minute `router.refresh()` keeps refreshing whatever view is on screen
 * without this component having to know that it exists. Client state would
 * have made the view invisible to every one of those.
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

import Link from 'next/link';
import { KIOSK_VIEWS, type KioskViewId } from './shared';

export function KioskViewSwitch({
  current,
  token,
}: {
  current: KioskViewId;
  /** The `?k=` bootstrap token, when this request carried one. See above. */
  token?: string;
}) {
  return (
    <nav className="kiosk-views" aria-label="Board view">
      {KIOSK_VIEWS.map((view) => {
        const active = view.id === current;
        const params = new URLSearchParams();
        // The default view is the bare URL. It is what the Pi's autostart line
        // points at and what the idle timer returns to, so it must not depend
        // on a query string being spelled correctly.
        if (view.id !== 'pulse') params.set('view', view.id);
        if (token) params.set('k', token);
        const query = params.toString();
        return (
          <Link
            key={view.id}
            href={query ? `/admin/growth/kiosk?${query}` : '/admin/growth/kiosk'}
            className={`kiosk-view${active ? ' is-active' : ''}`}
            prefetch={false}
            aria-current={active ? 'page' : undefined}
          >
            {view.label}
          </Link>
        );
      })}
    </nav>
  );
}
