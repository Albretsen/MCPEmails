/**
 * The reporting window, and the one place that knows what "all time" can
 * honestly mean.
 *
 * ADDED 2026-09-07. The board had a single hard-coded 28 day window, which is
 * the right default and was the wrong only option: standing in front of the
 * panel the two questions that actually get asked are "what happened this
 * week" and "what does the whole run look like", and neither is 28 days.
 *
 * THE 90 DAY CEILING IS NOT A UI DECISION. A pg_cron job deletes `activity_log`
 * rows past 90 days, so any series derived from activity (daily metrics, error
 * breakdowns, engagement bands, usage volume) simply has nothing older to
 * return. Asking those RPCs for 400 days would not fail: it would return real
 * workspace counts beside zeroed activity, and every rate computed against that
 * stretch would be an invention that looks like a collapse. So `activityDays`
 * clamps, and `windowLabel` prints what was actually measured rather than what
 * was asked for. A tile that says "90d" while the switch says "All" is telling
 * the truth about itself; the alternative is a board that quietly lies once a
 * quarter.
 *
 * Counts that come from durable columns (`workspaces.created_at`, the
 * `onboarding_*_at` timestamps, Stripe) have no such ceiling and get the full
 * window.
 */

import { DAILY_DAYS } from './shared';

export type KioskWindowId = '7' | '28' | '90' | 'all';

export type KioskWindow = {
  id: KioskWindowId;
  /** What the button says. Two or three characters, read from across a room. */
  label: string;
  /**
   * Days handed to the fetchers. "All" is 400: the product is younger than
   * that, and it is the same number the milestone funnel has always used for
   * the same reason.
   */
  days: number;
};

export const KIOSK_WINDOWS: KioskWindow[] = [
  { id: '7', label: '7d', days: 7 },
  { id: '28', label: '28d', days: 28 },
  { id: '90', label: '90d', days: 90 },
  { id: 'all', label: 'All', days: 400 },
];

/** The window the board opens on, and the one the idle timer returns to. */
export const DEFAULT_KIOSK_WINDOW: KioskWindowId = '28';

export const DEFAULT_KIOSK_WINDOW_DAYS = 28;

/**
 * An unknown or missing `?days=` resolves to the default rather than 404ing,
 * for the same reason an unknown `?view=` does: the panel's URL is typed by
 * hand once into a Chromium autostart line on a Pi with no keyboard, and a
 * typo there must leave a working board on the wall.
 *
 * Both the id ('all') and the day count ('90') are accepted, because the URL
 * is also typed by a person and "days=90" is what a person types.
 */
export function resolveKioskWindow(raw: string | undefined): KioskWindow {
  const match = KIOSK_WINDOWS.find((window) => window.id === raw || String(window.days) === raw);
  return match ?? KIOSK_WINDOWS.find((window) => window.id === DEFAULT_KIOSK_WINDOW)!;
}

/** The window as it should be spoken in a tile's aside. */
export function windowLabel(days: number): string {
  const match = KIOSK_WINDOWS.find((window) => window.days === days);
  if (match) return match.id === 'all' ? 'all time' : `last ${days} days`;
  return `last ${days} days`;
}

/** The same thing in the two or three characters a tile corner affords. */
export function windowShort(days: number): string {
  const match = KIOSK_WINDOWS.find((window) => window.days === days);
  return match ? match.label : `${days}d`;
}

/**
 * The window an activity-derived series can actually answer for.
 *
 * See the header: past 90 days there are no rows, so this is the difference
 * between a short window and a fabricated one.
 */
export function activityDays(days: number): number {
  return Math.min(days, DAILY_DAYS);
}

/** True when the switch is asking for more history than activity data holds. */
export function isActivityCapped(days: number): boolean {
  return days > DAILY_DAYS;
}

/**
 * The window the PEOPLE counts can answer for, which is a different ceiling.
 *
 * `growth_people_counts` reports the window and the window before it in one
 * row, so it looks back twice and `fetchPeopleCounts` clamps its argument at 45
 * days for the 90 day purge to hold for both halves. It clamps SILENTLY, which
 * is right for the RPC and wrong for a tile: asked for 400 days it answers for
 * 45 and says nothing, so a tile printing the switch's label over that number
 * would attribute six weeks of signups to the whole run. Anything rendering a
 * people count labels it with this instead.
 */
export const PEOPLE_MAX_DAYS = 45;

export function peopleDays(days: number): number {
  return Math.min(days, PEOPLE_MAX_DAYS);
}

export function isPeopleCapped(days: number): boolean {
  return days > PEOPLE_MAX_DAYS;
}
