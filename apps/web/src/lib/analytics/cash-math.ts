/**
 * Cash arithmetic, kept free of every framework import.
 *
 * `operator-revenue.ts` reaches Stripe and `growth-queries.ts` for its cache
 * helper, which drags in `next/cache`, so nothing in it can be loaded by a
 * plain `node --test` run. These two functions carry the only rules worth
 * pinning down with a test, so they live here instead: same split as
 * revenue-math.ts against kiosk-revenue.ts, and growth-metrics.ts against
 * growth-queries.ts.
 */

/** Cash that actually arrived in one UTC month, net of refunds. */
export type CashMonth = {
  /** First day of the month, `YYYY-MM-DD`. */
  month: string;
  grossMinor: number;
  refundedMinor: number;
  netMinor: number;
};

/**
 * Roll charges into UTC months.
 *
 * Charges, not invoices, because the question is "how much money arrived" and
 * an invoice can be settled from a credit balance that moved none. A refund is
 * subtracted from the month the CHARGE landed in rather than the month the
 * refund happened: the alternative makes the earning month look whole and a
 * later month look like it lost money, which is backwards for reading a trend.
 */
export function rollUpCash(
  charges: { grossMinor: number; refundedMinor: number; at: string }[],
): CashMonth[] {
  const byMonth = new Map<string, CashMonth>();
  for (const charge of charges) {
    const month = `${charge.at.slice(0, 7)}-01`;
    const row = byMonth.get(month) ?? { month, grossMinor: 0, refundedMinor: 0, netMinor: 0 };
    row.grossMinor += charge.grossMinor;
    row.refundedMinor += charge.refundedMinor;
    row.netMinor = row.grossMinor - row.refundedMinor;
    byMonth.set(month, row);
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/** `sk_live_…` / `sk_test_…`, so a page rendered against test data can label itself. */
export function stripeMode(secretKey: string | undefined): 'live' | 'test' | 'unknown' {
  if (!secretKey) return 'unknown';
  if (secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_')) return 'live';
  if (secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_')) return 'test';
  return 'unknown';
}
