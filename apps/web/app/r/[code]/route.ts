import { createServiceRoleClient } from '@/lib/supabase/service';
import { normalizeReferralCode } from '@/lib/referrals/code';
import { referralCookieString, referralsEnabledForOwner } from '@/lib/referrals/server';
import { referralHomePath, referralLandingLocale } from '@/lib/referrals/landing-locale';

/**
 * GET /r/<code>
 *
 * The referral link. Always a 307 to the home page; the only thing that
 * varies is whether the visitor leaves with the `mcpe_ref` cookie.
 *
 *   A live code whose owner has the program on: cookie (the code only,
 *   HttpOnly, SameSite=Lax, Secure on https, 60 days) and `?acq=referral` on
 *   the home page, which files the signup under acquisition source 'referral'
 *   and shows the friend banner.
 *   Anything else (malformed, unknown, disabled, flag off, a lookup error):
 *   the plain home page, no cookie, no banner.
 *
 * The code never reaches the destination URL, so it cannot leak into
 * analytics page views or the Referer of the next request.
 *
 * Locale: an explicit `?lang=<locale>` wins, then the first supported language
 * in Accept-Language, then English at `/`. The site itself never redirects by
 * language (localeDetection is off); this route can, because it is a redirect
 * already and the friend should land on a page they can read.
 *
 * No product_funnel_events row: that table is workspace-keyed and a click has
 * no workspace. One log line, without the code, is the click metric.
 */

export const dynamic = 'force-dynamic';

async function liveCodeOwner(code: string): Promise<string | null> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from('referral_codes')
    .select('user_id, disabled_at')
    .eq('code', code)
    .maybeSingle();
  if (error || !data || data.disabled_at) return null;
  return (await referralsEnabledForOwner(db, data.user_id)) ? data.user_id : null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  const url = new URL(request.url);
  const home = `${url.origin}${referralHomePath(referralLandingLocale(request))}`;
  const { code: raw } = await context.params;
  const code = normalizeReferralCode(raw);

  let owner: string | null = null;
  if (code) {
    try {
      owner = await liveCodeOwner(code);
    } catch (err) {
      console.error('[referrals] /r/ lookup failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log('[referrals] click', { valid: owner !== null });
  if (!code || !owner) {
    return new Response(null, { status: 307, headers: { location: home, 'cache-control': 'no-store' } });
  }

  const headers = new Headers({ location: `${home}?acq=referral`, 'cache-control': 'no-store' });
  headers.append('set-cookie', referralCookieString(code, { secure: url.protocol === 'https:' }));
  return new Response(null, { status: 307, headers });
}
