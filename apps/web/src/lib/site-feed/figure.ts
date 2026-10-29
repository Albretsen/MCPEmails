/**
 * The "emails handled" figure albretsen.no shows for MCPEmails, as pure logic.
 *
 * The count itself is `public.site_feed_emails_handled()`
 * (20261026100000_site_feed_emails_handled.sql): per-email tool calls from the
 * permanent usage meter plus every email a bulk run changed, external
 * workspaces only. This module turns that count into the short string the site
 * shows and decides whether the site needs telling. Nothing here reads a
 * clock, the network or the environment, so all of it is unit tested.
 *
 * The site refuses any figure that looks like money, so this figure is a
 * count of emails, never revenue, and the label carries no unit.
 */

/** Product id the site keys the figure on. */
export const SITE_FEED_PRODUCT = 'mcp-emails';

/** The label the site shows beside the value: "1.25 million+ emails handled". */
export const FIGURE_LABEL = 'emails handled';

/**
 * Repost an unchanged figure at least this often, so the site's `updated`
 * stamp says the feed is alive. The cron runs hourly (minute 7), so 23 hours
 * lands one heartbeat inside every day.
 */
export const FIGURE_STALE_MS = 23 * 3_600_000;

/**
 * The count as the site shows it, always rounded DOWN so the figure never
 * claims more than happened, in steps that visibly grow:
 *
 *   below 1 million     thousands             948,000+
 *   below 10 million    two decimals          1.25 million+
 *   below 1 billion     one decimal           12.4 million+
 *   from 1 billion      two decimals          1.02 billion+
 *
 * Returns null for anything that must not reach a public page: a non-finite
 * count, or one below 1,000 (a broken read that returned almost nothing).
 */
export function displayEmailsHandled(count: number): string | null {
  if (!Number.isFinite(count) || count < 1_000) return null;
  const n = Math.floor(count);
  if (n < 1_000_000) return `${(Math.floor(n / 1_000) * 1_000).toLocaleString('en-US')}+`;
  if (n < 10_000_000) return `${decimals(Math.floor(n / 10_000), 2)} million+`;
  if (n < 1_000_000_000) return `${decimals(Math.floor(n / 100_000), 1)} million+`;
  return `${decimals(Math.floor(n / 10_000_000), 2)} billion+`;
}

/** An integer of hundredths (or tenths) as a decimal string, without float error. */
function decimals(scaled: number, places: 1 | 2): string {
  const unit = places === 2 ? 100 : 10;
  return `${Math.floor(scaled / unit)}.${String(scaled % unit).padStart(places, '0')}`;
}

/**
 * The count a displayed figure promises at least: "1.25 million+" is
 * 1,250,000 and "948,000+" is 948,000. A plain number is itself. Null when the
 * value is not in a shape this module writes.
 */
export function displayedFloor(value: number | string): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = value.trim();
  const thousands = /^(\d{1,3}(?:,\d{3})*)\+$/.exec(text);
  if (thousands) return Number(thousands[1].replaceAll(',', ''));
  const scaled = /^(\d+)(?:\.(\d{1,2}))? (million|billion)\+$/.exec(text);
  if (!scaled) return null;
  const unit = scaled[3] === 'million' ? 1_000_000 : 1_000_000_000;
  const fraction = (scaled[2] ?? '').padEnd(2, '0');
  return Number(scaled[1]) * unit + (Number(fraction) * unit) / 100;
}

/** What GET /api/figures says about this product, or null when nothing yet. */
export type SiteFigure = { label: string | null; value: number | string | null; updated: string | null };

export type FigureDecision = 'post' | 'unchanged' | 'would_decrease';

/**
 * Whether to POST `next` (a string from displayEmailsHandled):
 *
 *   - the site has no figure for this product, or one under another label
 *     (the old MRR one), or one in a shape this module does not write: post;
 *   - `next` promises fewer emails than the site already shows: never post.
 *     The count can drop (bulk_runs is short-lived), the public figure must
 *     not;
 *   - the same string: post only once the site's copy is FIGURE_STALE_MS old
 *     (or its stamp is unreadable), as a heartbeat;
 *   - otherwise it grew: post.
 *
 * The caller skips the run when the GET failed, rather than calling this with
 * nothing: without the site's figure the never-decrease rule cannot be kept.
 */
export function decideFigure(
  current: SiteFigure | null,
  next: string,
  nowMs: number,
  staleMs: number = FIGURE_STALE_MS,
): FigureDecision {
  if (!current || current.label !== FIGURE_LABEL || current.value === null) return 'post';
  const shown = displayedFloor(current.value);
  const proposed = displayedFloor(next);
  if (shown === null || proposed === null) return 'post';
  if (proposed < shown) return 'would_decrease';
  if (current.value !== next) return 'post';
  const updated = current.updated ? Date.parse(current.updated) : Number.NaN;
  if (!Number.isFinite(updated)) return 'post';
  return nowMs - updated >= staleMs ? 'post' : 'unchanged';
}

/** Pick this product's figure out of a GET /api/figures body, defensively. */
export function readSiteFigure(body: unknown): SiteFigure | null {
  if (!body || typeof body !== 'object') return null;
  const figures = (body as { figures?: unknown }).figures;
  if (!figures || typeof figures !== 'object') return null;
  const entry = (figures as Record<string, unknown>)[SITE_FEED_PRODUCT];
  if (!entry || typeof entry !== 'object') return null;
  const { label, value, updated } = entry as { label?: unknown; value?: unknown; updated?: unknown };
  return {
    label: typeof label === 'string' ? label : null,
    value: typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? value : null,
    updated: typeof updated === 'string' ? updated : typeof updated === 'number' ? new Date(updated).toISOString() : null,
  };
}
