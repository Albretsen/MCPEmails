import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { primaryWorkspaceId } from '@/lib/analytics/billing-funnel';
import { parseCheckoutFeedback, recordCheckoutFeedback } from '@/lib/analytics/checkout-feedback';

/**
 * POST /api/analytics/checkout-feedback
 *
 * Stores the answer to the "what stopped you?" card the dashboard shows on
 * return from a cancelled Stripe checkout. Body: `{ reason, detail? }`.
 *
 * Scope and privacy:
 *   - Authenticated only. The workspace is resolved server-side the same way
 *     the checkout route resolves it, so an answer lands on the workspace whose
 *     `checkout_started` it explains.
 *   - `reason` must be one of the fixed answers. `detail` is kept only for
 *     `other`, trimmed and capped at 500 characters. Nothing else in the body
 *     is read.
 *
 * Always returns 204, like the other analytics beacons: the card says thanks
 * either way, and a failed write must never look like a broken dashboard.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const noContent = new NextResponse(null, { status: 204 });

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return noContent;

    const feedback = parseCheckoutFeedback(await request.json().catch(() => null));
    if (!feedback) return noContent;

    const workspaceId = await primaryWorkspaceId(supabase, user.id);
    if (!workspaceId) return noContent;

    await recordCheckoutFeedback(createServiceRoleClient(), { workspaceId, userId: user.id, feedback });
  } catch (err) {
    console.error('[checkout-feedback] record failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return noContent;
}
