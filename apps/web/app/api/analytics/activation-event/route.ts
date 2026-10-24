import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { handleActivationEventRequest } from '@/lib/analytics/activation-events';

/**
 * POST /api/analytics/activation-event
 * body: {"stage": "connect_fix_shown" | "connect_fix_link_clicked" | "first_call_prompt_copied" | "waiting_state_shown",
 *        "provider"?, "client"?, "auth_reason"?, "phase"?}
 *
 * The dashboard's activation-rescue beacons (lib/analytics/activation-events.ts,
 * browser helper lib/analytics/record-activation-event.ts). Authenticated only;
 * the workspace is the session's active workspace with its membership checked,
 * never a value from the body. Only the four stages above are accepted, each
 * field from a closed list. Other methods get Next's 405.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => null);
    const supabase = await createClient();
    const status = await handleActivationEventRequest(body, {
      userId: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
      workspaceId: (userId) => resolveActiveWorkspaceId(supabase, userId),
      db: createServiceRoleClient,
    });
    return status === 204
      ? new NextResponse(null, { status })
      : NextResponse.json({ error: 'Not recorded.' }, { status });
  } catch (err) {
    console.error('[activation-event] record failed', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Not recorded.' }, { status: 500 });
  }
}
