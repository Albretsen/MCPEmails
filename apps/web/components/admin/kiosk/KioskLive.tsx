'use client';

/**
 * The only JavaScript on the kiosk board.
 *
 * It does five things, all of them consequences of the screen being
 * unattended for weeks at a time.
 *
 * 1. IT PINS THE THEME. The root layout restores `mcpe-theme` from
 *    localStorage and defaults to light. A wall panel in a room is unreadable
 *    in light and glares at night, and the kiosk profile has no way to press a
 *    theme toggle, so this forces dark on mount without writing to
 *    localStorage (writing it would silently change the operator's own theme
 *    the next time they opened the dashboard in the same browser).
 *
 * 2. IT REFRESHES THE NUMBERS. `router.refresh()` re-renders the server
 *    components in place: no white flash, no scroll jump, and the previous
 *    frame stays up if the request fails. The data behind it is cached for ten
 *    minutes, so a five minute tick costs at most one round trip and usually
 *    costs nothing at all.
 *
 * 3. IT RELOADS ITSELF WHEN THE SITE IS DEPLOYED. On the same tick it asks
 *    production which build production is running, and hard reloads when that
 *    is no longer the build this tab booted with. This is the part that was
 *    missing on 2026-08-29: the money tiles shipped and the panel on the wall
 *    kept showing the previous board, because `router.refresh()` re-renders
 *    server components into a client that is still running yesterday's
 *    bundle. A wall display cannot be asked to notice this itself; nobody is
 *    looking at it, and being a day stale while looking perfectly healthy is
 *    the worst failure this screen has.
 *
 * 4. IT WALKS THE BOARD HOME. Since 2026-09-01 the panel has a five-way view
 *    switch, and a view is a URL. Somebody who walks over, taps Money, reads
 *    it and walks away has left the wall answering a question nobody in the
 *    room is asking any more, and there is no one to put it back. Ten minutes
 *    without a touch and the board returns to the default view on its own.
 *    Only ever a NAVIGATION HOME, never away from home: on the default view
 *    this timer does nothing at all, so the resting behaviour of an unattended
 *    board is exactly what it was before the switch existed.
 *
 * 5. IT RELOADS THE PAGE ONCE A DAY REGARDLESS. A Chromium tab left running
 *    for a month accumulates enough to be worth resetting, and it is the
 *    backstop for the deploy check above ever failing quietly. Doing it at a
 *    fixed interval from load, rather than at a wall-clock hour, avoids every
 *    kiosk in the world reloading on the same second if this is ever run on
 *    more than one.
 *
 * The clock is rendered here rather than on the server because a
 * server-rendered time would freeze at whatever moment the page last
 * re-rendered, and a stopped clock on a wall display is worse than no clock:
 * it makes fresh numbers look stale.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const REFRESH_MS = 5 * 60 * 1000;
const HARD_RELOAD_MS = 24 * 60 * 60 * 1000;

/**
 * How long a non-default view stays up without being touched.
 *
 * Ten minutes: long enough to read a board, walk away to check something and
 * come back, and short enough that the wall is never showing yesterday's
 * question by the time the next person walks past.
 */
const IDLE_HOME_MS = 10 * 60 * 1000;

