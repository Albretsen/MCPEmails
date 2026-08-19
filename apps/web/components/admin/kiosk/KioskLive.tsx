'use client';

/**
 * The only JavaScript on the kiosk board.
 *
 * It does three things, all of them consequences of the screen being
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
 * 3. IT RELOADS THE PAGE ONCE A DAY. A soft refresh cannot recover from a
 *    stale bundle after a deploy, and a Chromium tab left running for a month
 *    accumulates enough to be worth resetting. Doing it at a fixed interval
 *    from load, rather than at a wall-clock hour, avoids every kiosk in the
 *    world reloading on the same second if this is ever run on more than one.
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

export function KioskLive({ generatedAt }: { generatedAt: string }) {
  const router = useRouter();
  const [now, setNow] = useState<Date | null>(null);

  // Null until mounted so the server and the first client render agree.
  // Rendering a real time on the server would hydrate against a different
  // string a second later and throw a mismatch on every single load.
  useEffect(() => {
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
    const soft = setInterval(() => router.refresh(), REFRESH_MS);
    const hard = setTimeout(() => window.location.reload(), HARD_RELOAD_MS);
    return () => {
      clearInterval(soft);
      clearTimeout(hard);
    };
  }, [router]);

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
