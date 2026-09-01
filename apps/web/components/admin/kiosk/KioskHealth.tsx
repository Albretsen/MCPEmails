'use client';

/**
 * The one thing on this board that is allowed to shout.
 *
 * Everything else here reports on a business that moves in weeks. This
 * reports on a product that can stop working in a second, and it is the
 * reason the board is worth hanging on a wall rather than bookmarking: an
 * operator who walks past should learn that the endpoint is down without
 * having asked, and should not be able to walk past without learning it.
 *
 * THREE PIECES, ONE POLL. The provider holds the snapshot and paints the room:
 * a banner across the top, a tile in the supporting strip, and a state class on
 * the board root that tints the whole screen. They are one component tree
 * rather than three so they cannot disagree, which on a display like this is a
 * real risk rather than a theoretical one: a green tile under a red banner
 * would leave whoever is standing in front of it with no idea which to believe.
 *
 * WHY IT POLLS ON ITS OWN CLOCK. The board refreshes every five minutes and
 * its numbers are cached for ten, both of which are right for growth metrics
 * and both of which are wrong for an outage. This asks a dedicated uncached
 * endpoint every 45 seconds, so the worst case between the synthetic monitor
 * recording a failed check and the wall turning red is one poll.
 *
 * A FAILED POLL IS ITSELF A SIGNAL, and it is the signal the board has never
 * had. If `fetch` cannot reach production, either the site is down or the Pi
 * has lost its network, and until now both looked identical from the room: a
 * board full of numbers, refreshing into nothing, pulsing a green dot. One
 * failure is ignored, because a five minute deploy window or a wifi hiccup
 * must not paint the wall amber. Two in a row (about a minute and a half) says
 * so in words.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { HealthLevel, SystemHealth } from '@/lib/analytics/health-math';
import { NO_DATA, formatCount, formatPercent } from '../charts/format';
import { BigNumber, FactRow, Tile } from './primitives';

/** How often the board asks. See the module note on why this is not the board's own tick. */
const POLL_MS = 45_000;

/**
 * Consecutive failed polls before the board says it cannot reach the site.
 *
 * Two, not one. A production deploy briefly refuses connections and the panel
 * is on office wifi; a single miss is noise. Two misses is 90 seconds, which
 * is short enough to be useful and long enough to have never been a blip.
 */
const UNREACHABLE_AFTER = 2;

/**
 * When a snapshot is old enough to stop being evidence.
 *
 * Reached only if the polling loop itself has stopped (a suspended tab, a
 * wedged renderer) while the page carries on displaying. The numbers on the
 * board can be five minutes old by design; a health verdict that old is not a
 * verdict, so the board stops presenting it as one.
 */
const SNAPSHOT_STALE_MS = 4 * POLL_MS;

const HealthContext = createContext<SystemHealth | null>(null);

/**
 * Wraps the whole kiosk and owns the poll.
 *
 * It renders the board's root element itself rather than sitting inside it, so
 * the alarm state can be a class on that root: the tint, the border and the
 * live dot's colour are then one CSS rule each instead of three components
 * each deciding for themselves what red means.
 */
