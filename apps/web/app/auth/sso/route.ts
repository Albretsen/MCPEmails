import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { ssoRouteForEmail, type SsoLookupRpc } from '@/lib/sso/sign-in';

/**
 * POST /auth/sso  { email, next? }
 *
 * "Sign in with SSO" on the login page. Looks the email's domain up in our
 * verified sso_domains (never Supabase's own domain list), then starts the
 * SAML flow for that connection's provider. Answers JSON rather than a
 * redirect so the email stays out of every URL and the page can show the
 * error inline:
 *
 *   200 { url }                          send the browser there
 *   400 { error: 'invalid_email' }
 *   404 { error: 'sso_not_configured' }  unknown, unverified, disabled or a
 *                                        consumer domain: one generic answer
 *   503 { error: 'sso_unavailable' }     lookup or Supabase failed
 *
 * The PKCE verifier cookie is set on this response by the server client, so
 * the SAML response comes back to /auth/callback like any OAuth sign-in.
 *
 * GET /auth/sso sends the browser to the login page with the SSO form open,
 * for links such as "Your organization requires single sign-on".
 */

export async function GET(request: Request) {
  const { origin } = new URL(request.url);
  return NextResponse.redirect(`${origin}/login?sso=1`);
}

export async function POST(request: Request) {
  const { origin } = new URL(request.url);

  let body: { email?: unknown; next?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_email' }, { status: 400 });
  }

  let route;
  try {
    // Narrow view of rpc() until the migration is applied and the generated
    // Database types know sso_provider_for_domain; bound back to the client.
    const service = createServiceRoleClient();
    const rpc = (service.rpc as unknown as SsoLookupRpc).bind(service);
    route = await ssoRouteForEmail(rpc, body?.email);
  } catch (err) {
    console.error('[auth/sso] domain lookup failed:', err);
    return NextResponse.json({ error: 'sso_unavailable' }, { status: 503 });
  }

  if (!route.sso) {
    if (route.reason === 'invalid_email') {
      return NextResponse.json({ error: 'invalid_email' }, { status: 400 });
    }
    // A consumer domain reads the same as an unknown one.
    return NextResponse.json({ error: 'sso_not_configured' }, { status: 404 });
  }

  const callbackUrl = new URL('/auth/callback', origin);
  const next = typeof body.next === 'string' ? body.next : null;
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')) {
    callbackUrl.searchParams.set('next', next);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithSSO({
    providerId: route.providerId,
    options: { redirectTo: callbackUrl.toString() },
  });

  if (error || !data?.url) {
    console.error('[auth/sso] signInWithSSO failed:', error?.message ?? 'no url');
    return NextResponse.json({ error: 'sso_unavailable' }, { status: 503 });
  }

  return NextResponse.json({ url: data.url });
}
