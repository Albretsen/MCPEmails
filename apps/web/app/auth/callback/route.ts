import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { acquisitionFromParams, isNewAccountSignup } from '@/lib/acquisition-context.mjs';
import { deviceClassFromHeaders } from '@/lib/acquisition-device.mjs';
import { stampAcquisitionDevice } from '@/lib/acquisition-device-stamp';
import { countryFromHeaders } from '@/lib/acquisition-country.mjs';
import { stampAcquisitionCountry } from '@/lib/acquisition-country-stamp';
import {
  clearConsentCookieString,
  consentVersionFromCookieHeader,
} from '@/lib/marketing-consent.mjs';
import { microsoftSignInRefusal, oauthErrorReason } from '@/lib/auth/microsoft-sign-in';
import { ssoRouteForEmail, isSsoUser, type SsoLookupRpc } from '@/lib/sso/sign-in';
import { completeSsoSignIn, findSsoConnectionVia } from '@/lib/sso/join';
import { addWorkspaceMemberVia } from '@/lib/sso/workspace-member';
import { clientIpFromHeaders, recordSsoAuditVia } from '@/lib/sso/audit';
import { attachReferral } from '@/lib/referrals/attach';
import {
  clearReferralCookieString,
  referralCookieFromHeader,
  referralIpHash,
} from '@/lib/referrals/server';

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
    // A failed OAuth sign-in comes back with `error` and `error_description`
    // instead of a code: the user cancelled, or (Microsoft) their organization
    // requires an admin to approve the app first. Name those; anything else is
    // a malformed or already-used link.
    const reason = oauthErrorReason(searchParams) ?? 'missing_code';
    return NextResponse.redirect(`${origin}/auth/error?reason=${reason}`);
  }

  const supabase = await createClient();
  const { data: exchanged, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // Common causes: code already used, link expired (>60 min), or PKCE
    // verifier mismatch. Surface a clear error page.
    return NextResponse.redirect(
      `${origin}/auth/error?reason=${encodeURIComponent(error.message)}`
    );
  }

  // Sign in with Microsoft: refuse the session unless Microsoft vouches for
  // the email (`xms_edov`). An unverified Entra email claim is an account
  // takeover path, because Supabase links identities by email. Runs before any
  // write below, so a refused sign-in records no consent and no attribution.
  // Scope 'local' ends only this session: if the identity was linked to an
  // existing account, that account's other sessions belong to its owner.
  const refusal = microsoftSignInRefusal(exchanged?.user);
  if (refusal) {
    await supabase.auth.signOut({ scope: 'local' });
    const refused = NextResponse.redirect(`${origin}/auth/error?reason=${refusal}`);
    refused.headers.append(
      'set-cookie',
      clearConsentCookieString({ secure: new URL(request.url).protocol === 'https:' }),
    );
    return refused;
  }

  // SAML SSO: the account has no personal workspace (the new-user trigger
  // skips `sso:` users), so it joins its company's workspace here, on every
  // sign-in, through the team tier's add_workspace_member. Anything that
  // stops the join refuses the session (see src/lib/sso/join.ts). Scope
  // 'local' ends only this session.
  const exchangedUser = exchanged?.user ?? null;
  if (exchangedUser && isSsoUser(exchangedUser)) {
    const service = createServiceRoleClient();
    const rpc = (service.rpc as unknown as SsoLookupRpc).bind(service);
    const sso = await completeSsoSignIn(
      {
        routeForEmail: (email) => ssoRouteForEmail(rpc, email),
        findConnection: findSsoConnectionVia(service),
        addMember: addWorkspaceMemberVia(service),
        audit: recordSsoAuditVia(service),
      },
      exchangedUser,
      {
        ipAddress: clientIpFromHeaders(request.headers),
        userAgent: request.headers.get('user-agent'),
      },
    );
    if (!sso.ok) {
      await supabase.auth.signOut({ scope: 'local' });
      return NextResponse.redirect(`${origin}/auth/error?reason=${sso.reason}`);
    }
  }

  // Marketing consent ticked on the signup page before a Google/GitHub
  // button (see src/lib/marketing-consent.mjs). Read here, cleared below on
  // every outcome, and recorded only for an account this exchange created.
  const consentVersion = consentVersionFromCookieHeader(request.headers.get('cookie'));
  const needsUser = searchParams.has('acq') || consentVersion !== null;
  const user = needsUser ? (await supabase.auth.getUser()).data.user : null;

  if (consentVersion && user && isNewAccountSignup(user.created_at)) {
    try {
      // Service role: the consent columns are not writable by the user's own
      // session (users_marketing_consent_guard). The RPC stamps now() and
      // refuses accounts older than 10 minutes or ones that already consented.
      const { error: consentError } = await createServiceRoleClient().rpc(
        'record_signup_marketing_consent',
        { p_user_id: user.id, p_source: consentVersion },
      );
      if (consentError) {
        console.error('[auth-callback] recording marketing consent failed:', consentError.message);
      }
    } catch (err) {
      // Never block a sign-in on this. A missed record means no marketing
      // email, which is the safe direction.
      console.error('[auth-callback] recording marketing consent failed:', err);
    }
  }

  if (searchParams.has('acq')) {
    // The login page also carries acquisition params, because a first OAuth
    // login creates the account. That means this callback now runs for
    // returning users too, and an account predating attribution still has a
    // NULL source: without this check their next login would be stamped with
    // today's landing page instead of their real first touch. Only stamp an
    // account this exchange just created.
    if (user && isNewAccountSignup(user.created_at)) {
      // Service role: the user's own session cannot write public.workspaces at
      // all (20261016160100_workspaces_server_owned_writes.sql), so a signed-in
      // user can never set attribution, plan or billing columns themselves.
      // The owner filter below is what scopes the write to this account.
      const service = createServiceRoleClient();
      // First-touch only: never overwrite a previously attributed workspace.
      await service
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

      // Phone, tablet or desktop, from the headers of THIS request: the
      // provider redirected the user's own browser here, so it is the one
      // request in an OAuth signup that carries the real User-Agent (the
      // session is created server-side, and auth.sessions records `node`).
      // Only the class is kept. A statement of its own, so the attribution
      // write above cannot fail on this column before its migration is
      // applied. It filters on its own NULL and never throws.
      await stampAcquisitionDevice(service, {
        ownerId: user.id,
        device: deviceClassFromHeaders(request.headers),
      });

      // The country, from Vercel's x-vercel-ip-country on this same request,
      // for the same reason: it is the user's own browser, so the code places
      // the person, not a server. Only the two letters are kept, never the IP.
      // Its own statement, first write wins, never throws.
      await stampAcquisitionCountry(service, {
        ownerId: user.id,
        country: countryFromHeaders(request.headers),
      });
    }
  }

  // Referral link opened in this browser (app/r/[code]/route.ts). Attached
  // once, here, and the cookie is cleared below on every outcome, so a later
  // login on a shared computer cannot attach someone else. attachReferral
  // applies every rule (new account, no paid history, not the same person);
  // nothing it does, throws or refuses may change where this login goes.
  const referralCode = referralCookieFromHeader(request.headers.get('cookie'));
  if (referralCode && exchangedUser) {
    try {
      // Loaded here, not at module scope: the Stripe client throws at import
      // without STRIPE_SECRET_KEY, and that must never take the callback down.
      const { stripe } = await import('@/lib/stripe/client');
      await attachReferral(createServiceRoleClient(), stripe, {
        code: referralCode,
        friend: exchangedUser,
        via: 'cookie',
        ipHash: referralIpHash(clientIpFromHeaders(request.headers)),
      });
    } catch (err) {
      console.error('[auth-callback] referral attach failed:', err instanceof Error ? err.message : String(err));
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
  const response = NextResponse.redirect(`${origin}${redirectPath}`);
  if (consentVersion) {
    response.headers.append(
      'set-cookie',
      clearConsentCookieString({ secure: new URL(request.url).protocol === 'https:' }),
    );
  }
  if (referralCode !== null) {
    response.headers.append(
      'set-cookie',
      clearReferralCookieString({ secure: new URL(request.url).protocol === 'https:' }),
    );
  }
  return response;
}
