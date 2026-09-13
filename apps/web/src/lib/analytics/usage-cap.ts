/**
 * Pure helpers for the "Usage cap" band on /admin/growth and the
 * /admin/growth/usage-cap sub-page.
 *
 * Nothing here touches the database, Next.js or the request: it is the
 * arithmetic and the words between a `GrowthUsageCapOverviewRow` and the
 * tiles that draw it, kept out of sections.tsx so it can be checked with a
 * plain `node --test`. Same reason growth-records.ts and growth-metrics.ts
 * exist beside growth-queries.ts.
 *
 * Relative imports carry an explicit `.ts` extension so the bare
 * `--experimental-strip-types` runner can follow the graph without a bundler.
 */

import type {
  GrowthUsageCapOverviewRow,
  GrowthUsageCapState,
  GrowthUsageCapWorkspaceRow,
} from './growth-types.ts';

/**
 * The shape a dead RPC degrades to. Every count is zero, which is honest
 * ONLY when paired with the tile's own error state; the section renders
 * `TileError` on a failed result and never this. It exists so the pure
 * helpers below have a total input and so a test can prove they never throw
 * on the emptiest possible row.
 */
export const EMPTY_USAGE_CAP_OVERVIEW: GrowthUsageCapOverviewRow = {
  in_grace: 0,
  under_half: 0,
  half: 0,
  warn: 0,
  capped: 0,
  metered: 0,
  exempt_early: 0,
  exempt_support: 0,
  refused_workspaces_window: 0,
  refusals_window: 0,
  email_80_queued: 0,
  email_80_sent: 0,
  email_100_queued: 0,
  email_100_sent: 0,
  email_pause_queued: 0,
  email_pause_sent: 0,
  funnel_capped: 0,
  funnel_pricing_viewed: 0,
  funnel_checkout_started: 0,
  funnel_checkout_completed: 0,
  capped_eligible: 0,
  capped_retained: 0,
  uncapped_eligible: 0,
  uncapped_retained: 0,
  rules_paused_now: 0,
  workspaces_paused_now: 0,
  pauses_window: 0,
};

/** A number, or zero when the RPC handed back something that is not one. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Fill every hole in a row the RPC returned. A renamed OUT column comes back
 * as `undefined` on the row and would otherwise print "NaN" in a tile that
 * looks perfectly healthy.
 */
export function normaliseUsageCapOverview(raw: Partial<GrowthUsageCapOverviewRow> | null | undefined): GrowthUsageCapOverviewRow {
  const row = { ...EMPTY_USAGE_CAP_OVERVIEW };
  if (!raw) return row;
  for (const key of Object.keys(EMPTY_USAGE_CAP_OVERVIEW) as (keyof GrowthUsageCapOverviewRow)[]) {
    row[key] = count(raw[key]);
  }
  return row;
}

/** The five metered states, in the order the strip prints them. */
export type UsageCapStateTile = {
  key: 'grace' | 'under_half' | 'half' | 'warn' | 'capped';
  label: string;
  value: number;
  note: string;
};

export function usageCapStateTiles(row: GrowthUsageCapOverviewRow): UsageCapStateTile[] {
  return [
    { key: 'grace', label: 'In grace', value: row.in_grace, note: 'first 7 days, uncounted' },
    { key: 'under_half', label: 'Under 50%', value: row.under_half, note: 'counting, no signal yet' },
    { key: 'half', label: '50 to 79%', value: row.half, note: 'on course for the email' },
    { key: 'warn', label: '80 to 99%', value: row.warn, note: 'warned, still working' },
    { key: 'capped', label: 'Capped', value: row.capped, note: 'refused until the 1st' },
  ];
}

/**
 * The tile tone. Red while anyone is standing at the wall, amber while
 * anyone has been warned, green otherwise. A capped workspace is not a
 * failure of ours, but it is the one state on this band that needs a person
 * to look, which is what red means on this board.
 */
export function usageCapTone(row: GrowthUsageCapOverviewRow): 'good' | 'warn' | 'bad' {
  if (row.capped > 0) return 'bad';
  if (row.warn > 0) return 'warn';
  return 'good';
}

/** The refusal-to-checkout funnel, as `FunnelSteps` wants it. */
export function usageCapFunnelSteps(row: GrowthUsageCapOverviewRow): { label: string; value: number; note?: string }[] {
  return [
    { label: 'Refused', value: row.funnel_capped, note: 'hit the allowance' },
    { label: 'Viewed pricing', value: row.funnel_pricing_viewed, note: 'after the refusal' },
    { label: 'Started checkout', value: row.funnel_checkout_started },
    { label: 'Paid', value: row.funnel_checkout_completed },
  ];
}

/**
 * The retention pair. Each side is retained of eligible; the caller prints
 * the ratio with the board's under-ten rule so a "100%" over two people
 * never appears.
 */
export function usageCapRetentionPair(row: GrowthUsageCapOverviewRow): {
  capped: { retained: number; eligible: number };
  uncapped: { retained: number; eligible: number };
} {
  return {
    capped: { retained: row.capped_retained, eligible: row.capped_eligible },
    uncapped: { retained: row.uncapped_retained, eligible: row.uncapped_eligible },
  };
}

/**
 * Share of the allowance used, as a whole percentage, or null when there is
 * no allowance to share. Rounded down, so 119 of 150 reads 79% and not the
 * 80% that would say the email had gone out.
 */
export function capShare(used: number, cap: number | null): number | null {
  if (cap === null || !Number.isFinite(cap) || cap <= 0 || !Number.isFinite(used)) return null;
  return Math.floor((Math.max(0, used) / cap) * 100);
}

/**
 * The domain half of an address, for the surfaces that must not name a
 * person. An address with no "@" yields null rather than the whole string,
 * which could be the local part on its own.
 */
export function ownerDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/** The state, in the words a person reads on the sub-page. */
export const USAGE_CAP_STATE_WORDS: Record<GrowthUsageCapState, string> = {
  exempt_early: 'Early member, never metered',
  exempt_support: 'Exempt by support or a comp',
  paid: 'Paid plan, no monthly cap',
  grace: 'In the grace week',
  under_half: 'Under half',
  half: '50 to 79%',
  warn: '80 to 99%, warned',
  capped: 'Capped, refused until the 1st',
};

export function describeUsageCapState(state: string): string {
  return (USAGE_CAP_STATE_WORDS as Record<string, string>)[state] ?? state;
}

/**
 * The rows the board band lists: the closest to the wall, most used first,
 * limited so the tile stays a tile. The RPC already sorts by `used`; this
 * re-sorts defensively because the band must never depend on row order it
 * did not choose.
 */
export function closestToTheWall(rows: GrowthUsageCapWorkspaceRow[], limit: number): GrowthUsageCapWorkspaceRow[] {
  return [...rows]
    .sort((a, b) => b.used - a.used || a.created_at.localeCompare(b.created_at))
    .slice(0, Math.max(0, limit));
}
