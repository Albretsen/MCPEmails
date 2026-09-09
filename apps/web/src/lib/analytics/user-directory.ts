/**
 * Cached data access for /admin/growth/users.
 *
 * Same two rules as growth-queries.ts, which this deliberately mirrors rather
 * than extends: NOTHING THROWS (every fetcher returns a `GrowthResult`, so one
 * broken RPC kills one panel rather than the page), and EVERY READ IS CACHED
 * under `GROWTH_TAGS.accounts` plus the shared `growth` tag, so the Refresh
 * button on the growth board drops these too.
 *
 * WHY ITS OWN FILE. growth-queries.ts is the board's module and every fetcher
 * in it returns an aggregate; the two that return identity are already called
 * out in its comments. Everything here returns identity by definition, and
 * keeping it in one file makes "who reads the account roster" answerable by
 * grepping for one import path.
 *
 * THE ROW CAP IS EXPLICIT. PostgREST truncates any row-returning response at
 * its `db-max-rows` ceiling with no error and no marker, which is exactly the
 * failure mode a directory page must not have: a silently short list looks
 * like a smaller customer base. So the RPC returns `total_rows` computed before
 * its own LIMIT, `readAll` asks for a range wider than the cap, and the page
 * prints a warning whenever what arrived is shorter than what exists.
 */

import { createServiceRoleClient } from '@/lib/supabase/service';
import { GROWTH_TAGS, cachedSection, type GrowthResult } from '@/lib/analytics/growth-queries';

/** Widest window any of these will ask for: `activity_log` is purged at 90 days. */
export const USER_WINDOW_DAYS = 90;

/** Hard ceiling on the directory read. `total_rows` reports when it bites. */
const DIRECTORY_LIMIT = 5000;

/** How much of a person's history the timeline carries. */
const TIMELINE_LIMIT = 400;

/**
 * One person.
 *
 * Two clocks live in this row and must not be confused. Anything named
 * `calls`, `successes`, `active_days`, `last_active_at` is counted from
 * `activity_log` inside the window and is therefore at most 90 days old.
 * Everything ending in `_at` other than `last_active_at` is a durable column
 * and is all-time.
 */
export type UserDirectoryRow = {
  user_id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  signed_up_at: string;
  is_internal: boolean;
  unsubscribed_at: string | null;
  unsubscribed_categories: string[] | null;

  workspaces: number;
  memberships: number;
  primary_workspace_id: string | null;
  primary_workspace_name: string | null;
  primary_workspace_slug: string | null;
  plan: string;
  is_comped: boolean;
  unlimited_inboxes: boolean;
  grandfathered: boolean;

  acquisition_source: string | null;
  acquisition_utm_source: string | null;
  acquisition_utm_medium: string | null;
  acquisition_utm_campaign: string | null;
  acquisition_landing_path: string | null;
  acquisition_referrer: string | null;
  acquisition_locale: string | null;

  onboarding_stage: string | null;
  onboarding_client: string | null;
  first_inbox_connected_at: string | null;
  first_inbox_provider: string | null;
  first_credential_created_at: string | null;
  first_credential_method: string | null;
  first_tool_used_at: string | null;
  first_tool_name: string | null;
  first_tool_client: string | null;
  value_activated_at: string | null;

  inboxes: number;
  inboxes_broken: number;
  providers: string | null;
  api_keys: number;
  key_last_used_at: string | null;

  calls: number;
  successes: number;
  active_days: number;
  last_active_at: string | null;
  paywall_hits: number;

  billing_plan: string | null;
  subscription_status: string | null;
  stripe_customer_id: string | null;
  current_period_end: string | null;

  total_rows: number;
};

export type UserWorkspaceRow = {
  workspace_id: string;
  name: string;
  slug: string;
  role: 'owner' | 'member';
  plan: string;
  grandfathered: boolean;
  created_at: string;
  deleted_at: string | null;
  onboarding_stage: string | null;
  inbox_connected_at: string | null;
  credential_created_at: string | null;
  first_tool_used_at: string | null;
  value_activated_at: string | null;
  acquisition_source: string | null;
  acquisition_utm_source: string | null;
  acquisition_utm_medium: string | null;
  acquisition_utm_campaign: string | null;
  acquisition_landing_path: string | null;
  acquisition_referrer: string | null;
  members: number;
  inboxes: number;
  api_keys: number;
  calls: number;
  successes: number;
  last_active_at: string | null;
};

