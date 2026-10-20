import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  // Service role: the user's own session holds no write privilege on
  // public.workspaces (20261016160100_workspaces_server_owned_writes.sql). The
  // stamp is a server-chosen timestamp. The owner filter keeps the behaviour the
  // old owner-only RLS policy gave this write: only the owner's dashboard marks
  // the first tool call as reported.
  await createServiceRoleClient()
    .from('workspaces')
    .update({ analytics_first_tool_reported_at: new Date().toISOString() })
    .eq('id', workspaceId)
    .eq('owner_id', user.id)
    .is('analytics_first_tool_reported_at', null);
  return NextResponse.json({ ok: true });
}
