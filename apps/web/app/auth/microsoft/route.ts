import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  acquisitionFromParams,
  appendAcquisitionParams,
} from '@/lib/acquisition-context.mjs';
import { ssoRequiredRedirect } from '@/lib/sso/oauth-start-guard';

/**
 * GET /auth/microsoft
 *
 * Sign in with Microsoft (work, school and personal accounts) through the
 * Supabase `azure` provider. Same shape as /auth/google: `next` and the
 * acquisition params ride on the callback URL.
 *
 * Scopes stay at openid, email and profile: this is sign-in only, never
 * mailbox access (that is /auth/outlook). /auth/callback refuses the session
 * unless Microsoft vouches for the email (see src/lib/auth/microsoft-sign-in.ts).
 */
export async function GET(request: Request) {
  const { origin, searchParams } = new URL(request.url);
  const next = searchParams.get('next');

  // A company that enforces SSO refuses this sign-in in the Supabase auth
  // hook anyway; with the typed address we can say so before the detour.
  const ssoRedirect = await ssoRequiredRedirect(origin, searchParams);
  if (ssoRedirect) return NextResponse.redirect(ssoRedirect);

  const callbackUrl = new URL('/auth/callback', origin);
  if (next && next.startsWith('/')) {
    callbackUrl.searchParams.set('next', next);
  }
  if (searchParams.has('acq')) {
    appendAcquisitionParams(callbackUrl.searchParams, acquisitionFromParams(searchParams));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'azure',
    options: {
      redirectTo: callbackUrl.toString(),
      scopes: 'openid email profile',
      // Always show the account picker: people on a shared or work machine are
      // often signed in to Microsoft as someone else.
      queryParams: { prompt: 'select_account' },
    },
  });

  if (error || !data.url) {
    return NextResponse.redirect(
      `${origin}/auth/error?reason=${encodeURIComponent(error?.message ?? 'oauth_error')}`
    );
  }

  return NextResponse.redirect(data.url);
}
