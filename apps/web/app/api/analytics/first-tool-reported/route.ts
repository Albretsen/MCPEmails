import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  await supabase.from('workspaces').update({ analytics_first_tool_reported_at: new Date().toISOString() }).eq('id', workspaceId).is('analytics_first_tool_reported_at', null);
  return NextResponse.json({ ok: true });
}
