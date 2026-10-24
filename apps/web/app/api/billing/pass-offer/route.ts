import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { evaluatePassOffer, isPassOfferSurface } from '@/lib/billing/pass-offer';

/**
 * POST /api/billing/pass-offer
 *
 * Asked by a dashboard surface right before it would render the 3-month
 * Personal pass line. Body: `{ surface, workspaceId }`, surface one of
 * checkout_return | cap_banner | pass_reminder.
 *
 * Answers `{ show, arm, endsAt }`. Everything is decided server-side in
 * evaluatePassOffer (src/lib/billing/pass-offer.ts): the kill switch, the
 * viewer owning a Free workspace with no subscription, comp or pass, the
 * 72-hour cap rule for cap_banner, the holdout arm (assigned here on the
 * first eligible render), and one `pass_offer_shown` row per workspace,
 * surface and day when the answer is yes.
 *
 * A POST because it can write (the assignment, the shown row). Never cached.
 * Any failure, an unauthenticated caller or a bad body answers show: false,
 * so the surface renders exactly what it rendered before the pass existed.
 */
export const dynamic = 'force-dynamic';

const HIDDEN = { show: false, arm: null, endsAt: null };

function noStore(body: unknown): NextResponse {
  const response = NextResponse.json(body, { status: 200 });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return noStore(HIDDEN);

    const body = (await request.json().catch(() => null)) as { surface?: unknown; workspaceId?: unknown } | null;
    const surface = body?.surface;
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : null;
    // paywall_email_3 is a server-side surface; a browser never asks for it.
    if (!isPassOfferSurface(surface) || surface === 'paywall_email_3' || !workspaceId) {
      return noStore(HIDDEN);
    }

    return noStore(await evaluatePassOffer({ userId: user.id, workspaceId, surface }));
  } catch (err) {
    console.error('[pass-offer] route failed', { error: err instanceof Error ? err.message : String(err) });
    return noStore(HIDDEN);
  }
}