export type UserInboxRow = {
  inbox_id: string;
  workspace_id: string;
  workspace_name: string;
  email_address: string;
  display_name: string | null;
  provider: string;
  status: string;
  created_at: string;
  deleted_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  signature_enabled: boolean;
  send_approval_required: boolean;
  calls: number;
  successes: number;
  last_used_at: string | null;
};

export type UserActivityRow = { day: string; calls: number; successes: number; failures: number };

export type UserToolRow = {
  tool_name: string;
  calls: number;
  successes: number;
  failures: number;
  median_ms: number | null;
  last_used_at: string | null;
};

export type UserErrorRow = { error_code: string; tool_name: string; calls: number; last_at: string };

export type UserTimelineRow = {
  occurred_at: string;
  kind: 'account' | 'workspace' | 'inbox' | 'key' | 'funnel' | 'paywall' | 'email';
  title: string;
  detail: string | null;
  tone: 'good' | 'bad' | 'flat';
};

type RpcArgs = Record<string, number | string | null>;

/**
 * One RPC read, with the PostgREST row ceiling defeated explicitly.
 *
 * `.range()` widens the request past the default page; without it a response
 * longer than the ceiling comes back quietly truncated. Generated database
 * types cover tables and not functions, so the client is cast here rather than
 * weakened globally -- same convention as growth-queries.ts.
 */
async function readAll<T>(fn: string, args: RpcArgs, max: number): Promise<T[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = createServiceRoleClient() as any;
  const { data, error } = await service.rpc(fn, args).range(0, Math.max(max - 1, 0));
  if (error) throw new Error(error.message);
  if (data === null || data === undefined) return [];
  return (Array.isArray(data) ? data : [data]) as T[];
}

function cachedRpc<T>(fn: string, args: RpcArgs, max: number): Promise<GrowthResult<T[]>> {
  return cachedSection<T[]>(
    // The arguments MUST be in the key: unstable_cache hashes the callback's
    // source text, which is identical for every caller of this wrapper.
    [fn, JSON.stringify(args)],
    GROWTH_TAGS.accounts,
    () => readAll<T>(fn, args, max),
  );
}

/** Everybody, newest signup first. Sorting and filtering happen in user-table.ts. */
export function fetchUserDirectory(days = USER_WINDOW_DAYS): Promise<GrowthResult<UserDirectoryRow[]>> {
  return cachedRpc<UserDirectoryRow>(
    'growth_user_directory',
    { p_days: days, p_limit: DIRECTORY_LIMIT, p_user_id: null },
    DIRECTORY_LIMIT,
  );
}

/**
 * One person, from the SAME function the list uses.
 *
 * Not a second query with its own arithmetic: the detail header prints the
 * figures the list column shows, and computing them twice is how a page ends
 * up quietly disagreeing with itself.
 */
export async function fetchUserRow(
  userId: string,
  days = USER_WINDOW_DAYS,
): Promise<GrowthResult<UserDirectoryRow | null>> {
  const result = await cachedRpc<UserDirectoryRow>(
    'growth_user_directory',
    { p_days: days, p_limit: 1, p_user_id: userId },
    1,
  );
  if (!result.ok) return result;
  return { ok: true, data: result.data[0] ?? null, fetchedAt: result.fetchedAt };
}

export function fetchUserWorkspaces(userId: string, days = USER_WINDOW_DAYS) {
  return cachedRpc<UserWorkspaceRow>('growth_user_workspaces', { p_user_id: userId, p_days: days }, 200);
}

export function fetchUserInboxes(userId: string, days = USER_WINDOW_DAYS) {
  return cachedRpc<UserInboxRow>('growth_user_inboxes', { p_user_id: userId, p_days: days }, 500);
}

export function fetchUserActivity(userId: string, days = USER_WINDOW_DAYS) {
  return cachedRpc<UserActivityRow>('growth_user_activity', { p_user_id: userId, p_days: days }, days + 1);
}

export function fetchUserTools(userId: string, days = USER_WINDOW_DAYS) {
  return cachedRpc<UserToolRow>('growth_user_tools', { p_user_id: userId, p_days: days }, 100);
}

export function fetchUserErrors(userId: string, days = USER_WINDOW_DAYS) {
  return cachedRpc<UserErrorRow>('growth_user_errors', { p_user_id: userId, p_days: days }, 25);
}

export function fetchUserTimeline(userId: string) {
  return cachedRpc<UserTimelineRow>('growth_user_timeline', { p_user_id: userId, p_limit: TIMELINE_LIMIT }, TIMELINE_LIMIT);
}
