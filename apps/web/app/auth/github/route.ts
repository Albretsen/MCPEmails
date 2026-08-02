import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const { origin, searchParams } = new URL(request.url);
  const next = searchParams.get('next');
  const acquisition = searchParams.get('acq');
  const landing = searchParams.get('landing');

  const callbackUrl = new URL('/auth/callback', origin);
  if (next && next.startsWith('/')) {
    callbackUrl.searchParams.set('next', next);
  }
  if (acquisition) callbackUrl.searchParams.set('acq', acquisition);
  if (landing) callbackUrl.searchParams.set('landing', landing);

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
