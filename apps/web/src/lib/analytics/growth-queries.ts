/**
 * Cached data access for the internal /admin/growth page.
 *
 * The page it replaces pulled roughly 104k raw `activity_log` rows through 104
 * sequential PostgREST pages and aggregated them in Node on every single
 * request, with `force-dynamic` so none of it was ever reused. Two operators
 * opening the page at once did the whole thing twice. This module moves the
 * aggregation into SQL (see `supabase/migrations/*_growth_analytics_rpcs.sql`)
 * and caches the tens of rows that come back, so a page load costs a handful of
 * cheap RPCs and usually zero database work at all.
 *
 * Two rules shape everything here.
 *
 * 1. NOTHING THROWS. The page renders each section in its own Suspense
 *    boundary, and a single broken RPC (a migration not yet applied, a renamed
 *    column) must degrade that one section rather than blank the whole page.
 *    Every fetcher returns a `GrowthResult`, and the error string is the raw
 *    Supabase message because this page is operator-only and a vague "something
 *    went wrong" would just cost someone a debugging session.
 *
 * 2. EVERY READ IS CACHED under a section tag plus the shared `growth` tag, so
 *    the page's Refresh button can drop the lot with one `revalidateTag`.
 *
 * Row shapes and the SQL function names live in growth-types.ts, which is the
 * binding contract between the migration, this module and the page. Generated
 * `database.types.ts` covers tables but neither functions nor views, so `.rpc()`
 * and the billing view are cast locally rather than by weakening the shared
 * client type (same convention as product-funnel.ts).
 */

import { revalidateTag, unstable_cache } from 'next/cache';
import { createServiceRoleClient } from '@/lib/supabase/service';
import type {
  GmailCapSummaryRow,
  GmailGrantMonthRow,
  GrowthActivationFunnelRow,
  GrowthCohortCellRow,
  GrowthDailyRow,
  GrowthEngagementBandRow,
  GrowthErrorRow,
  GrowthLifecycleRow,
  GrowthOAuthAbandonmentRow,
  GrowthProviderFunnelRow,
  GrowthRetentionPointRow,
  GrowthActiveWorkspaceRow,
  GrowthRevenueRow,
  GrowthProviderMixRow,
  GrowthClientMixRow,
  GrowthUtilizationBandRow,
  GrowthUsageVolumeRow,
  GrowthUpgradePressureRow,
  GrowthInboxBandRow,
  GrowthChannelRow,
} from '@/lib/analytics/growth-types';
import { PLANS, resolvePlanLimits } from '@/lib/stripe/plans';
import { internalAccountMatchers } from '@/lib/analytics/internal-accounts';

// The cap projection is implemented next to the other pure helpers so it can be
// unit tested without dragging in the Supabase client, and re-exported here
// because this is where callers look for it.
export { gmailCapProjection, type GmailCapProjection } from './growth-metrics.ts';

/** Invalidating this one tag refreshes every section of the page. */
export const GROWTH_TAG = 'growth';

/** One tag per logical section, so a targeted refresh stays possible. */
export const GROWTH_TAGS = {
  daily: 'growth:daily',
  retention: 'growth:retention',
  funnel: 'growth:funnel',
  gmail: 'growth:gmail',
  errors: 'growth:errors',
  inventory: 'growth:inventory',
  accounts: 'growth:accounts',
  revenue: 'growth:revenue',
} as const;

/**
 * Ten minutes. Growth numbers move in days, and the operator has a Refresh
 * button for the rare case where they need to see a change immediately.
 */
export const GROWTH_REVALIDATE_SECONDS = 600;

/**
 * Either the rows or the reason there are none, never an exception.
 * `fetchedAt` is captured inside the cache, so it reports when the data was
 * actually read rather than when this render happened to look at it.
 */
export type GrowthResult<T> =
  | { ok: true; data: T; fetchedAt: string }
  | { ok: false; error: string; fetchedAt: string };

/** Longest window any RPC will be asked for. Guards a typo, not an attacker. */
const MAX_DAYS = 400;
const MAX_WEEKS = 104;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

const clampDays = (days: number) => clampInt(days, 1, MAX_DAYS);
const clampWeeks = (weeks: number) => clampInt(weeks, 1, MAX_WEEKS);

/**
 * Run one cached read.
 *
 * `keyParts` must identify the call completely, ARGUMENTS INCLUDED.
 * `unstable_cache` builds its key from the callback's source text plus
 * keyParts, and the wrapper below has identical source text for every caller,
 * so two calls that differ only in a captured `p_days` would otherwise collide
 * on one cache entry and silently serve each other's rows.
 */
