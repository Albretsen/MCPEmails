/**
 * The MRR figure albretsen.no shows for MCPEmails, as pure arithmetic.
 *
 * The figure itself is the kiosk's: `loadRecurringRevenue` in
 * src/lib/analytics/kiosk-revenue.ts prices every subscription from Stripe,
 * net of VAT, with internal accounts and comps left out, and converts it all
 * to USD minor units. This module only turns that into NOK for the site and
 * decides whether the site needs telling. Nothing here reads a clock, the
 * network or the environment, so all of it is unit tested.
 */

import { usdPerUnit } from '@/lib/analytics/fx';

/** Product id the site keys the figure on. */
export const SITE_FEED_PRODUCT = 'mcp-emails';

/**
 * Post at least this often even when the value has not moved, so the site's
 * `updated` stamp says the feed is alive. Just under an hour, so the 15 minute
 * cron always lands one refresh inside every hour.
 */
export const FIGURE_STALE_MS = 55 * 60_000;

/** `YYYY-MM` in UTC. */
export function monthKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

/**
 * USD minor units as NOK, two decimals, at the month's average rate.
 *
 * `rate` is USD per one NOK (fx.ts), so NOK = USD / rate. A month past the end
 * of the rate table falls back to its latest month inside `usdPerUnit`.
 *
 * Returns null for anything that must not reach the site: a non-finite or
 * non-positive MRR (a Stripe outage that read zero subscriptions would
 * otherwise post 0 kr to a public page) or a missing or nonsensical rate.
 */
export function mrrNok(
  mrrMinorUsd: number,
  month: string,
  rateFor: (currency: string, month: string) => number | null = usdPerUnit,
): number | null {
  if (!Number.isFinite(mrrMinorUsd) || mrrMinorUsd <= 0) return null;
  const rate = rateFor('nok', month);
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return null;
  const nok = Math.round((mrrMinorUsd / 100 / rate) * 100) / 100;
  return Number.isFinite(nok) && nok > 0 ? nok : null;
}

/** What GET /api/figures says about this product, or null when nothing yet. */
export type SiteFigure = { value: number; updated: string | null };

/**
 * Whether to POST `next`: when the site has nothing, when the value differs by
 * at least half an øre, or when the site's copy is older than FIGURE_STALE_MS
 * (or its timestamp is unreadable). `current` undefined means the GET failed;
 * posting then is harmless (the same value again) and keeps the feed alive.
 */
export function shouldPostFigure(
  current: SiteFigure | null | undefined,
  next: number,
  nowMs: number,
  staleMs: number = FIGURE_STALE_MS,
): boolean {
  if (!current) return true;
  if (!Number.isFinite(current.value) || Math.abs(current.value - next) >= 0.005) return true;
  const updated = current.updated ? Date.parse(current.updated) : Number.NaN;
  if (!Number.isFinite(updated)) return true;
  return nowMs - updated >= staleMs;
}

/** Pick this product's figure out of a GET /api/figures body, defensively. */
export function readSiteFigure(body: unknown): SiteFigure | null {
  if (!body || typeof body !== 'object') return null;
  const figures = (body as { figures?: unknown }).figures;
  if (!figures || typeof figures !== 'object') return null;
  const entry = (figures as Record<string, unknown>)[SITE_FEED_PRODUCT];
  if (!entry || typeof entry !== 'object') return null;
  const value = Number((entry as { value?: unknown }).value);
  const updated = (entry as { updated?: unknown }).updated;
  return {
    value,
    updated: typeof updated === 'string' ? updated : typeof updated === 'number' ? new Date(updated).toISOString() : null,
  };
}
