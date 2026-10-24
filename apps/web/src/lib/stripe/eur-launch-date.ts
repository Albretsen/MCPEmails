/**
 * The EUR launch instant, on its own so a browser bundle can read it.
 *
 * WHY A SEPARATE FILE. eur-launch.ts reads the database (the launch flag) and
 * must never reach a client bundle. The marketing pages are static and
 * CDN-cached, so a page built before the launch would keep rendering USD for
 * everyone after it. The browser therefore re-reads the clock against this
 * constant and, once it has passed, asks /api/geo, which answers from the real
 * launch state (same idea as proPriceNoticeVisible in pro-price-change.ts).
 *
 * Pure: no imports.
 */

/**
 * 2026-12-07 00:00 in Oslo (CET, UTC+1). The first instant at which the
 * dispatcher may turn EUR prices, Stripe Tax and SEPA on. Owner decision
 * 2026-10-24 (Documents/plans/eur-prices-20261024.md, section 6). Never moved
 * earlier: the Black Week window (no price change between 2026-10-28 and
 * 2026-12-01) and the OSS registration both sit before it.
 */
export const EUR_LAUNCH_AT = '2026-12-06T23:00:00.000Z';

/** Whether the launch instant has come. An unparsable constant means never. */
export function eurLaunchDatePassed(now: number = Date.now(), launchAt: string = EUR_LAUNCH_AT): boolean {
  const at = Date.parse(launchAt);
  return Number.isFinite(at) && now >= at;
}

/**
 * The public.pricing_switches row that says the launch completed. Written only
 * by the dispatcher (eur-launch-run.ts), read by eur-launch.ts. Here, with no
 * imports, so both can name it without importing each other.
 */
export const EUR_LAUNCH_FLAG_KEY = 'eur_launch_live';
