import { redirect, notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { ACTIVE_WORKSPACE_COOKIE } from '@/lib/workspace/active';
import { PENDING_INBOX_COLUMNS, selectTolerantly } from '@/lib/approvals/columns';
import { DashboardApp } from '../../../components/dashboard/App';
import { pathSegmentToSection } from '../../../components/dashboard/routes';
import { resolvePlanLimits } from '../../../src/lib/stripe/plans';
import { retentionDays } from '../../../src/lib/analytics/retention';
import { resolveUsageBillingWindow } from '../../../src/lib/usage/billing-window';
import { fetchStripePrices } from '../../../src/lib/stripe/getPrices';
import '../../../styles/dashboard.css';
import '../../../styles/theme.css';

/**
 * Fallback activity window, in UTC days, for a caller that passes none.
 *
 * The real window is the workspace's `analyticsRetentionDays` (Free 7,
 * Personal 30, Pro 90, Team 365), resolved once in the page component and
 * threaded into every history fetcher below. This constant only keeps those
 * fetchers callable on their own; it is not the product's answer to "how much
 * history do I get". See src/lib/analytics/retention.ts.
 */
const USAGE_WINDOW_DAYS = 30;

/**
 * Meter version the usage RPC counts billable actions under. Nothing
 * customer-facing reads that count any more (the action meter was removed in
 * the 2026-08-19 repricing), but the RPC still takes the argument, and passing
 * a version that disagrees with ACTION_METER_VERSION in the MCP edge function
 * would silently mis-count if the number is ever surfaced again.
 */
const ACTION_METER_VERSION = 1;

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Dashboard · MCP Emails',
  description: 'Manage your MCP Emails inboxes and API keys',
};

/**
 * Derives 1–2 letter initials from a display name or email address.
 * - "Jordan Reyes"  → "JR"
 * - "Jordan"        → "JO"
 * - "jordan@..."    → "J"
 */
function computeInitials(displayName, email) {
  if (displayName && displayName.trim().length > 0) {
    const parts = displayName.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return displayName.slice(0, 2).toUpperCase();
  }
  if (email && email.length > 0) {
    return email[0].toUpperCase();
  }
  return '?';
}

/**
 * Formats a UTC ISO timestamp as a human-readable relative time string.
 * e.g. "just now", "5m ago", "2h ago", "3d ago"
 *
 * @param {string} isoTimestamp
 * @returns {string}
 */
function formatRelativeTime(isoTimestamp) {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return 'yesterday';
  return `${diffDay}d ago`;
}

/**
 * Fetches the last 10 MCP tool calls from activity_log for the given workspace,
 * joined with the inbox's display name / email address.
 * Returns an empty array on any query error so the page always renders.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} workspaceId
 * @returns {Promise<Array<{ id: string, tool: string, account: string, time: string, ok: boolean }>>}
 */
async function fetchActivityFeed(supabase, workspaceId) {
  const { data, error } = await supabase
    .from('activity_log')
    .select('id, tool_name, status, created_at, inboxes(email_address, display_name)')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error || !data) {
    console.error('[fetchActivityFeed]', error?.message);
    return [];
  }

  return data.map((row) => {
    const inbox = row.inboxes;
    // Prefer display_name (e.g. "work-gmail"), fall back to email address, then generic label.
    const account = inbox?.display_name || inbox?.email_address || 'unknown inbox';
    return {
      id: row.id,
      tool: row.tool_name,
      account,
      time: formatRelativeTime(row.created_at),
      ok: row.status === 'success',
    };
  });
}

/**
 * Fetches all non-deleted inboxes for a workspace and their 30-day call counts.
 * Returns a serialisable array safe to pass as props to Client Components.
 * Encrypted credential columns are never selected here.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} workspaceId
 * @returns {Promise<Array<{ id: string, label: string, address: string, provider: string, status: string, lastError: string|null, hasImap: boolean, calls: number, createdAt: string, lastCallAt: string|null }>>}
 */
