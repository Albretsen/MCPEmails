import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { expireGrowthCache } from '@/lib/analytics/growth-queries';

/**
 * POST /api/internal/growth-expire
 *
 * Expires the cached growth reads behind /admin/growth and the kiosk. Called
 * by the system-notify edge function when a signup lands, so the board counts
 * it on its next tick instead of up to ten minutes later. Stripe events expire
 * the same cache in-process from the webhook and do not come through here.
 *
 * AUTH. `X-Dispatch-Secret`, constant-time compared against DISPATCH_SECRET,
 * the secret the edge functions and the internal dispatch routes already
 * share. The only thing a caller can do with it here is make the next growth
 * render read the database, so no body and no parameters are accepted.
 */

export const dynamic = 'force-dynamic';

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[growth-expire] DISPATCH_SECRET is not set; refusing every request.');
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(request.headers.get('x-dispatch-secret') ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!authorised(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const reason = request.headers.get('x-growth-reason') ?? '';
  expireGrowthCache(/^[a-z0-9_.:-]{1,60}$/i.test(reason) ? reason : 'internal');
  return NextResponse.json({ expired: true });
}
