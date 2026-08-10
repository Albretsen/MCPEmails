import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  acquisitionFromParams,
  appendAcquisitionParams,
} from '@/lib/acquisition-context.mjs';

export async function GET(request: Request) {
  const { origin, searchParams } = new URL(request.url);
  const next = searchParams.get('next');

  const callbackUrl = new URL('/auth/callback', origin);
  if (next && next.startsWith('/')) {
    callbackUrl.searchParams.set('next', next);
  }
  if (searchParams.has('acq')) {
    appendAcquisitionParams(callbackUrl.searchParams, acquisitionFromParams(searchParams));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: callbackUrl.toString() },
  });

  if (error || !data.url) {
    return NextResponse.redirect(
      `${origin}/auth/error?reason=${encodeURIComponent(error?.message ?? 'oauth_error')}`
    );
  }

  return NextResponse.redirect(data.url);
}
