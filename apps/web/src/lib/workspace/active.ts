import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Name of the cookie that stores the user's currently-selected workspace.
 *
 * A user may belong to several workspaces (their own + any they were invited
 * to). Mutations that need a single target (connecting an inbox, creating an
 * API key) resolve "the active workspace" from this cookie, falling back to
 * the user's first workspace when it is absent or stale.
 */
export const ACTIVE_WORKSPACE_COOKIE = 'mcpe_active_ws';

/**
 * Resolves the workspace a request should act on for the given user.
 *
 * 1. If the active-workspace cookie is set AND the user is still a member of
 *    that workspace, use it.
 * 2. Otherwise fall back to the user's earliest-joined workspace.
 *
 * Returns null only when the user belongs to no workspace at all.
 *
 * NOTE: never use `.single()` on workspace_members for this; a user in 2+
 * workspaces would make it throw. Membership is matched explicitly or the
 * earliest row is taken with `.limit(1)`.
 */
export async function resolveActiveWorkspaceId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  userId: string,
): Promise<string | null> {
  const cookieStore = await cookies();
  const preferred = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value;

  if (preferred) {
    const { data } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', userId)
      .eq('workspace_id', preferred)
      .maybeSingle();
    if (data?.workspace_id) return data.workspace_id;
  }

  const { data: first } = await supabase
    .from('workspace_members')
    .select('workspace_id, joined_at')
    .eq('user_id', userId)
    .order('joined_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  return first?.workspace_id ?? null;
}