async function fetchInboxes(supabase, workspaceId, historyDays = USAGE_WINDOW_DAYS) {
  const [{ data: rows, error }, { data: logRows }] = await Promise.all([
    // `send_review_mode` is added by a migration that may land after this
    // code; selectTolerantly re-runs without it rather than blanking the whole
    // inbox list. See src/lib/approvals/columns.ts.
    selectTolerantly(
      ['id', 'display_name', 'email_address', 'provider', 'service', 'status', 'last_error',
        'imap_host', 'imap_port', 'imap_security', 'smtp_host', 'smtp_port', 'smtp_security',
        'imap_username', 'created_at', 'signature_text', 'signature_html', 'signature_enabled',
        'signature_reply_mode', 'signature_source', 'send_approval_required', 'send_review_mode'],
      PENDING_INBOX_COLUMNS,
      (columns) => supabase
        .from('inboxes')
        .select(columns)
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .order('created_at', { ascending: true }),
    ),

    // Per-inbox call count and last successful call, aggregated in Postgres.
    // This used to fetch every activity_log row of the last 30 days and count
    // them here. PostgREST truncates a response at 1,000 rows without an error
    // and the read carried no ORDER BY, so on a busy workspace both numbers
    // came off an arbitrary slice: the count capped at 1,000, and
    // `lastCallByInbox` was the maximum of a random subset, which could show a
    // heavily used inbox as having had no successful call in 30 days.
    supabase.rpc('workspace_inbox_activity', {
      p_workspace_id: workspaceId,
      p_days: historyDays,
    }),
  ]);

  if (error || !rows) {
    console.error('[fetchInboxes]', error?.message);
    return [];
  }

  // Build a call-count map and a last-successful-call map keyed by inbox_id.
  // lastCallByInbox is scoped to the plan's analytics window, matching the
  // call count; older successes read as "no successful calls" for that window.
  const callsByInbox = {};
  const lastCallByInbox = {};
  for (const row of logRows ?? []) {
    if (!row.inbox_id) continue;
    callsByInbox[row.inbox_id] = row.calls ?? 0;
    if (row.last_success_at) lastCallByInbox[row.inbox_id] = row.last_success_at;
  }

  return rows.map((row) => ({
    id: row.id,
    // Use display_name when set; fall back to the local-part of the email address.
    label: row.display_name ?? row.email_address.split('@')[0],
    address: row.email_address,
    // Branded IMAP inboxes (iCloud, Yahoo, Zoho, Yandex) are stored as
    // provider 'imap' with the brand in `service`. Surface the brand so the
    // list shows the real logo/name; generic IMAP stays 'imap'.
    provider:
      row.provider === 'imap' && row.service && row.service !== 'generic'
        ? row.service
        : row.provider,
    status: row.status,
    // Human-readable error shown on errored inboxes; null when healthy.
    lastError: row.last_error ?? null,
    // True when this inbox uses an IMAP app-password path (not OAuth).
    hasImap: !!row.imap_host,
    // IMAP service brand ('generic' for the plain IMAP connector, or
    // 'fastmail'/'icloud'/'yahoo'/'zoho'/'yandex'). Used by the reconnect flow
    // to re-open the SAME connect form this inbox was created with.
    service: row.service ?? null,
    // Connection identity, surfaced so the reconnect form can pre-fill and LOCK
    // these fields — preventing the browser from autofilling another account's
    // saved login into a blank field (the wrong-mailbox bug). Not secret; the
    // password is never exposed. imap_username is the SASL login (may differ
    // from the address, e.g. domeneshop).
    imapHost: row.imap_host ?? null,
    imapPort: row.imap_port ?? null,
    smtpHost: row.smtp_host ?? null,
    smtpPort: row.smtp_port ?? null,
    imapSecurity: row.imap_security ?? (row.imap_port === 143 ? 'starttls' : 'tls'),
    smtpSecurity: row.smtp_security ?? (row.smtp_port === 587 ? 'starttls' : 'tls'),
    username: row.imap_username ?? null,
    calls: callsByInbox[row.id] ?? 0,
    // When the inbox connection was first created.
    createdAt: row.created_at,
    // Most recent successful MCP call (within the 30-day window), or null.
    lastCallAt: lastCallByInbox[row.id] ?? null,
    // Per-inbox signature (Phase 3). The dashboard editor edits the plain-text
    // form; signatureHtml is surfaced only to detect a Gmail-imported value to
    // seed the textarea from when no plain text exists. Source tells the UI
    // whether to show the "imported from Gmail" hint.
    signatureText: row.signature_text ?? null,
    signatureHtml: row.signature_html ?? null,
    signatureEnabled: row.signature_enabled ?? true,
    signatureReplyMode: row.signature_reply_mode ?? 'first_only',
    signatureSource: row.signature_source ?? null,
    sendApprovalRequired: row.send_approval_required ?? false,
    // Three-way review mode (off | inline | dashboard). Falls back to the
    // legacy boolean until every row carries the new column.
    sendReviewMode:
      row.send_review_mode ?? (row.send_approval_required ? 'dashboard' : 'off'),
  }));
}

