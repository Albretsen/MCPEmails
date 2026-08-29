/**
 * Row shapes returned by the /admin/growth reporting RPCs.
 *
 * This file is the CONTRACT between three layers and is intentionally free of
 * any runtime code or imports:
 *   1. `supabase/migrations/20260813140000_growth_analytics_rpcs.sql` defines
 *      SQL functions whose OUT columns match these fields exactly (same names,
 *      same order, snake_case).
 *   2. `src/lib/analytics/growth-queries.ts` calls those functions and casts
 *      the results to these types.
 *   3. `app/admin/growth/**` renders them.
 *
 * Generated `database.types.ts` covers tables, not functions or views, so
 * callers cast locally (`as unknown as GrowthDailyRow[]`) rather than weakening
 * the shared client type. Same convention as `product-funnel.ts`.
 *
 * Vocabulary used throughout:
 *   - "technical activation": first successful MCP tool call of any kind.
 *   - "value activation": first successful call that touched a mailbox, i.e.
 *     `status = 'success' AND inbox_id IS NOT NULL AND tool_name <> 'inbox_list'`.
 *     This is the durable definition already used by the onboarding backfill in
 *     migration 20260805010000; SQL must use it verbatim so the RPCs and the
 *     `workspaces.onboarding_value_activated_at` column can never disagree.
 *   - All dates are UTC. Day keys are `YYYY-MM-DD`, month/week keys are the
 *     first day of that period, also `YYYY-MM-DD`.
 */

/** One UTC day of product metrics. `growth_daily_metrics(p_days)`. */
export type GrowthDailyRow = {
  day: string;
  new_workspaces: number;
  technical_activations: number;
  value_activations: number;
  /** Distinct workspaces with a successful call in the 7 days ending on `day`. */
  active_7d: number;
  active_28d: number;
  calls: number;
  successes: number;
  errors: number;
  rate_limited: number;
};

/** Engagement distribution over a rolling window. `growth_engagement_bands(p_days)`. */
export type GrowthEngagementBandRow = {
  metric: 'active_days' | 'sessions';
  /** Matches `frequencyBand()` in retention.ts, including the en dashes. */
  band: '1' | '2–3' | '4–7' | '8+';
  workspaces: number;
};

/**
 * Value-activation retention curve. `growth_retention_curve(p_weeks)`.
 * `week_index` 1 means "days 1-7 after value activation". A workspace is only
 * counted in `eligible` once its whole week has elapsed.
 */
export type GrowthRetentionPointRow = {
  week_index: number;
  eligible: number;
  retained: number;
};

/** Cohort heatmap cell. `growth_cohort_retention(p_weeks)`. */
export type GrowthCohortCellRow = {
  /** Monday of the signup week. */
  cohort_week: string;
  cohort_size: number;
  /** 0 = the signup week itself. */
  week_index: number;
  retained: number;
};

/**
 * Blunt lifecycle counts, one row. `growth_lifecycle_counts()`.
 * These answer the retention question more directly than any ratio.
 */
export type GrowthLifecycleRow = {
  /** Workspaces with a value activation, ever. */
  value_activated: number;
  /** Value-activated, used it on exactly one UTC day, and that day is past. */
  one_and_done: number;
  /** Value-activated, was active at least twice, silent for 14+ days. */
  at_risk: number;
  /** Successful call in the last 7 days. */
  active_7d: number;
  /** Successful call in the last 28 days. */
  active_28d: number;
};

/**
 * Signup-to-value funnel. `growth_activation_funnel(p_days)`.
 * Rows come back in funnel order; `stage_index` makes that order explicit so
 * the renderer never depends on row ordering.
 */
export type GrowthActivationFunnelRow = {
  stage_index: number;
  stage:
    | 'signup'
    | 'client_selected'
    | 'inbox_connected'
    | 'connection_verified'
    | 'credential_issued'
    | 'technical_activation'
    | 'value_activation';
  workspaces: number;
};

/**
 * Per-provider connection funnel. `growth_provider_funnel(p_days)`.
 * `attempts`/`successes`/`failures` count `product_funnel_events` rows at
 * stage `inbox_connection`; the workspace counts are the deduplicated version,
 * which is what drop-off should be read from.
 */
export type GrowthProviderFunnelRow = {
  provider: string;
  workspaces_attempted: number;
  workspaces_connected: number;
  attempts: number;
  successes: number;
  failures: number;
  /** Most frequent `error_category` among failures, null when there are none. */
  top_error: string | null;
};

/**
 * OAuth consent abandonment. `growth_oauth_abandonment()`.
 *
 * `oauth_states` rows are deleted on a successful callback and never cleaned up
 * otherwise, so surviving rows are consent attempts that never came back. This
 * leak leaves no `product_funnel_events` row at all, which is exactly why it
 * has to be measured separately.
 */
export type GrowthOAuthAbandonmentRow = {
  provider: string;
  abandoned: number;
  connected: number;
};

