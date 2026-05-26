import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { DashboardApp } from '../../components/dashboard/App';
import { getPlanLimits } from '../../src/lib/stripe/plans';
import '../../styles/dashboard.css';
import '../../styles/theme.css';

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
 * @returns {Promise<Array<{ id: string, label: string, address: string, provider: string, status: string, calls: number }>>}
 */
async function fetchInboxes(supabase, workspaceId) {
  const [{ data: rows, error }, { data: logRows }] = await Promise.all([
    supabase
      .from('inboxes')
      .select('id, display_name, email_address, provider, status, last_error, imap_host, created_at')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true }),

    // Fetch inbox_id for all activity_log rows in the last 30 days so we can
    // aggregate call counts per inbox without a GROUP BY RPC.
    supabase
      .from('activity_log')
      .select('inbox_id')
      .eq('workspace_id', workspaceId)
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .not('inbox_id', 'is', null),
  ]);

  if (error || !rows) {
    console.error('[fetchInboxes]', error?.message);
    return [];
  }

  // Build a call-count map keyed by inbox_id.
  const callsByInbox = {};
  for (const row of logRows ?? []) {
    if (row.inbox_id) {
      callsByInbox[row.inbox_id] = (callsByInbox[row.inbox_id] ?? 0) + 1;
    }
  }

  return rows.map((row) => ({
    id: row.id,
    // Use display_name when set; fall back to the local-part of the email address.
    label: row.display_name ?? row.email_address.split('@')[0],
    address: row.email_address,
    provider: row.provider,
    status: row.status,
    // Human-readable error shown on errored inboxes; null when healthy.
    lastError: row.last_error ?? null,
    // True when this inbox uses the Fastmail IMAP app-password path (not OAuth).
    // Safe to expose: imap_host is not a secret (always 'imap.fastmail.com').
    hasImap: !!row.imap_host,
    calls: callsByInbox[row.id] ?? 0,
  }));
}

/**
 * Fetches all active (non-deleted) API keys for a workspace.
 * Returns only the columns safe to display in the dashboard — never key_hash.
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
    .select('id, name, key_prefix, scopes, created_at, last_used_at, expires_at')
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
    // Active inboxes — status = 'active', not soft-deleted
    supabase
      .from('inboxes')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .is('deleted_at', null),

    // Active API keys — not soft-deleted
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
 *   byInbox: Array<{ inboxId: string, label: string, address: string, count: number, pct: number }>,
 * }>}
 */