/**
 * Fetches all active (non-deleted) API keys for a workspace.
 * Returns only the columns safe to display in the dashboard, never key_hash.
 * Ordered newest-first so recently created keys appear at the top of the list.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} workspaceId
 * @returns {Promise<Array<{
 *   id: string,
 *   name: string,
 *   keyPrefix: string,
 *   scopes: string[],
 *   createdAt: string,
 *   lastUsedAt: string | null,
 *   expiresAt: string | null,
 * }>>}
 */
async function fetchApiKeys(supabase, workspaceId) {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, key_prefix, scopes, inbox_ids, created_at, last_used_at, expires_at')
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error || !data) {
    console.error('[fetchApiKeys]', error?.message);
    return [];
  }

  return data.map((row) => ({
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: row.scopes ?? [],
    // null = all inboxes (including any connected later); array = explicit allowlist.
    inboxIds: row.inbox_ids ?? null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
    expiresAt: row.expires_at ?? null,
  }));
}

/**
 * Fetches the four Overview page stat counts for a workspace in parallel.
 * Returns zeros on any query error so the page always renders.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} workspaceId
 * @returns {Promise<{ inboxCount: number, apiKeysCount: number, callsToday: number, callsThisMonth: number }>}
 */
async function fetchOverviewStats(supabase, workspaceId) {
  const now = new Date();
  // Midnight of the current calendar day (UTC)
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ).toISOString();
  // First instant of the current calendar month (UTC)
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  ).toISOString();

  const [
    inboxResult,
    apiKeysResult,
    callsTodayResult,
    callsMonthResult,
  ] = await Promise.all([
    // Active inboxes: status = 'active', not soft-deleted
    supabase
      .from('inboxes')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .is('deleted_at', null),

    // Active API keys: not soft-deleted
    supabase
      .from('api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null),

    // MCP tool calls made today (UTC day)
    supabase
      .from('activity_log')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('created_at', todayStart),

    // MCP tool calls made this calendar month (UTC)
    supabase
      .from('activity_log')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('created_at', monthStart),
  ]);

  return {
    inboxCount: inboxResult.count ?? 0,
    apiKeysCount: apiKeysResult.count ?? 0,
    callsToday: callsTodayResult.count ?? 0,
    callsThisMonth: callsMonthResult.count ?? 0,
  };
}

/**
 * Fetches 30 days of MCP call data for the Usage page.
 * Returns daily counts (oldest first), per-tool breakdown, and per-inbox breakdown.
 * All aggregation is done in JavaScript after a single query so no DB function is needed.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} workspaceId
 * @returns {Promise<{
 *   dailyCounts: Array<{ date: string, count: number }>,
 *   totalCalls: number,
 *   byTool: Array<{ tool: string, count: number, pct: number }>,
 *   byInbox: Array<{ inboxId: string, label: string, address: string, archived: boolean, count: number, pct: number }>,
 * }>}
 */