export async function cachedSection<T>(
  keyParts: string[],
  tag: string,
  load: () => Promise<T>,
): Promise<GrowthResult<T>> {
  try {
    const cached = unstable_cache(
      async () => ({ payload: await load(), fetchedAt: new Date().toISOString() }),
      ['growth', ...keyParts],
      { revalidate: GROWTH_REVALIDATE_SECONDS, tags: [GROWTH_TAG, tag] },
    );
    const { payload, fetchedAt } = await cached();
    return { ok: true, data: payload, fetchedAt };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[growth]', 'cached read failed', { key: keyParts.join(':'), error });
    return { ok: false, error, fetchedAt: new Date().toISOString() };
  }
}

/**
 * RPC arguments: numbers, the plan-cap map passed to the bands function, and
 * the internal-account lists passed to the retention curve.
 */
type RpcArgs = Record<string, number | string[] | Record<string, number>>;

async function callRpc<T>(fn: string, args: RpcArgs): Promise<T[]> {
  // Generated database types cover tables, not functions; cast locally rather
  // than weakening the shared service-role client.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = createServiceRoleClient() as any;
  const { data, error } = await service.rpc(fn, args);
  if (error) throw new Error(error.message);
  // A `RETURNS TABLE` function comes back as an array. Tolerate a scalar/record
  // shape too, so a harmless change on the SQL side cannot blank a section.
  if (data === null || data === undefined) return [];
  return (Array.isArray(data) ? data : [data]) as T[];
}

function rpcRows<T>(
  fn: string,
  tag: string,
  args: RpcArgs = {},
): Promise<GrowthResult<T[]>> {
  return cachedSection<T[]>([fn, JSON.stringify(args)], tag, () => callRpc<T>(fn, args));
}

/** For the RPCs that are defined to return exactly one summary row. */
async function rpcSingleRow<T>(fn: string, tag: string, args: RpcArgs = {}): Promise<GrowthResult<T>> {
  const result = await rpcRows<T>(fn, tag, args);
  if (!result.ok) return result;
  const row = result.data[0];
  if (!row) {
    // These are pure aggregates, so no rows means the function is not behaving
    // as the contract describes. Surfacing that beats rendering zeroes.
    const error = `${fn}() returned no rows.`;
    console.error('[growth]', error);
    return { ok: false, error, fetchedAt: result.fetchedAt };
  }
  return { ok: true, data: row, fetchedAt: result.fetchedAt };
}

/** Per-day product metrics for the last `days` UTC days. */
export async function fetchDailyMetrics(days: number): Promise<GrowthResult<GrowthDailyRow[]>> {
  return rpcRows<GrowthDailyRow>('growth_daily_metrics', GROWTH_TAGS.daily, { p_days: clampDays(days) });
}

/** Engagement distribution (active days, sessions) over a rolling window. */
export async function fetchEngagementBands(days: number): Promise<GrowthResult<GrowthEngagementBandRow[]>> {
  return rpcRows<GrowthEngagementBandRow>('growth_engagement_bands', GROWTH_TAGS.retention, { p_days: clampDays(days) });
}

/**
 * Weeks-since-value-activation retention curve, EXTERNAL accounts only.
 *
 * The internal list has to cross into SQL because this RPC returns aggregates
 * rather than rows, so there is nothing left to filter on the way back. It
 * matters more here than anywhere else on the page: our synthetic monitor calls
 * the product every five minutes, so including it made the curve rise in its
 * tail (23 -> 25 -> 40 -> 50%) when no external workspace has ever returned in
 * week 8 or later.
 */
export async function fetchRetentionCurve(weeks: number): Promise<GrowthResult<GrowthRetentionPointRow[]>> {
  const internal = internalAccountMatchers();
  return rpcRows<GrowthRetentionPointRow>('growth_retention_curve', GROWTH_TAGS.retention, {
    p_weeks: clampWeeks(weeks),
    p_internal_emails: internal.emails,
    p_internal_domains: internal.domains,
  });
}

/** Signup-cohort retention heatmap cells. */
export async function fetchCohortRetention(weeks: number): Promise<GrowthResult<GrowthCohortCellRow[]>> {
  return rpcRows<GrowthCohortCellRow>('growth_cohort_retention', GROWTH_TAGS.retention, { p_weeks: clampWeeks(weeks) });
}

/** Blunt lifecycle counts (activated, one-and-done, at risk, active). */
export async function fetchLifecycleCounts(): Promise<GrowthResult<GrowthLifecycleRow>> {
  return rpcSingleRow<GrowthLifecycleRow>('growth_lifecycle_counts', GROWTH_TAGS.retention);
}

/** Signup to value-activation funnel, in stage order. */
export async function fetchActivationFunnel(days: number): Promise<GrowthResult<GrowthActivationFunnelRow[]>> {
  return rpcRows<GrowthActivationFunnelRow>('growth_activation_funnel', GROWTH_TAGS.funnel, { p_days: clampDays(days) });
}

