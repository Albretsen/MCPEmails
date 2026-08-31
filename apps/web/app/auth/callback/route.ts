import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { acquisitionFromParams, isNewAccountSignup } from '@/lib/acquisition-context.mjs';

// ---------------------------------------------------------------------------
// Route config
// ---------------------------------------------------------------------------

/**
 * The Supabase code-for-session exchange is an outbound call plus a
 * handful of database writes; 15s is generous but bounded.
 *
 * Declared here rather than in a `functions` block in vercel.json: the Vercel
 * project's Root Directory is apps/web, so a repo-root vercel.json is never
 * loaded and its maxDuration values silently do nothing.
 */
export const maxDuration = 15;

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
  const acquisition = acquisitionFromParams(searchParams);

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

  if (searchParams.has('acq')) {
    const { data: { user } } = await supabase.auth.getUser();
    // The login page also carries acquisition params, because a first OAuth
    // login creates the account. That means this callback now runs for
    // returning users too, and an account predating attribution still has a
    // NULL source: without this check their next login would be stamped with
    // today's landing page instead of their real first touch. Only stamp an
    // account this exchange just created.
    if (user && isNewAccountSignup(user.created_at)) {
      // First-touch only: never overwrite a previously attributed workspace.
      await supabase
        .from('workspaces')
        .update({
          acquisition_source: acquisition.source,
          acquisition_landing: acquisition.landing,
          acquisition_landing_path: acquisition.landingPath,
          acquisition_locale: acquisition.locale,
          acquisition_referrer: acquisition.referrer,
          acquisition_utm_source: acquisition.utmSource,
          acquisition_utm_medium: acquisition.utmMedium,
          acquisition_utm_campaign: acquisition.utmCampaign,
        })
        .eq('owner_id', user.id)
        .is('acquisition_source', null);
    }
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
