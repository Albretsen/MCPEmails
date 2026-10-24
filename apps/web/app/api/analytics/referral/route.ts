import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { primaryWorkspaceId } from '@/lib/analytics/billing-funnel';
import { parseReferralLinkAction, recordReferralLinkEvent } from '@/lib/analytics/referral-link';

/**
 * POST /api/analytics/referral   body: {"action": "viewed" | "copied"}
 *
 * Beacon for the dashboard's Invite page (referral_link_viewed and
 * referral_link_copied). Same contract as /api/analytics/multi-inbox-prompt:
 * authenticated only, the workspace and plan resolved on the server, nothing
 * the browser sends is stored except which of two closed-list actions
 * happened, and always 204 so a beacon can never surface an error on the page.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const noContent = new NextResponse(null, { status: 204 });
  try {
    const body = await request.json().catch(() => null);
    const action = parseReferralLinkAction(body?.action);
    if (!action) return noContent;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return noContent;

    await recordReferralLinkEvent(
      createServiceRoleClient(),
      await primaryWorkspaceId(supabase, user.id),
      action,
    );
  } catch (err) {
    console.error('[referral-link] record failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return noContent;
}
