import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  acquisitionFromParams,
  appendAcquisitionParams,
} from '@/lib/acquisition-context.mjs';
import { ssoRequiredRedirect } from '@/lib/sso/oauth-start-guard';

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
    provider: 'google',
    options: {
      redirectTo: callbackUrl.toString(),
      // Always show Google's account chooser. Without it Google silently reuses
      // whichever account the browser or phone is signed in to, and a second
      // Google address quietly becomes a second, empty MCPEmails account.
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