/** Per-provider inbox connection funnel with the top failure category. */
export async function fetchProviderFunnel(days: number): Promise<GrowthResult<GrowthProviderFunnelRow[]>> {
  return rpcRows<GrowthProviderFunnelRow>('growth_provider_funnel', GROWTH_TAGS.funnel, { p_days: clampDays(days) });
}

/**
 * Consent screens that were opened and never came back. Surviving `oauth_states`
 * rows are the only trace this leak leaves, which is why it is measured apart
 * from the provider funnel.
 */
export async function fetchOAuthAbandonment(): Promise<GrowthResult<GrowthOAuthAbandonmentRow[]>> {
  return rpcRows<GrowthOAuthAbandonmentRow>('growth_oauth_abandonment', GROWTH_TAGS.funnel);
}

/** Counters behind Google's 100 user cap on the unverified OAuth client. */
export async function fetchGmailCapSummary(): Promise<GrowthResult<GmailCapSummaryRow>> {
  return rpcSingleRow<GmailCapSummaryRow>('gmail_oauth_cap_summary', GROWTH_TAGS.gmail);
}

/** Monthly Gmail grant series, new and cumulative. */
export async function fetchGmailGrantSeries(): Promise<GrowthResult<GmailGrantMonthRow[]>> {
  return rpcRows<GmailGrantMonthRow>('gmail_oauth_grant_series', GROWTH_TAGS.gmail);
}

/** Top failing tools over the window. */
export async function fetchErrorBreakdown(days: number): Promise<GrowthResult<GrowthErrorRow[]>> {
  return rpcRows<GrowthErrorRow>('growth_error_breakdown', GROWTH_TAGS.errors, { p_days: clampDays(days) });
}

/**
 * The roster of workspaces that actually used the product in the window.
 *
 * Cached under its own tag rather than the shared inventory one: this is the
 * only fetcher on the page that returns account identity, and keeping it
 * separable makes it easy to see, and to revoke, who reads it.
 */
export async function fetchActiveWorkspaces(days: number): Promise<GrowthResult<GrowthActiveWorkspaceRow[]>> {
  return rpcRows<GrowthActiveWorkspaceRow>('growth_active_workspaces', GROWTH_TAGS.accounts, { p_days: clampDays(days) });
}

/**
 * Paying versus comped versus free, with comps and our own accounts kept out
 * of the revenue number.
 *
 * The internal list crosses into SQL for the same reason it does in the
 * retention curve: this RPC returns aggregates, so there is nothing left to
 * filter on the way back. Without it the headline paying figure counted our
 * own 100%-off test account as a customer, which is the one number on this
 * page nobody should have to second-guess.
 */
export async function fetchRevenueCounts(): Promise<GrowthResult<GrowthRevenueRow>> {
  const internal = internalAccountMatchers();
  return rpcSingleRow<GrowthRevenueRow>('growth_revenue_counts', GROWTH_TAGS.funnel, {
    p_internal_emails: internal.emails,
    p_internal_domains: internal.domains,
  });
}

/** Active inboxes by provider, with app-password connections named by service. */
export async function fetchProviderMix(): Promise<GrowthResult<GrowthProviderMixRow[]>> {
  return rpcRows<GrowthProviderMixRow>('growth_provider_mix', GROWTH_TAGS.inventory);
}

/** Workspaces by the MCP client seen on their first successful tool call. */
export async function fetchClientMix(): Promise<GrowthResult<GrowthClientMixRow[]>> {
  return rpcRows<GrowthClientMixRow>('growth_client_mix', GROWTH_TAGS.inventory);
}

/**
 * The ceilings the bands are measured against, taken from the canonical plan
 * table the edge function enforces from, so raising a ceiling moves the chart
 * with it.
 *
 * Since the 2026-08-19 repricing these are abuse ceilings rather than sold
 * allowances, which changes how to READ this panel: a workspace at 60% of its
 * ceiling is not a customer about to convert, it is a workspace worth looking
 * at for a runaway loop. Conversion pressure now lives in the inbox count.
 *
 * Infinity is sent as 0 rather than dropped: JSON has no infinity, an omitted
 * plan means "unknown plan id" to the RPC (which falls back to the free
 * ceiling), and those two cases must not collapse into each other. The RPC
 * reads a non-positive cap as unlimited.
 */
function actionCapsByPlan(): Record<string, number> {
  return Object.fromEntries(
    Object.keys(PLANS).map((planId) => {
      const cap = resolvePlanLimits(planId).maxMonthlyToolCalls;
      return [planId, Number.isFinite(cap) ? cap : 0];
    }),
  );
}

/**
 * Workspaces bucketed by share of their action allowance used.
 *
 * Deliberately takes no `days`: the allowance is granted per billing period, so
 * the RPC measures each workspace over its own current period. Dividing a
 * trailing 7 or 90 day window by a per-period cap, which is what this panel used
 * to do, produces a number that means nothing in either direction.
 */
