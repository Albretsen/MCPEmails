import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { isBrowserAuthorizeStage, recordAuthorizeFunnelOnce } from '@/lib/onboarding/authorize-funnel';

/**
 * POST /api/onboarding/authorize-event  { stage, client? }
 *
 * The consent screen's inbox step reports what happened there:
 * authorize_inbox_step_viewed, authorize_inbox_connected, authorize_skipped.
 * One row per workspace and stage (src/lib/onboarding/authorize-funnel.ts).
 * The workspace always comes from the session, never from the body; `client`
 * is narrowed to a chip id or recorded as 'unknown'.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || !isBrowserAuthorizeStage(body.stage)) {
    return NextResponse.json({ error: 'Invalid stage.' }, { status: 400 });
  }
  const recorded = await recordAuthorizeFunnelOnce(createServiceRoleClient(), {
    workspaceId, stage: body.stage, client: body.client,
  });
  return NextResponse.json({ ok: true, recorded });
}