async function fetchUsageData(supabase, workspaceId, billingWindow, historyDays = USAGE_WINDOW_DAYS) {
  const [summaryResult, inboxesResult] = await Promise.all([
    // Every number on the Usage page, aggregated in Postgres and returned as
    // one jsonb row.
    //
    // This used to be two raw selects counted in Node, and every figure it
    // produced was capped: PostgREST truncates a response at 1,000 rows and
    // reports no error. Measured on production the day this was fixed, the
    // busiest workspace made 33,292 calls in 30 days and this page told its
    // owner 1,000. Neither read carried an ORDER BY either, so the daily chart
    // was drawn from an arbitrary slice rather than from a truncated tail.
    supabase.rpc('workspace_usage_summary', {
      p_workspace_id: workspaceId,
      p_period_start: billingWindow.start,
      p_period_end: billingWindow.end,
      p_days: historyDays,
      p_meter_version: ACTION_METER_VERSION,
    }),
    // Include soft-deleted inboxes here (no deleted_at filter): a call can be
    // attributed to an inbox that was since deleted/revoked, and we still want
    // to show its original label/address (greyed-out) instead of "Unknown
    // inbox" so the usage breakdown stays meaningful.
    supabase
      .from('inboxes')
      .select('id, display_name, email_address, deleted_at')
      .eq('workspace_id', workspaceId),
  ]);

  if (summaryResult.error) {
    console.error('[fetchUsageData]', summaryResult.error.message);
  }

  const summary = summaryResult.data ?? {};

  // Build inbox label lookup: id → { label, address, archived }
  const inboxMap = {};
  for (const ib of inboxesResult.data ?? []) {
    inboxMap[ib.id] = {
      label: ib.display_name ?? ib.email_address.split('@')[0],
      address: ib.email_address,
      // Deleted/revoked inboxes still resolve their original label, but are
      // flagged so the UI can render them as archived.
      archived: !!ib.deleted_at,
    };
  }

  // The RPC returns one entry per UTC day in the window, oldest first, with
  // quiet days already present as zeroes, so there is no date array to rebuild
  // here and no way for the series and the counts to cover different days.
  const dailyCounts = (summary.daily ?? []).map((entry) => ({
    date: entry.date,
    count: entry.count ?? 0,
  }));

  const totalCalls = summary.total_calls ?? 0;

  const byTool = (summary.by_tool ?? []).map((entry) => ({
    tool: entry.tool,
    count: entry.count ?? 0,
    pct: totalCalls > 0 ? Math.round(((entry.count ?? 0) / totalCalls) * 100) : 0,
  }));

  const byInbox = (summary.by_inbox ?? []).map((entry) => {
    const inboxId = entry.inbox_id;
    const inbox = inboxMap[inboxId];
    return {
      inboxId,
      // Resolve the original label even for deleted inboxes. Only a row that
      // was hard-deleted (no soft-delete record at all) falls back to the id.
      label: inbox?.label ?? `Inbox ${String(inboxId).slice(0, 8)}`,
      address: inbox?.address ?? '',
      // True when the inbox was deleted/revoked, or when no row exists at all.
      archived: inbox ? inbox.archived : true,
      count: entry.count ?? 0,
      pct: totalCalls > 0 ? Math.round(((entry.count ?? 0) / totalCalls) * 100) : 0,
    };
  });

  // Billable-action totals and the usage_limit_events rejection count are
  // deliberately not returned. They fed the monthly allowance meter, which was
  // removed when inboxes replaced action volume as the value metric; the
  // rejection count was a second DB round trip serving only that widget.
  return { dailyCounts, totalCalls, byTool, byInbox };
}

/**
 * Fetches the first page (25 rows) of audit log entries for the security page.
 * Returns tool calls from activity_log with joined inbox and api_key display fields.
 * Never fetches encrypted credential columns.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} workspaceId
 * @returns {Promise<{
 *   entries: Array<{
 *     id: string,
 *     tool: string,
 *     inbox: string | null,
 *     apiKeyName: string | null,
 *     apiKeyPrefix: string | null,
 *     status: string,
 *     errorCode: string | null,
 *     durationMs: number | null,
 *     createdAt: string,
 *   }>,
 *   total: number,
 *   page: number,
 *   pageSize: number,
 * }>}
 */
