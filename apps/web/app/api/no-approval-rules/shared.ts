import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';

/**
 * Who is asking. `auth` is the person's own session client, and it is the one that
 * writes: the write functions check auth.uid() in the database and refuse the
 * service role, so a write can not happen without a signed-in owner or admin. `db`
 * (service role) only reads.
 */
export async function noApprovalContext() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return null;
  const workspaceId = await resolveActiveWorkspaceId(auth, user.id);
  if (!workspaceId) return null;
  const db = createServiceRoleClient();
  const { data: membership } = await db
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle();
  return membership ? { user, workspaceId, role: membership.role, auth, db } : null;
}
