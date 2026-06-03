import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * GET /auth/callback
 *
 * Supabase redirects here after a user clicks a magic link or completes
 * an OAuth flow. The `code` query parameter contains a PKCE authorization
 * code that must be exchanged for a session.
 *
 * On success: writes session cookies and redirects to /dashboard (or the
 *   `next` query param if present, to support "redirect back after login").
 * On failure: redirects to /auth/error so the user sees a clear message
 *   rather than a blank page or raw JSON.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);

  const code = searchParams.get('code');
  // `next` lets the middleware preserve the originally-requested URL.
  const next = searchParams.get('next') ?? '/dashboard';

  if (!code) {
    // No code means the link was malformed or already used.
    return NextResponse.redirect(`${origin}/auth/error?reason=missing_code`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // Common causes: code already used, link expired (>60 min), or PKCE
    // verifier mismatch. Surface a clear error page.
    return NextResponse.redirect(
      `${origin}/auth/error?reason=${encodeURIComponent(error.message)}`
    );
  }

  // Session cookies are now written. Redirect to the dashboard (or the
  // originally-requested path stored in the `next` param).
  // Only allow same-origin relative `next` paths to prevent open-redirect
  // attacks. A protocol-relative URL like `//evil.com` (or `/\evil.com`)
  // passes a bare startsWith('/') check but resolves to an external origin.
  const isSafeNext =
    next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\');
  const redirectPath = isSafeNext ? next : '/dashboard';
  return NextResponse.redirect(`${origin}${redirectPath}`);
}
