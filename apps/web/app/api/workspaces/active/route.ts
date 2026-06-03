import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { ACTIVE_WORKSPACE_COOKIE } from '@/lib/workspace/active';

/**
 * POST /api/workspaces/active
 *
 * Sets the caller's active workspace (stored in an httpOnly cookie) after
 * verifying they are a member of it. Subsequent dashboard loads and mutations
 * (inbox connect, key creation) resolve against this cookie.
 *
 * Body: { workspaceId: string }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }

  const { workspaceId } = body as Record<string, unknown>;
  if (typeof workspaceId !== 'string' || !workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required.' }, { status: 400 });
  }

  // Verify membership before trusting the requested workspace.
  const { data: member } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (!member) {
    return NextResponse.json({ error: 'Workspace not found or access denied.' }, { status: 403 });
  }

  const res = NextResponse.json({ ok: true, workspaceId });
  res.cookies.set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