async function fetchAuditLog(supabase, workspaceId) {
  const pageSize = 25;
  // DELIBERATELY UNBOUNDED, unlike the usage analytics above.
  //
  // The analytics retention window was briefly applied here too and then taken
  // back out. An audit log is a SECURITY artifact, not a usage metric: cutting
  // it by price tier means the customers least equipped to detect a compromise
  // keep the least evidence of one, and this product holds mailbox
  // credentials. The industry does not do this either. Where an audit log is
  // offered at all it is gated as a whole feature and then kept generously
  // (Linear 90 days, Vercel 90, 1Password 365, GitHub retains indefinitely and
  // merely defaults the VIEW to three months); the one vendor that scales it
  // down hard by tier, Auth0 at 1-30 days, is publicly complained about for it.
  // Nobody ships a 7-day audit log. Do not re-add a window here without a
  // reason that is about storage, not packaging.

  const [countResult, rowsResult] = await Promise.all([
    supabase
      .from('activity_log')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),
    supabase
      .from('activity_log')
      .select(
        'id, tool_name, status, error_code, duration_ms, created_at, inboxes(email_address, display_name), api_keys(name, key_prefix)',
      )
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .range(0, pageSize - 1),
  ]);

  if (rowsResult.error) {
    console.error('[fetchAuditLog]', rowsResult.error.message);
    return { entries: [], total: 0, page: 0, pageSize };
  }

  const entries = (rowsResult.data ?? []).map((row) => {
    const inbox = row.inboxes;
    const apiKey = row.api_keys;
    return {
      id: row.id,
      tool: row.tool_name,
      inbox: inbox?.display_name ?? inbox?.email_address ?? null,
      apiKeyName: apiKey?.name ?? null,
      apiKeyPrefix: apiKey?.key_prefix ?? null,
      status: row.status,
      errorCode: row.error_code ?? null,
      durationMs: row.duration_ms ?? null,
      createdAt: row.created_at,
    };
  });

  return {
    entries,
    total: countResult.count ?? 0,
    page: 0,
    pageSize,
  };
}

/**
 * Fetches all members of a workspace using the get_workspace_members() SECURITY DEFINER RPC.
 * The RPC bypasses the users_select_own RLS policy so member profiles are visible.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} workspaceId
 * @returns {Promise<Array<{ userId, role, joinedAt, email, displayName, avatarUrl }>>}
 */
async function fetchMembers(supabase, workspaceId) {
  const { data, error } = await supabase.rpc('get_workspace_members', {
    p_workspace_id: workspaceId,
  });
  if (error || !data) {
    console.error('[fetchMembers]', error?.message);
    return [];
  }
  return data.map((row) => ({
    userId:      row.user_id,
    role:        row.role,
    joinedAt:    row.joined_at,
    email:       row.email,
    displayName: row.display_name ?? null,
    avatarUrl:   row.avatar_url  ?? null,
  }));
}

/**
 * Fetches pending (un-accepted, non-expired) workspace invites.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} workspaceId
 * @returns {Promise<Array<{ id, email, role, expiresAt, createdAt }>>}
 */
async function fetchPendingInvites(supabase, workspaceId) {
  // @ts-expect-error: Database types need regenerating after workspace_invites migration
  const { data, error } = await supabase
    .from('workspace_invites')
    .select('id, email, role, expires_at, created_at')
    .eq('workspace_id', workspaceId)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });
  if (error || !data) {
    console.error('[fetchPendingInvites]', error?.message);
    return [];
  }
  return data.map((row) => ({
    id:        row.id,
    email:     row.email,
    role:      row.role,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }));
}

