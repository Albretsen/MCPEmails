import { NextRequest, NextResponse } from 'next/server';

import { checkoutSessionIdOrNull } from '@/lib/email/abandoned-checkout';
import { checkoutLinkStatus } from '@/lib/stripe/checkout-link';

/**
 * GET /api/upgrade/status?session_id=cs_...
 *
 * Polled by /upgrade/done while a chat-link purchase waits for the Stripe
 * webhook to move the workspace onto Personal. Public (the buyer was never
 * signed in), so it answers ONE bit, `{ active: boolean }`, and nothing else:
 * no email, no name, no plan, no amount, and the same `false` for a session
 * that does not exist, belongs to another checkout, or is simply not active
 * yet. Only sessions created by a chat checkout link can ever read `true`
 * (checkoutLinkStatus checks the session against its checkout_links row).
 */

export const dynamic = 'force-dynamic';

function answer(active: boolean, status = 200): NextResponse {
  return NextResponse.json(
    { active },
    {
      status,
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    },
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sessionId = checkoutSessionIdOrNull(request.nextUrl.searchParams.get('session_id'));
  if (!sessionId) return answer(false, 400);
  return answer((await checkoutLinkStatus(sessionId)) === 'active');
}