export function KioskLive({
  generatedAt,
  deployment,
  view,
  token,
}: {
  generatedAt: string;
  /** The build this page was rendered by. See app/api/kiosk/version. */
  deployment: string;
  /** Which board is on screen. Only used to decide whether to walk home. */
  view?: string;
  /**
   * The `?k=` bootstrap token, when this request carried one.
   *
   * Carried into the walk-home URL for the same reason KioskViewSwitch carries
   * it into the view links: the proxy strips `?k=` the moment the browser
   * proves it kept the kiosk cookie, so a page that still has the token is by
   * construction a browser whose cookie is not working, and navigating it to a
   * bare URL would strand the panel on a 404 nobody is present to dismiss.
   */
  token?: string;
}) {
  const router = useRouter();
  const [now, setNow] = useState<Date | null>(null);

  // Null until mounted so the server and the first client render agree.
  // Rendering a real time on the server would hydrate against a different
  // string a second later and throw a mismatch on every single load.
  useEffect(() => {
    // Mount-only by design: `now` stays null through SSR and the first client render so the two
    // agree, per the comment above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(new Date());
    const tick = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'dark');
    return () => {
      if (previous) root.setAttribute('data-theme', previous);
    };
  }, []);

  useEffect(() => {
    // No query string, deliberately. This used to forward the page's own
    // `?k=` to the version route, which meant the shared secret was written
    // into an access log every five minutes forever. Since 2026-08-30 the
    // token is exchanged once at the door for an HttpOnly cookie scoped to
    // this route and the board's (see src/lib/admin/kiosk-cookie.ts, audit
    // finding F-06), so the fetch below carries the credential in a header the
    // browser attaches itself and nothing has to be pasted into the URL. An
    // operator viewing the board on a real session is authorised by that
    // session here exactly as they are for the page, same as before.
    async function tick() {
      try {
        const response = await fetch('/api/kiosk/version', { cache: 'no-store' });
        if (response.ok) {
          const { deployment: live } = (await response.json()) as { deployment?: string };
          // Reload, not refresh: a new bundle is the one thing a soft refresh
          // cannot pick up, which is the whole reason this check exists.
          if (live && live !== deployment) {
            window.location.reload();
            return;
          }
        }
      } catch {
        // Offline, or production is mid-deploy and briefly unreachable. Fall
        // through to the soft refresh: the previous frame stays on the wall
        // and the next tick tries again. A network blip must never blank the
        // board or put it into a reload loop.
      }
      router.refresh();
    }

    const soft = setInterval(tick, REFRESH_MS);
    const hard = setTimeout(() => window.location.reload(), HARD_RELOAD_MS);
    return () => {
      clearInterval(soft);
      clearTimeout(hard);
    };
  }, [router, deployment]);

  // Walks the board home. Deliberately not wired to `router.refresh()`'s tick:
  // a refresh is not evidence anybody is present, and folding the two together
  // would either reset the idle clock every five minutes (so the board never
  // goes home) or make the timing depend on where in the refresh cycle the tap
  // landed.
  useEffect(() => {
    if (!view || view === 'pulse') return;

    let timer: ReturnType<typeof setTimeout>;
    const home = token
      ? `/admin/growth/kiosk?k=${encodeURIComponent(token)}`
      : '/admin/growth/kiosk';
    const goHome = () => router.push(home);
    const restart = () => {
      clearTimeout(timer);
      timer = setTimeout(goHome, IDLE_HOME_MS);
    };

    restart();
    // Pointer events rather than click: on the touchscreen a scroll down to the
    // supporting detail is somebody reading, and it must count as presence even
    // though it never becomes a click. Passive, so none of this can delay a
    // scroll on a Pi 4.
    const options = { passive: true } as const;
    window.addEventListener('pointerdown', restart, options);
    window.addEventListener('touchstart', restart, options);
    window.addEventListener('scroll', restart, options);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', restart);
      window.removeEventListener('touchstart', restart);
      window.removeEventListener('scroll', restart);
    };
  }, [router, view, token]);

  return (
    <div className="kiosk-head-right">
      <span className="kiosk-clock">{now ? TIME.format(now) : ' '}</span>
      <span>{now ? DATE.format(now) : ' '}</span>
      {/* Also gated on `now`: the server renders in UTC and the panel is on
          Europe/Oslo, so formatting this during SSR would hydrate against a
          different string and throw on every load. */}
      <span className="kiosk-live">{now ? `updated ${TIME.format(new Date(generatedAt))}` : 'live'}</span>
    </div>
  );
}

const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const DATE = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