export default async function DashboardPage({ params }) {
  // Optional catch-all: `/dashboard` → section undefined; `/dashboard/inboxes`
  // → section ['inboxes']. Resolve to a valid route id, or 404 on an unknown
  // segment / extra path depth so bad URLs don't silently render the overview.
  const { section } = await params;
  if (Array.isArray(section) && section.length > 1) notFound();
  const initialRoute = pathSegmentToSection(section?.[0]);
  if (initialRoute === null) notFound();

  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  const cookieStore = await cookies();
  const preferredWorkspaceId = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value ?? null;

  const [{ data: userRecord }, { data: workspaceRows }, { data: usageEntitlement }] = await Promise.all([
    supabase
      .from('users')
      .select('display_name, email')
      .eq('id', user.id)
      .single(),
    // RLS-filtered: returns every workspace the user is a member of
    // (their own + any they were invited to). owner_id lets us tell which
    // ones they own (for the Pro "create workspace" gate).
    supabase
      .from('workspaces')
      .select('id, slug, display_name, plan, owner_id, grandfathered, analytics_first_tool_name, analytics_first_tool_provider, analytics_first_tool_client, analytics_first_tool_path, analytics_first_tool_reported_at')
      .is('deleted_at', null)
      .order('created_at', { ascending: true }),
    supabase
      .from('user_usage_entitlements')
      .select('kind, expires_at')
      .eq('user_id', user.id)
      .maybeSingle(),
  ]);

  const allWorkspaces = workspaceRows ?? [];
  // Active workspace: the cookie-selected one if the user still belongs to it,
  // otherwise the earliest-created workspace.
  const workspace =
    allWorkspaces.find((w) => w.id === preferredWorkspaceId) ?? allWorkspaces[0] ?? null;

  // The calling user's role in the ACTIVE workspace (drives role-gated UI).
  let userRole = 'member';
  let effectiveWorkspacePlan = null;
  let storedBillingPeriod = null;
  if (workspace) {
    const [{ data: memberRow }, { data: effectivePlanRows }, { data: billingRow }] = await Promise.all([
      supabase
        .from('workspace_members')
        .select('role')
        .eq('user_id', user.id)
        .eq('workspace_id', workspace.id)
        .maybeSingle(),
      supabase.rpc('effective_workspace_plan', { p_workspace_id: workspace.id }),
      // The owner's Stripe cycle, which is what the action allowance is granted
      // over. Read for the workspace OWNER, not the viewer: a member of someone
      // else's paid workspace must see that workspace's period.
      //
      // Service-role, deliberately. `user_billing_select_own` restricts SELECT
      // to `user_id = auth.uid()`, so reading it with the viewer's client
      // returns null for every member who is not the owner, and the window
      // silently degrades to a calendar month while the edge function (which is
      // service-role) keeps enforcing against the real Stripe period. The meter
      // and the thing that blocks you would then disagree, on a billing
      // surface. Only the two period timestamps are selected, never a Stripe
      // customer or subscription id. /api/usage reads it the same way.
      createServiceRoleClient()
        .from('user_billing')
        .select('current_period_start, current_period_end')
        .eq('user_id', workspace.owner_id)
        .maybeSingle(),
    ]);
    userRole = memberRow?.role ?? 'member';
    effectiveWorkspacePlan = effectivePlanRows?.[0] ?? null;
    storedBillingPeriod = billingRow ?? null;
  }

  // Creating additional workspaces is a Pro feature: the user must OWN at least
  // one Pro/Enterprise workspace. Being an invited member of one does not count.
  const userCompedScale = usageEntitlement?.kind === 'comped_scale' &&
    (!usageEntitlement.expires_at || new Date(usageEntitlement.expires_at) > new Date());
  const canCreateWorkspace = userCompedScale || allWorkspaces.some(
    (w) => w.owner_id === user.id && (w.plan === 'pro' || w.plan === 'enterprise'),
  );

  // Serialisable workspace list for the sidebar switcher.
  const workspaces = allWorkspaces.map((w) => ({
    id: w.id,
    slug: w.slug,
    displayName: w.display_name ?? w.slug,
    plan: w.plan,
    isOwner: w.owner_id === user.id,
  }));

  // Fall back to Supabase Auth fields if the users table row is missing.
  const displayName = userRecord?.display_name ?? user.user_metadata?.full_name ?? '';
  const email = userRecord?.email ?? user.email ?? '';
  const initials = computeInitials(displayName || null, email);
  const workspaceSlug = workspace?.slug ?? 'workspace';
  const compedScale = effectiveWorkspacePlan?.comped_scale ?? false;
  // The 2026-08-19 repricing grandfather: every user who existed before inboxes
  // became a paid limit keeps unlimited connected inboxes, permanently. It has
  // to be read here, not just in the connect routes, or the dashboard would
  // show a grandfathered free account a 1-inbox cap and a scarcity bar for a
  // limit the server would never actually enforce against them.
  const unlimitedInboxes = effectiveWorkspacePlan?.unlimited_inboxes ?? false;
  const plan = effectiveWorkspacePlan?.plan ?? workspace?.plan ?? 'free';
  const billingWindow = resolveUsageBillingWindow(plan, storedBillingPeriod);

  // Resolve plan limits BEFORE the data fetch, because how much analytics
  // history this workspace may see is one of them. Both protections are
  // user-level and must be passed together: `compedScale` grants Team
  // features, `unlimitedInboxes` is the repricing grandfather.
  const rawLimits = resolvePlanLimits(plan, { compedScale, unlimitedInboxes });
  // The window the Usage page, the per-inbox activity counts and the audit log
  // are all bounded by. Free buys 7 days, Personal 30, Pro 90, Team a year;
  // those numbers are published copy, so they are read from the plan rather
  // than hardcoded here. See src/lib/analytics/retention.ts.
  const historyDays = retentionDays(rawLimits);

  // Fetch all page data in parallel; skip if no workspace row exists yet.
  const [overviewStats, activityFeed, inboxes, apiKeys, usageData, auditLog, members, pendingInvites] = workspace
    ? await Promise.all([
        fetchOverviewStats(supabase, workspace.id),
        fetchActivityFeed(supabase, workspace.id),
        fetchInboxes(supabase, workspace.id, historyDays),
        fetchApiKeys(supabase, workspace.id),
        fetchUsageData(supabase, workspace.id, billingWindow, historyDays),
        fetchAuditLog(supabase, workspace.id),
        fetchMembers(supabase, workspace.id),
        fetchPendingInvites(supabase, workspace.id),
      ])
    : [
        { inboxCount: 0, apiKeysCount: 0, callsToday: 0, callsThisMonth: 0 },
        [],
        [],
        [],
        { dailyCounts: [], totalCalls: 0, byTool: [], byInbox: [] },
        { entries: [], total: 0, page: 0, pageSize: 25 },
        [],
        [],
      ];

  // The monthly action ceiling is deliberately NOT passed to the client. It is
  // an abuse guard, not a plan feature, and every customer-facing meter built
  // on it was removed in the 2026-08-19 repricing.
  const planLimits = {
    // null = unlimited. A grandfathered free account lands here too, and the
    // inbox cap UI keys off exactly this null to render nothing at all.
    maxInboxes: rawLimits.maxInboxes === Infinity ? null : rawLimits.maxInboxes,
    maxApiKeys: rawLimits.maxApiKeys === Infinity ? null : rawLimits.maxApiKeys,
    maxMembers: rawLimits.maxMembers === Infinity ? null : rawLimits.maxMembers,
    // Team roles (Admin/Viewer) and additional members are both Team
    // capabilities: Free and Pro are single-seat. The Members UI uses
    // maxMembers for the seat count and this flag to gate role selection.
    teamRolesEnabled: rawLimits.teamRolesEnabled,
    // How many days of history this plan buys. The Usage and Inboxes pages
    // label their figures with it, so the number on screen always matches the
    // window the queries above actually used.
    historyDays,
  };

  // True only when the unlimited inboxes come from the grandfather rather than
  // from the plan the customer is paying for. A Pro subscriber already has
  // unlimited inboxes and does not need to be told they were spared anything.
  const inboxesGrandfathered = unlimitedInboxes && !compedScale && plan === 'free';

  // The single Streamable HTTP MCP endpoint clients connect to.
  const mcpUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com'}/api/mcp`;

  // Live plan prices from Stripe (ISR-cached 1h), so the billing UI never
  // displays hardcoded amounts. Falls back to static cents in plans.ts.
  const stripePrices = await fetchStripePrices();

  return (
    <DashboardApp
      initialRoute={initialRoute}
      user={{ displayName, email, initials, id: user.id }}
      workspace={{
        id: workspace?.id ?? '',
        slug: workspaceSlug,
        plan,
        compedScale,
        displayName: workspace?.display_name ?? workspaceSlug,
        isOwner: workspace?.owner_id === user.id,
      }}
      workspaces={workspaces}
      activeWorkspaceId={workspace?.id ?? ''}
      canCreateWorkspace={canCreateWorkspace}
      mcpUrl={mcpUrl}
      userRole={userRole}
      planLimits={planLimits}
      inboxesGrandfathered={inboxesGrandfathered}
      stripePrices={stripePrices}
      overviewStats={overviewStats}
      activityFeed={activityFeed}
      inboxes={inboxes}
      apiKeys={apiKeys}
      usageData={usageData}
      auditLog={auditLog}
      members={members}
      pendingInvites={pendingInvites}
      firstToolEvent={workspace?.analytics_first_tool_name && !workspace?.analytics_first_tool_reported_at ? { tool_name: workspace.analytics_first_tool_name, provider: workspace.analytics_first_tool_provider ?? 'unknown', client: workspace.analytics_first_tool_client ?? 'unknown', activation_path: workspace.analytics_first_tool_path ?? 'api_key' } : null}
    />
  );
}