export function KioskHealthProvider({
  initial,
  children,
}: {
  /** Server-rendered snapshot, so a hard reload never shows an unjudged board. */
  initial: SystemHealth;
  children: ReactNode;
}) {
  const [health, setHealth] = useState<SystemHealth>(initial);
  const [failures, setFailures] = useState(0);
  // Ticks alongside the poll purely so the "checked N min ago" line and the
  // staleness check below re-evaluate on a clock rather than only when a
  // fetch happens to succeed.
  const [now, setNow] = useState(() => Date.parse(initial.checkedAt) || Date.now());

  useEffect(() => {
    let cancelled = false;

    // The credential goes wherever the page's own credential already is.
    //
    // Today that is `?k=` in this page's query string, which is how the board
    // on the wall is authenticated, so the poll has to carry it or every tick
    // 404s and the panel sits permanently on NO CONTACT. Reusing the search
    // string verbatim rather than reading the token also means an operator
    // viewing the board on a real admin session (no `?k=` anywhere) is
    // authorised here by that session, exactly as they are for the page.
    //
    // It is written this way so it survives the kiosk cookie work landing
    // without needing to change: under that scheme the board's URL carries no
    // `k` at all, this sends an empty search, and the browser attaches the
    // HttpOnly cookie itself. Same line, both doors. It is the same approach
    // KioskLive uses for the deploy-version poll beside it.
    const search = window.location.search;

    async function poll() {
      try {
        const response = await fetch(`/api/kiosk/health${search}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const snapshot = (await response.json()) as SystemHealth;
        if (cancelled) return;
        setHealth(snapshot);
        setFailures(0);
      } catch {
        // Deliberately swallowed. The count is the signal; the message is
        // always some variant of "failed to fetch" and says nothing useful.
        if (!cancelled) setFailures((count) => count + 1);
      } finally {
        if (!cancelled) setNow(Date.now());
      }
    }

    // Not called immediately: the server already handed us a fresh snapshot,
    // and polling on mount would double every reload for nothing.
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const effective = useMemo(
    () => degrade(health, failures, now),
    [health, failures, now],
  );

  return (
    <HealthContext.Provider value={effective}>
      <div className={`kiosk is-health-${effective.level}`}>{children}</div>
    </HealthContext.Provider>
  );
}

/**
 * The snapshot the room should act on, which is not always the one the server
 * sent.
 *
 * Two things can be true of a perfectly good snapshot: we can have failed to
 * refresh it, and it can have aged out. Both mean the board no longer knows,
 * and both have to outrank a cheerful verdict from several minutes ago. They
 * do not outrank a BAD verdict: if the last thing we heard was that the
 * endpoint is down, losing contact is not evidence that it recovered.
 */
function degrade(health: SystemHealth, failures: number, now: number): SystemHealth {
  if (health.level === 'down') return health;

  if (failures >= UNREACHABLE_AFTER) {
    return {
      ...health,
      level: 'unknown',
      headline: 'NO CONTACT',
      reason: `This board has not reached mcpemails.com for ${failures} checks. The site or this panel's network is down.`,
      since: health.checkedAt,
    };
  }

  const age = now - (Date.parse(health.checkedAt) || 0);
  if (age > SNAPSHOT_STALE_MS) {
    return {
      ...health,
      level: 'unknown',
      headline: 'STALE',
      reason: `The last health check was ${Math.round(age / 60_000)} minutes ago. This board has stopped checking.`,
      since: health.checkedAt,
    };
  }

  return health;
}

function useHealth(): SystemHealth | null {
  return useContext(HealthContext);
}

/* --------------------------------------------------------------- the banner */

/**
 * The band across the top of the board.
 *
 * Renders NOTHING when everything is fine, which is the whole design. A
 * permanent green "all systems operational" bar is read once, on the day it
 * ships, and never again; a bar that only ever appears when something is wrong
 * is still being read a year later. The cost is that the healthy case has no
 * visible proof of life, which is why the pulsing dot in the header exists and
 * why the tile below carries the standing number.
 *
 * It sits inside the header rather than in its own grid row so its appearance
 * cannot reflow the four-row board: the header row is `auto`, and everything
 * below it is a fraction of what is left.
 */
export function KioskAlarm() {
  const health = useHealth();
  if (!health || health.level === 'ok') return null;

  const since = health.since ? sinceLabel(health.since) : null;

  return (
    <div className={`kiosk-alarm is-${health.level}`} role="status" aria-live="polite">
      <strong className="kiosk-alarm-headline">{health.headline}</strong>
      <span className="kiosk-alarm-reason">{health.reason}</span>
      {since && <span className="kiosk-alarm-since">{since}</span>}
    </div>
  );
}

/** "since 11:20" when it is today, "for 3 days" once that stops being useful. */
function sinceLabel(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) return `since ${CLOCK.format(new Date(then))}`;
  return `for ${Math.floor(minutes / (60 * 24))} days`;
}

const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/* ----------------------------------------------------------------- the tile */

/**
 * The standing reliability readout in the supporting strip.
 *
 * It replaced a tile that showed one number: successes over calls across 28
 * days. That number is a fine summary of a quarter and completely useless as
 * an alarm, because 28 days of history cannot move: an endpoint that has been
 * dead all morning still reads 99% on it, and the tile went on saying so in
 * calm grey while nothing worked. It is kept here, in the fact row, where a
 * long-run baseline belongs, and the headline is the last hour instead.
 *
 * THE MONITOR LINE IS THE CAPTION, not a second tile. The two witnesses only
 * mean something together: a green rate with a failing monitor is a product
 * whose four core paths are broken while its noisy ones still answer, and a
 * red rate with a passing monitor is a regression the monitor's four steps
 * happen not to cover. Whoever walks over needs both in one glance.
 */
export function KioskHealthTile({
  /** Successes over calls across the board's own 28 day window, as a fraction. */
  baselineRate,
  baselineDays,
}: {
  baselineRate: number | null;
  baselineDays: number;
}) {
  const health = useHealth();
  if (!health) return null;

  const live = rateOf(health.live.successes, health.live.calls);
  const day = rateOf(health.day.successes, health.day.calls);
  const headline = live ?? day;
  const window = live !== null ? '/60m' : day !== null ? '/24h' : undefined;

  return (
    <Tile
      label="Live reliability"
      aside={asideFor(health)}
      span={3}
      className="kiosk-strip"
      tone={toneFor(health.level)}
    >
      <BigNumber
        value={headline === null ? NO_DATA : formatPercent(headline, 1)}
        suffix={window}
        caption={<>{captionFor(health)}</>}
      />
      {/*
        The fact row stays raw on purpose, including on a window where one
        workspace owned the failures. Twenty calls did fail, and a board that
        quietly nets somebody out of its own counts is a board whose numbers
        cannot be checked against the database by the person standing in front
        of it. The attribution belongs in the caption, in words, where it can
        say WHOSE failures they were instead of hiding them.
      */}
      <FactRow
        facts={[
          { label: 'Calls 60m', value: formatCount(health.live.calls) },
          { label: 'Failed 60m', value: formatCount(health.live.errors) },
          {
            label: `${baselineDays}d`,
            value: baselineRate === null ? NO_DATA : formatPercent(baselineRate, 1),
          },
        ]}
      />
    </Tile>
  );
}

/** Rate, or null when there is nothing to divide. */
function rateOf(successes: number, calls: number): number | null {
  return calls > 0 ? successes / calls : null;
}

function toneFor(level: HealthLevel): 'good' | 'warn' | 'bad' {
  if (level === 'down') return 'bad';
  if (level === 'ok') return 'good';
  return 'warn';
}

/**
 * The tile's aside, which is a state word rather than a window label.
 *
 * The window is already on the headline as a suffix, and the three characters
 * of space in a tile three of twelve columns wide are better spent saying
 * whether the synthetic monitor is happy. Kept to one or two words: the aside
 * is `white-space: nowrap` and a longer phrase eats the tile's own label.
 */
function asideFor(health: SystemHealth): string {
  if (health.level === 'down') return 'DOWN';
  if (health.level === 'unknown') return 'no signal';
  if (health.level === 'degraded') return 'degraded';
  return 'healthy';
}

/**
 * The line under the number: what the monitor thinks, and when the number
 * needs defending.
 *
 * The second sentence appears only on a window the classifier held back
 * because one workspace owned the failures, and it is not decoration. Without
 * it the tile shows something like 91.6% in calm green over "Failed 60m 20",
 * and the two do not add up in the head of anyone who stops to look. Left
 * unexplained that reads as a broken tile, which costs the board its
 * credibility just as surely as a false amber would. So the tile says whose
 * failures they were, in the same breath as the number.
 *
 * The judgement is not made here. `health.concentration` is set by the
 * classifier or it is not, and this only puts words to it.
 */
function captionFor(health: SystemHealth) {
  const held = health.concentration;
  return (
    <>
      {monitorCaption(health)}
      {held ? ` ${held.worstWorkspaceErrors} of ${health.live.errors} failures are one workspace, not the product.` : null}
    </>
  );
}

/**
 * One line saying what the monitor thinks, and how long ago it thought it.
 *
 * The age matters as much as the verdict. "Checks green" is worth nothing
 * without "2 min ago" beside it, because the failure this board is most likely
 * to have is not an outage, it is a monitor that quietly stopped running and
 * left a stale green on the wall.
 */
function monitorCaption(health: SystemHealth) {
  const { monitor } = health;
  if (!monitor.lastRunAt) return 'The synthetic monitor has never reported.';

  const age = agoLabel(monitor.lastRunAt);
  if (monitor.lastStatus !== 'succeeded') {
    return (
      <>
        <strong>Synthetic check failing</strong> at {monitor.failedStep ?? 'an unknown step'}, {age}.
      </>
    );
  }
  const seconds = monitor.medianDurationMs === null ? null : (monitor.medianDurationMs / 1000).toFixed(1);
  return (
    <>
      <strong>All 4 synthetic checks green</strong> {age}
      {seconds ? `, ${seconds}s a run` : ''}.
    </>
  );
}

/** "2 min ago", "3 hours ago". Whole units only: this is read at a glance. */
function agoLabel(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'at an unknown time';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}