/**
 * Google's 100-user cap on a published-but-unverified OAuth client with
 * restricted Gmail scopes. `gmail_oauth_cap_summary()`.
 *
 * `distinct_ever` is a FLOOR, not the true figure: Google counts a grant the
 * moment consent is given, so a user who consented and then failed before the
 * inbox row was written consumes a slot invisible to us. The authoritative
 * number lives in the Google Cloud Console and is recorded by hand in
 * `admin_oauth_cap_snapshots`.
 *
 * The count is cumulative on Google's side: revoking access or deleting an
 * inbox does NOT return a slot, which is why `distinct_ever` deliberately
 * includes soft-deleted inboxes.
 */
export type GmailCapSummaryRow = {
  /** Distinct lower(email_address) for provider 'gmail', including deleted. */
  distinct_ever: number;
  /** Of those, still not soft-deleted. */
  live: number;
  /** Of those, currently status = 'active'. */
  active: number;
  first_grant_at: string | null;
  grants_last_30d: number;
  grants_last_60d: number;
  /** Latest hand-entered Cloud Console figure, null when never recorded. */
  google_reported_users: number | null;
  google_reported_at: string | null;
};

/** Monthly Gmail grant series for the cap chart. `gmail_oauth_grant_series()`. */
export type GmailGrantMonthRow = {
  month: string;
  new_grants: number;
  cumulative_grants: number;
};

/**
 * One active workspace. `growth_active_workspaces(p_days)`.
 *
 * This is the ONE reporting row on the page that is not an aggregate: it
 * carries the workspace name and the owner's email address, deliberately, so
 * account-level questions can be answered without dropping into SQL. Nothing
 * else about the account is exposed: no credentials, no message content, no
 * subjects, no recipients, no IP address.
 */
export type GrowthActiveWorkspaceRow = {
  workspace_id: string;
  workspace_name: string;
  owner_email: string | null;
  plan: string;
  /** Owner holds an unexpired `comped_scale` entitlement, so this is not revenue. */
  is_comped: boolean;
  created_at: string;
  value_activated_at: string | null;
  last_active_at: string;
  active_days: number;
  sessions: number;
  calls: number;
  successes: number;
  errors: number;
  inboxes: number;
  /** Comma-separated provider names of the active inboxes. */
  providers: string;
  client: string;
};

/**
 * Revenue counts with comped and internal accounts excluded.
 * `growth_revenue_counts(p_internal_emails, p_internal_domains)`.
 *
 * `workspaces.plan` reads 'pro' for both a purchase and a comp, because both
 * paths write the same column. Counting that as revenue is how this page came
 * to claim "5 paid workspaces" while the true paying count was zero, and how
 * it read "1 paying customer" on 2026-08-29 when the row was our own test
 * account on a 100%-off subscription.
 *
 * KNOWN GAP, deliberately not papered over: the Stripe webhook stores no
 * amount and no coupon, so a 100%-off discount held by an EXTERNAL account is
 * indistinguishable from a real payment here. Only comps granted as a
 * `comped_scale` entitlement, and accounts that are ours, are excluded.
 */
export type GrowthRevenueRow = {
  paying_workspaces: number;
  paying_owners: number;
  comped_workspaces: number;
  comped_owners: number;
  free_workspaces: number;
  paying_personal: number;
  paying_solo: number;
  paying_scale: number;
  /** Live workspaces owned by one of our own accounts, on any plan. */
  internal_workspaces: number;
  /** The internal subset on a paid plan: what the paying counters now drop. */
  internal_paying_workspaces: number;
};

/** Top failing tools. `growth_error_breakdown(p_days)`. */
export type GrowthErrorRow = {
  tool_name: string;
  error_code: string | null;
  failures: number;
  calls: number;
};

/** The hard cap Google enforces on an unverified client with restricted scopes. */
export const GMAIL_OAUTH_USER_CAP = 100;

/**
 * Grant count at which verification work must already be under way. Google's
 * review plus the CASA assessment take weeks of calendar time and the cap does
 * not pause while they run.
 */
export const GMAIL_OAUTH_WARN_AT = 60;

/** Active inboxes per mail provider. `growth_provider_mix()`. */
export type GrowthProviderMixRow = {
  provider: string;
  inboxes: number;
};

/** Workspaces per MCP client, from their first successful call. `growth_client_mix()`. */
export type GrowthClientMixRow = {
  client: string;
  workspaces: number;
};

/**
 * Workspaces bucketed by share of their plan's action allowance used in their
 * own current billing period. `growth_utilization_bands(p_caps, p_meter_version)`.
 *
 * All five bands come back every time, empty ones included, so the chart keeps
 * a stable shape. The caps are passed in from the canonical plan table rather
 * than written in SQL: see `fetchUtilizationBands`.
 */
export type GrowthUtilizationBandRow = {
  band: string;
  workspaces: number;
};

/** Billable volume and cap rejections over a window. `growth_usage_volume(p_days, p_meter_version)`. */
export type GrowthUsageVolumeRow = {
  billable_actions: number;
  billable_workspaces: number;
  cap_hit_workspaces: number;
  cap_rejections: number;
  total_workspaces: number;
};
