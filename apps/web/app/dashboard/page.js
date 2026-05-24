import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { DashboardApp } from '../../components/dashboard/App';
import '../../styles/dashboard.css';
import '../../styles/theme.css';

export const metadata = {
  title: 'Dashboard · mcpemails',
  description: 'Manage your mcpemails inboxes and API keys',
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

export default async function DashboardPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/login');
  }

  const [{ data: userRecord }, { data: workspace }] = await Promise.all([
    supabase
      .from('users')
      .select('display_name, email')
      .eq('id', user.id)
      .single(),
    supabase
      .from('workspaces')
      .select('id, slug, display_name, plan')
      .eq('owner_id', user.id)
      .single(),
  ]);

  // Fall back to Supabase Auth fields if the users table row is missing.
  const displayName = userRecord?.display_name ?? user.user_metadata?.full_name ?? '';
  const email = userRecord?.email ?? user.email ?? '';
  const initials = computeInitials(displayName || null, email);
  const workspaceSlug = workspace?.slug ?? 'workspace';
  const plan = workspace?.plan ?? 'free';

  // Fetch Overview stat counts; skip if no workspace exists yet (new user).
  const overviewStats = workspace
    ? await fetchOverviewStats(supabase, workspace.id)
    : { inboxCount: 0, apiKeysCount: 0, callsToday: 0, callsThisMonth: 0 };

  return (
    <DashboardApp
      user={{ displayName, email, initials }}
      workspace={{ slug: workspaceSlug, plan }}
      overviewStats={overviewStats}
    />
  );
}
