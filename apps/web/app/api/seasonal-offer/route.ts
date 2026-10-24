/**
 * GET /api/seasonal-offer: the live seasonal first-year offers (Black Week
 * 2026), for the prerendered /pricing page.
 *
 * WHY AN ENDPOINT. /pricing is statically generated and CDN cached, and its
 * HTML must not change for the offer (no retitle, no new JSON-LD, nothing a
 * crawler reads differently for five days). So the page renders without the
 * offer and asks here after mount. The answer flips at the window boundaries
 * by itself: the window is evaluated on every call and the Stripe facts behind
 * it are cached for at most 60 seconds (seasonal-offer-server.ts), so no
 * deploy is needed to start or stop it.
 *
 * Not personal: the same answer for every visitor, so it may be cached at the
 * edge for a minute. The page also hides an offer once its `endsAt` has passed
 * on the visitor's clock, so a cached copy cannot outlive the window.
 *
 * Answers `{ offers: {} }` outside the window, on any Stripe error and when
 * the coupon is killed. Never 500s.
 */

import { NextResponse } from 'next/server';
import { getActiveSeasonalOffers } from '@/lib/stripe/seasonal-offer-server';

// Never prerendered: a build-time answer would freeze the window at deploy.
export const dynamic = 'force-dynamic';

export async function GET() {
  const offers = await getActiveSeasonalOffers();
  return NextResponse.json(
    { offers },
    {
      headers: {
        'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=30',
      },
    },
  );
}
