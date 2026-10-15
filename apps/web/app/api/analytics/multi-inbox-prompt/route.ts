import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { primaryWorkspaceId } from '@/lib/analytics/billing-funnel';
import { parseMultiInboxPromptAction, recordMultiInboxPrompt } from '@/lib/analytics/multi-inbox-prompt';

/**
 * POST /api/analytics/multi-inbox-prompt   body: {"action": "shown" | "clicked"}
 *
 * Beacon for the dashboard's second-work-mailbox invitation (`shown` means it
 * was in the viewport, not merely rendered). Same contract as
 * /api/analytics/paywall: authenticated only, the workspace and plan resolved
 * on the server, nothing the browser sends is stored except which of two
 * closed-list actions happened, and always 204 so a beacon can never surface
 * an error on the page.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const noContent = new NextResponse(null, { status: 204 });
  try {
    const body = await request.json().catch(() => null);
    const action = parseMultiInboxPromptAction(body?.action);
    if (!action) return noContent;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return noContent;

    await recordMultiInboxPrompt(
      createServiceRoleClient(),
      await primaryWorkspaceId(supabase, user.id),
      action,
    );
  } catch (err) {
    console.error('[multi-inbox-prompt] record failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return noContent;
}
