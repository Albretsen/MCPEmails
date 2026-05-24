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

  return (
    <DashboardApp
      user={{ displayName, email, initials }}
      workspace={{ slug: workspaceSlug, plan }}
    />
  );
}