export async function fetchUtilizationBands(): Promise<GrowthResult<GrowthUtilizationBandRow[]>> {
  return rpcRows<GrowthUtilizationBandRow>('growth_utilization_bands', GROWTH_TAGS.inventory, {
    p_caps: actionCapsByPlan(),
  });
}

/** Billable actions, cap rejections and estate size over the window. */
export async function fetchUsageVolume(days: number): Promise<GrowthResult<GrowthUsageVolumeRow>> {
  return rpcSingleRow<GrowthUsageVolumeRow>('growth_usage_volume', GROWTH_TAGS.inventory, {
    p_days: clampDays(days),
  });
}

/** One row per workspace from the `billing_funnel_by_workspace` view. */
export type BillingFunnelRow = {
  workspace_id: string;
  plan: string | null;
  paywall_hits: number;
  pricing_views: number;
  checkouts_started: number;
  checkouts_failed: number;
  checkouts_completed: number;
  abandoned_checkout: boolean;
};

/**
 * Billing funnel, read from the view rather than derived from activity: a
 * paywall hit, a pricing view and an abandoned checkout leave no trace in
 * `activity_log`. Reported all-time, not windowed, because the counts are small
 * enough that a 28 day window would usually show zeros and hide the real shape.
 */
export async function fetchBillingFunnel(): Promise<GrowthResult<BillingFunnelRow[]>> {
  return cachedSection<BillingFunnelRow[]>(['billing_funnel_by_workspace'], GROWTH_TAGS.funnel, async () => {
    // Generated database types cover tables, not views; cast locally.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = createServiceRoleClient() as any;
    const { data, error } = await service
      .from('billing_funnel_by_workspace')
      .select('workspace_id, plan, paywall_hits, pricing_views, checkouts_started, checkouts_failed, checkouts_completed, abandoned_checkout');
    if (error) throw new Error(error.message);
    return (data ?? []) as BillingFunnelRow[];
  });
}

/**
 * Called by the Refresh route handler (app/admin/growth/refresh/route.ts).
 *
 * Not a Server Action: it was one originally, bound directly to the page's
 * <form action={...}>, but Next's per-build action-ID lookup failed to
 * recognize it on every submission in production (verified live 2026-08-30 —
 * `UnrecognizedActionError`, reproducing on a freshly loaded page against a
 * stable, unchanged deployment, so it was not a deploy-skew race). This is the
 * only 'use server' function in the app, which points at that pairing rather
 * than anything about the revalidation call itself. A plain route handler
 * sidesteps the action manifest entirely: it is addressed by URL, not a
 * build-generated hash.
 *
 * `{ expire: 0 }` rather than a named profile such as 'max': the operator
 * pressed Refresh because they want to see the new numbers now, and an expiry
 * of zero is what makes Next treat the page as revalidated immediately instead
 * of serving one more stale render while it rebuilds in the background.
 */
export async function refreshGrowthData(): Promise<void> {
  revalidateTag(GROWTH_TAG, { expire: 0 });
}

/**
 * The population the INBOX paywall can actually reach.
 *
 * Takes the free cap from the canonical plan table rather than writing it in
 * SQL, the same convention as `fetchUtilizationBands`, so a pricing change
 * moves this panel with it. `Infinity` is sent as 1 rather than dropped: the
 * free plan having an unlimited inbox allowance would mean there is no paywall
 * to measure, and a missing argument would silently fall back to the SQL
 * default instead of saying so.
 */
export async function fetchUpgradePressure(): Promise<GrowthResult<GrowthUpgradePressureRow>> {
  const cap = resolvePlanLimits('free').maxInboxes;
  return rpcSingleRow<GrowthUpgradePressureRow>('growth_upgrade_pressure', GROWTH_TAGS.inventory, {
    p_free_inbox_cap: Number.isFinite(cap) ? cap : 1,
  });
}

/** Live workspaces by inbox count, split by whether the cap can reach them. */
export async function fetchInboxDistribution(): Promise<GrowthResult<GrowthInboxBandRow[]>> {
  return rpcRows<GrowthInboxBandRow>('growth_inbox_distribution', GROWTH_TAGS.inventory);
}

/**
 * Signups by first-touch channel, and what each channel did next.
 *
 * Clamped to 90 days by the caller for the same reason every other windowed
 * read is: `activity_log` is purged at 90, so the `returned` column would be
 * divided into a decaying denominator beyond that.
 */
export async function fetchAcquisitionChannels(days: number): Promise<GrowthResult<GrowthChannelRow[]>> {
  return rpcRows<GrowthChannelRow>('growth_acquisition_channels', GROWTH_TAGS.funnel, {
    p_days: clampDays(days),
  });
}
