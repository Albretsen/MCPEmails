/**
 * The announced Pro price change: $15 -> $19 a month ($144 -> $182.40 a year)
 * for NEW subscriptions, with the current price kept by everyone subscribed
 * before the switch, for as long as their subscription stays active.
 *
 * TWO SWITCHES, BOTH CONSTANTS. priceLive is ON since the 2026-12-08 cutover.
 *
 *   priceLive  Pro sells the `STRIPE_PRICE_SOLO_*_V2` prices at the NEXT
 *              amounts, and the current pair becomes Pro's legacy pair. Flipped
 *              by the cutover PR, in the same commit as every sentence that
 *              quotes the price (personal-price-copy.test.ts fails on any copy
 *              that still quotes $15), so the checkout amount and the copy can
 *              only ever move together, in one deploy.
 *   announce   Shows the dated notice on /pricing and on the dashboard's Pro
 *              upgrade surfaces. Turned on by its own one-line PR on the
 *              announcement date, so each switch reverts alone.
 *
 * Why constants and not a `pricing_switches` row: /pricing is statically
 * generated and CDN-cached, and about 190 sentences carry the price as text
 * (translations, blog posts, README, llms.txt). A database flag could move the
 * checkout amount but not the copy.
 *
 * THE DEADLINE IS KEPT, NEVER EXTENDED. The notice is visible only while
 * `announce` is on, `priceLive` is off and the switch instant has not passed.
 * A late cutover therefore takes the notice down rather than leaving a passed
 * date on screen, and nothing can quietly roll the date forward: moving
 * `switchAt` later after announcing is the fake deadline this exists to avoid.
 *
 * Pure: no imports, so plans.ts can read it in client and build contexts.
 */

export interface ProPriceAmounts {
  monthlyCents: number;
  yearlyCents: number;
}

export const PRO_PRICE_CHANGE = {
  /** SWITCH 1. Sell the new price. On since the cutover PR (2026-12-08). */
  priceLive: true,
  /** SWITCH 2. Show the dated notice. Off until the announcement PR. */
  announce: false,
  /**
   * First instant at which new subscriptions pay the new price: 2026-12-08
   * 00:00 in Oslo (CET, UTC+1). The notice disappears at this instant whatever
   * the switches say.
   */
  switchAt: '2026-12-07T23:00:00.000Z',
  /** The last day, in Oslo, that the current price can be locked in. */
  lastLockInDate: '2026-12-07',
  /** The first day of the new price, in Oslo. */
  switchDate: '2026-12-08',
  /** $15 / $144: what Pro sold before the cutover and what every earlier subscriber keeps. */
  current: { monthlyCents: 1500, yearlyCents: 14400 } as ProPriceAmounts,
  /** $19 / $182.40: 12 x $19 less exactly the 20% every annual price carries. */
  next: { monthlyCents: 1900, yearlyCents: 18240 } as ProPriceAmounts,
} as const;

/** The amounts Pro is sold at right now, by the price switch. */
export function proSoldAmounts(
  change: { priceLive: boolean; current: ProPriceAmounts; next: ProPriceAmounts } = PRO_PRICE_CHANGE,
): ProPriceAmounts {
  return change.priceLive ? change.next : change.current;
}

/**
 * Whether the dated notice may be shown at `now`. Every surface that renders
 * the notice asks this, on the server and again in the browser, so a page
 * cached before the switch instant stops showing it once the instant passes.
 */
export function proPriceNoticeVisible(
  now: number = Date.now(),
  change: { announce: boolean; priceLive: boolean; switchAt: string } = PRO_PRICE_CHANGE,
): boolean {
  if (!change.announce || change.priceLive) return false;
  const switchAt = Date.parse(change.switchAt);
  if (!Number.isFinite(switchAt)) return false;
  return now < switchAt;
}

/** Whole dollars as "$19", cents as "$182.40". English-format, for email. */
export function formatUsdCents(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}
