/**
 * GET /api/geo: which currency this visitor's prices are shown in.
 *
 * WHY A ROUTE AND NOT A COOKIE. /pricing and the home page are static and
 * CDN-cached, so the server cannot pick the currency per visitor without making
 * them dynamic. The page renders USD, and the browser asks this route once.
 * A country cookie set by proxy.ts would have done the same, but it would need
 * its own line in the privacy policy; a response nobody stores does not.
 *
 * WHAT IT ANSWERS. `{ country, eur }`. `country` is Vercel's
 * `x-vercel-ip-country` code through the same sanitizer signups use (two
 * letters or null; the IP itself is never read). `eur` is true only when EUR
 * prices are on right now AND the country is in the EU. "On" is the same
 * answer checkout gets (eur-launch.ts): STRIPE_EUR_PRICES, or the automatic
 * launch once it has completed, and never under STRIPE_FORCE_USD. The page
 * calls this when the server rendered it with EUR on, or, from the launch
 * date, because the browser's clock says so (a static page built before the
 * launch still learns of it). Before the date nothing calls it unless the
 * env switch is on, and it reads no database before the date either.
 *
 * Never cached anywhere: the answer differs per visitor, so a shared cache
 * would hand one country's currency to everyone behind it.
 */
import { NextResponse } from 'next/server';
import { countryFromHeaders } from '@/lib/acquisition-country.mjs';
import { isEuCountry } from '@/lib/stripe/eur-prices';
import { eurDisplayEnabled } from '@/lib/stripe/eur-launch';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const country = countryFromHeaders(request.headers);
  const eur = isEuCountry(country) && (await eurDisplayEnabled());
  return NextResponse.json(
    { country, eur },
    { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
  );
}
