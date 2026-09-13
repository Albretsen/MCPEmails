/**
 * How the dashboard reads an `actionAllowance` (the /api/usage shape, see
 * src/lib/usage/allowance.ts). Pure functions, no React, so the Overview tile,
 * the Usage page strip and the Billing summary all pick the same state from
 * the same object and the choice is testable without mounting anything.
 *
 * The four states, in the order they are decided:
 *
 *   exempt    every workspace from before 2026-09-12, a comped owner, or a
 *             support exemption. Nothing is counted against anything; the
 *             tile says so instead of showing a number with no ceiling.
 *   plain     a paid plan (its ceiling is a silent abuse guard and must not be
 *             drawn), or no allowance at all (the RPC failed, or an unknown
 *             plan). A plain call count, exactly the tile that was there
 *             before the allowance existed.
 *   grace     a metered Free workspace in its first 7 days. Actions are not
 *             counted yet, and the tile says until when.
 *   counting  a metered Free workspace past its grace week: used of cap, a
 *             bar, amber from 80%, red at 100%.
 */

/** Share of the cap at which the bar turns amber and the Usage banner appears. */
export const ALLOWANCE_WARN_RATIO = 0.8;

/**
 * @param {import('./allowance').ActionAllowance | null | undefined} allowance
 * @returns {'exempt' | 'plain' | 'grace' | 'counting'}
 */
export function allowanceTileState(allowance) {
  if (!allowance) return 'plain';
  if (allowance.exempt) return 'exempt';
  if (allowance.plan !== 'free') return 'plain';
  if (allowance.in_grace) return 'grace';
  if (allowance.monthly?.cap == null) return 'plain';
  return 'counting';
}

/**
 * The numbers a bar needs, or null when there is no bar to draw.
 *
 * @param {import('./allowance').ActionAllowance | null | undefined} allowance
 * @returns {{ used: number, cap: number, remaining: number, ratio: number, pct: number, nearLimit: boolean, atLimit: boolean } | null}
 */
export function allowanceProgress(allowance) {
  if (allowanceTileState(allowance) !== 'counting') return null;
  const cap = Number(allowance.monthly.cap);
  const used = Math.max(0, Number(allowance.monthly.used) || 0);
  if (!(cap > 0)) return null;
  const ratio = used / cap;
  return {
    used,
    cap,
    remaining: Math.max(0, cap - used),
    ratio,
    pct: Math.min(100, Math.round(ratio * 100)),
    nearLimit: ratio >= ALLOWANCE_WARN_RATIO,
    atLimit: ratio >= 1,
  };
}

/**
 * The bar colour token for a progress result. Mirrors the inbox indicator:
 * brand until 80%, amber from 80%, red once the cap is reached.
 *
 * @param {{ nearLimit: boolean, atLimit: boolean } | null} progress
 * @returns {'brand' | 'amber' | 'red'}
 */
export function allowanceTone(progress) {
  if (!progress) return 'brand';
  if (progress.atLimit) return 'red';
  if (progress.nearLimit) return 'amber';
  return 'brand';
}

/**
 * Whether the Usage page shows the upgrade banner: only a metered Free
 * workspace at 80% or more. Grace, exempt and paid never see it.
 *
 * @param {import('./allowance').ActionAllowance | null | undefined} allowance
 */
export function showUsageCapBanner(allowance) {
  const progress = allowanceProgress(allowance);
  return progress != null && progress.nearLimit;
}