async function fetchUsageData(supabase, workspaceId) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [activityResult, inboxesResult] = await Promise.all([
    supabase
      .from('activity_log')
      .select('tool_name, inbox_id, created_at')
      .eq('workspace_id', workspaceId)
      .gte('created_at', thirtyDaysAgo),
    supabase
      .from('inboxes')
      .select('id, display_name, email_address')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null),
  ]);

  if (activityResult.error) {
    console.error('[fetchUsageData]', activityResult.error.message);
  }

  const rows = activityResult.data ?? [];

  // Build inbox label lookup: id → { label, address }
  const inboxMap = {};
  for (const ib of inboxesResult.data ?? []) {
    inboxMap[ib.id] = {
      label: ib.display_name ?? ib.email_address.split('@')[0],
      address: ib.email_address,
    };
  }

  // Build 30-day date array in UTC, oldest-first (index 0 = 29 days ago, index 29 = today)
  const dates = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    dates.push(d.toISOString().slice(0, 10)); // YYYY-MM-DD
  }

  // Aggregate per-day, per-tool, per-inbox
  const countsByDay = {};
  const countsByTool = {};
  const countsByInbox = {};

  for (const row of rows) {
    // created_at comes back as "2026-05-24 22:38:29+00" — first 10 chars are YYYY-MM-DD
    const day = (row.created_at ?? '').slice(0, 10);
    if (day) countsByDay[day] = (countsByDay[day] ?? 0) + 1;
    if (row.tool_name) countsByTool[row.tool_name] = (countsByTool[row.tool_name] ?? 0) + 1;
    if (row.inbox_id) countsByInbox[row.inbox_id] = (countsByInbox[row.inbox_id] ?? 0) + 1;
  }

  const totalCalls = rows.length;

  const dailyCounts = dates.map((date) => ({
    date,
    count: countsByDay[date] ?? 0,
  }));

  const byTool = Object.entries(countsByTool)
    .map(([tool, count]) => ({
      tool,
      count,
      pct: totalCalls > 0 ? Math.round((count / totalCalls) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  const byInbox = Object.entries(countsByInbox)
    .map(([inboxId, count]) => ({
      inboxId,
      label: inboxMap[inboxId]?.label ?? 'Unknown inbox',
      address: inboxMap[inboxId]?.address ?? '',
      count,
      pct: totalCalls > 0 ? Math.round((count / totalCalls) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);

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
  // @ts-expect-error — Database types need regenerating after workspace_invites migration
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

export default async function DashboardPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  const [{ data: userRecord }, { data: workspace }, { data: memberRow }] = await Promise.all([
    supabase
      .from('users')
      .select('display_name, email')
      .eq('id', user.id)
      .single(),
    // Use the RLS-filtered workspace query so collaborators (non-owners) also see their workspace.
    supabase
      .from('workspaces')
      .select('id, slug, display_name, plan')
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .single(),
    // Fetch the calling user's role in their workspace (needed for role-gated UI).
    supabase
      .from('workspace_members')
      .select('role')
      .eq('user_id', user.id)
      .limit(1)
      .single(),
  ]);

  // Fall back to Supabase Auth fields if the users table row is missing.
  const displayName = userRecord?.display_name ?? user.user_metadata?.full_name ?? '';
  const email = userRecord?.email ?? user.email ?? '';
  const initials = computeInitials(displayName || null, email);
  const workspaceSlug = workspace?.slug ?? 'workspace';
  const plan = workspace?.plan ?? 'free';
  const userRole = memberRow?.role ?? 'member';

  // Fetch all page data in parallel; skip if no workspace row exists yet.
  const [overviewStats, activityFeed, inboxes, apiKeys, usageData, auditLog, members, pendingInvites] = workspace
    ? await Promise.all([
        fetchOverviewStats(supabase, workspace.id),
        fetchActivityFeed(supabase, workspace.id),
        fetchInboxes(supabase, workspace.id),
        fetchApiKeys(supabase, workspace.id),
        fetchUsageData(supabase, workspace.id),
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

  // Resolve plan limits so the dashboard can show usage (e.g. "1 of 1 inboxes")
  // and enforce caps client-side before attempting an OAuth redirect.
  const rawLimits = getPlanLimits(plan);
  const planLimits = {
    maxInboxes: rawLimits.maxInboxes === Infinity ? null : rawLimits.maxInboxes,
    maxDailyBurstCalls: rawLimits.maxDailyBurstCalls === Infinity ? null : rawLimits.maxDailyBurstCalls,
    maxMonthlyToolCalls: rawLimits.maxMonthlyToolCalls === Infinity ? null : rawLimits.maxMonthlyToolCalls,
    maxApiKeys: rawLimits.maxApiKeys === Infinity ? null : rawLimits.maxApiKeys,
    maxMembers: rawLimits.maxMembers === Infinity ? null : rawLimits.maxMembers,
  };

  return (
    <DashboardApp
      user={{ displayName, email, initials, id: user.id }}
      workspace={{ id: workspace?.id ?? '', slug: workspaceSlug, plan }}
      userRole={userRole}
      planLimits={planLimits}
      overviewStats={overviewStats}
      activityFeed={activityFeed}
      inboxes={inboxes}
      apiKeys={apiKeys}
      usageData={usageData}
      auditLog={auditLog}
      members={members}
      pendingInvites={pendingInvites}
    />
  );
}
