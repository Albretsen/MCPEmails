import { NextRequest, NextResponse } from 'next/server';

import { createServiceRoleClient } from '@/lib/supabase/service';
import { stripe } from '@/lib/stripe/client';
import { runCheckoutForIdentity, type CheckoutReason } from '@/lib/stripe/checkout-core';
import {
  CHECKOUT_LINK_SESSION_TTL_SECONDS,
  checkoutLinkLocale,
  checkoutLinkTokenHash,
  isCheckoutLinkToken,
} from '@/lib/stripe/checkout-link';
import { recordChatLinkOpened } from '@/lib/analytics/billing-funnel';

/**
 * GET /u/<token>
 *
 * The chat checkout link. When a Free workspace hits the monthly action cap
 * inside a chat, the refusal can carry this URL (minted by the edge function,
 * see src/lib/stripe/checkout-link.ts). Opening it goes straight to Stripe
 * Checkout for Personal monthly, for the workspace OWNER, with no sign-in.
 *
 * WHAT IT CAN DO, AND NOTHING ELSE. Redirect to a Stripe Checkout Session. It
 * never sets a cookie, never creates a Supabase session, never renders a byte
 * of workspace data, and never reaches the in-place price swap (it enters the
 * core through `runCheckoutForIdentity`, which refuses an existing subscriber
 * before the subscription is read). The proxy does not run on this path at all
 * (see the matcher in proxy.ts), so no visitor-id or session cookie can be
 * added on the way out either.
 *
 * REUSE, NOT SINGLE USE. The first open creates the session and stores its id;
 * every later open while the link is live goes to that same session. A link
 * unfurler, a prefetch or a second tab therefore cannot burn the link or create
 * a second session. Two opens racing on the very first request each create a
 * session, and `checkout_link_attach_session` keeps the first writer's: the
 * loser redirects to the winner's session and its own simply expires unused.
 *
 * NO EXISTENCE ORACLE. A malformed, unknown, expired or already used token all
 * end on the same /upgrade/expired page. The shape check runs before any
 * database call, so junk never costs a query.
 *
 * ACCEPTED RISK (plan, "Token"). The URL is a bearer link in a chat transcript:
 * whoever holds it can open a checkout that pays for this workspace's owner and
 * sees the owner's email prefilled by Stripe. It is minted only on a refused
 * call and lives 30 minutes.
 */

/** A Stripe session URL must never be stored by a browser, CDN, or proxy. */
export const dynamic = 'force-dynamic';

/** Every response, redirect or not, carries these. */
function finish(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  // The token is in this URL; Stripe (or anything after it) must not see it.
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

function redirectTo(url: string | URL): NextResponse {
  return finish(NextResponse.redirect(url, 303));
}

function toExpired(request: NextRequest, reason?: 'subscribed' | 'error'): NextResponse {
  const url = new URL('/upgrade/expired', request.nextUrl.origin);
  if (reason) url.searchParams.set('reason', reason);
  return redirectTo(url);
}

/**
 * The refusals that mean "this owner already has a plan". Everything else the
 * core can refuse with is our problem, not theirs, and reads as an error.
 */
const SUBSCRIBED_REASONS: ReadonlySet<CheckoutReason> = new Set([
  'subscription_exists',
  'comped',
  'plan_not_self_service',
  'already_on_plan_interval',
]);

/**
 * Send the visitor to the session a previous open stored. Never creates one:
 * a link gets one session, and when that one is over, so is the link.
 */
async function toStoredSession(request: NextRequest, sessionId: string): Promise<NextResponse> {
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === 'open' && session.url) return redirectTo(session.url);
    if (session.status === 'complete') {
      const done = new URL('/upgrade/done', request.nextUrl.origin);
      done.searchParams.set('session_id', session.id);
      return redirectTo(done);
    }
    return toExpired(request);
  } catch (err) {
    console.error(
      '[checkout-link] stored session retrieve failed:',
      err instanceof Error ? err.message : String(err),
    );
    return toExpired(request, 'error');
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await context.params;
  if (!isCheckoutLinkToken(token)) return toExpired(request);

  try {
    const db = createServiceRoleClient();
    const { data, error } = await db.rpc('checkout_link_open', {
      p_token_hash: checkoutLinkTokenHash(token),
    });
    if (error) {
      console.error('[checkout-link] open failed:', error.message);
      return toExpired(request, 'error');
    }
    const link = data?.[0];
    if (!link) return toExpired(request);

    // `first_open` is true on exactly one request per link (the one that set
    // first_opened_at), so this is one row per link however often it is hit.
    if (link.first_open) await recordChatLinkOpened(link.workspace_id);

    if (link.stripe_session_id) return toStoredSession(request, link.stripe_session_id);
    if (link.completed_at) return toExpired(request);

    // ── Who is buying: the link's owner, resolved here, never from the visitor.
    // The owner must still own this workspace; a transferred or deleted one
    // ends the link like an expiry would.
    const [{ data: workspace, error: wsError }, owner] = await Promise.all([
      db
        .from('workspaces')
        .select('id, display_name, acquisition_locale')
        .eq('id', link.workspace_id)
        .eq('owner_id', link.owner_user_id)
        .is('deleted_at', null)
        .maybeSingle(),
      db.auth.admin.getUserById(link.owner_user_id),
    ]);
    if (wsError) console.error('[checkout-link] workspace lookup failed:', wsError.message);
    if (owner.error) console.error('[checkout-link] owner lookup failed:', owner.error.message);
    const email = owner.data?.user?.email;
    if (!workspace || !email) return toExpired(request);

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;
    const sessionExpiresAt = Math.floor(Date.now() / 1000) + CHECKOUT_LINK_SESSION_TTL_SECONDS;

    const outcome = await runCheckoutForIdentity(
      {
        userId: link.owner_user_id,
        email,
        workspaceId: workspace.id,
        displayName: workspace.display_name,
      },
      {
        // From the row, and validated again by the core's allowlist. The
        // table's CHECK constraints pin both to Personal monthly today.
        planId: link.plan_id,
        interval: link.billing_interval,
        locale: checkoutLinkLocale(
          workspace.acquisition_locale,
          request.headers.get('accept-language'),
        ),
      },
      {
        // Stripe substitutes the real id for the literal placeholder.
        successUrl: `${appUrl}/upgrade/done?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${appUrl}/pricing?from=chat_link`,
        entryPoint: 'chat_link',
        extraMetadata: { checkout_link_id: link.id },
        sessionExpiresAt,
      },
    );

    if (outcome.kind !== 'checkout') {
      const reason =
        outcome.kind === 'error' && SUBSCRIBED_REASONS.has(outcome.reason)
          ? 'subscribed'
          : 'error';
      return toExpired(request, reason);
    }

    const { data: stored, error: attachError } = await db.rpc('checkout_link_attach_session', {
      p_id: link.id,
      p_session_id: outcome.sessionId,
      p_session_expires_at: new Date(sessionExpiresAt * 1000).toISOString(),
    });
    if (attachError) {
      // The session we just made is valid; send them to it. A later open will
      // find no stored id and make another, which is the lesser problem.
      console.error('[checkout-link] attach failed:', attachError.message);
      return redirectTo(outcome.url);
    }
    if (stored && stored !== outcome.sessionId) return toStoredSession(request, stored);
    return redirectTo(outcome.url);
  } catch (err) {
    console.error(
      '[checkout-link] redeem failed:',
      err instanceof Error ? err.message : String(err),
    );
    return toExpired(request, 'error');
  }
}
