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
 * letters or null; the IP itself is never read). `eur` is true only when the
 * STRIPE_EUR_PRICES switch is on right now AND the country is in the EU. The
 * page also only calls this when the server rendered it with the switch on, so
 * with the switch off nobody calls it at all.
 *
 * Never cached anywhere: the answer differs per visitor, so a shared cache
 * would hand one country's currency to everyone behind it.
 */
import { NextResponse } from 'next/server';
import { countryFromHeaders } from '@/lib/acquisition-country.mjs';
import { eurPricesEnabled, isEuCountry } from '@/lib/stripe/eur-prices';

export const dynamic = 'force-dynamic';

export function GET(request: Request): NextResponse {
  const country = countryFromHeaders(request.headers);
  const eur = eurPricesEnabled() && isEuCountry(country);
  return NextResponse.json(
    { country, eur },
    { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
  );
}
