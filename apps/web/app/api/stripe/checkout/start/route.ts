import { NextRequest, NextResponse } from 'next/server';
import { runCheckout, type CheckoutReason } from '@/lib/stripe/checkout-core';

/**
 * GET /api/stripe/checkout/start?plan=<planId>&interval=<month|year>
 *
 * The buy button's destination. One request in, a 303 to Stripe out.
 *
 * WHY THIS EXISTS. Every paid CTA used to link to
 * /dashboard/settings?upgrade=<plan>&interval=<i>. That route server-renders
 * the entire dashboard (workspaces, inboxes, usage, effective plan, API keys),
 * ships and hydrates the bundle, and only then does a client effect in
 * BillingSection POST /api/stripe/checkout and assign window.location. Two to
 * three seconds of dead screen at the single highest-intent moment in the
 * product, spent rendering a page the buyer never wanted to look at.
 *
 * This route skips all of it: authenticate, run the shared checkout core,
 * redirect. No React, no dashboard data, no hydration.
 *
 * THE LOGIC IS NOT FORKED. Everything that decides whether this user may be
 * charged (entitlement guards, the purchasable allowlist, price resolution,
 * funnel recording, the in-place price swap) lives in `runCheckout`, shared
 * verbatim with the POST handler. This file only chooses redirect targets.
 *
 * WHY A GET IS SAFE HERE. It creates a Stripe Checkout Session, which charges
 * nothing: it is a hosted page the buyer must still complete. Three properties
 * keep that acceptable:
 *
 *  1. It is authenticated. An unauthenticated hit (a crawler, a link unfurler,
 *     an email scanner, a Slack preview) never reaches the core at all; it gets
 *     a redirect to /login and creates nothing. Prefetch and preview traffic is
 *     unauthenticated by definition, so it cannot manufacture Stripe objects.
 *  2. It is never cached. A 303 whose Location is a one-time Stripe session URL
 *     must not be stored by any browser, CDN or proxy, or two people could land
 *     on one session. Hence `dynamic = 'force-dynamic'` and an explicit
 *     `Cache-Control: private, no-store` on every response.
 *  3. It is not linked with <Link>. The CTAs are plain <a> elements to an API
 *     path, which the Next.js router does not prefetch.
 *
 * The one genuinely non-idempotent thing the core does from a GET is the
 * in-place price swap for an existing subscriber. That is deliberate and
 * pre-existing: it is guarded by `hasEntitledSubscription`, it is a no-op when
 * the price already matches, and Stripe's own proration means a repeat is not a
 * repeat charge. In practice existing subscribers reach checkout through the
 * dashboard's POST path anyway.
 */

/** A Stripe session URL must never be stored by a browser, CDN, or proxy. */
export const dynamic = 'force-dynamic';

/** Where the dashboard reads status back off the URL: BillingSection. */
const DASHBOARD_BILLING_PATH = '/dashboard/settings';

/**
 * A refusal is not a dead end. Each one lands the buyer on the billing screen
 * with a machine-readable reason, which BillingSection translates into a real
 * message. Raw JSON or a blank page at this moment would read as "the product
 * is broken", which is worse than the refusal itself.
 */
function statusRedirect(
  request: NextRequest,
  params: Record<string, string>,
): NextResponse {
  const url = new URL(DASHBOARD_BILLING_PATH, request.nextUrl.origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return noStore(NextResponse.redirect(url, 303));
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const planId = request.nextUrl.searchParams.get('plan');
  const interval = request.nextUrl.searchParams.get('interval') ?? 'month';

  const outcome = await runCheckout({ planId, interval });

  if (outcome.kind === 'checkout') {
    // Straight to Stripe. 303 rather than 302 so the redirect is unambiguously
    // a GET of a different resource.
    return noStore(NextResponse.redirect(outcome.url, 303));
  }

  if (outcome.kind === 'changed') {
    // No hosted page exists for an in-place price swap: the change already
    // happened. Land on billing so the dashboard can confirm what it cost.
    return statusRedirect(request, {
      billing: 'changed',
      plan: outcome.planId,
      interval: outcome.interval,
    });
  }

  const reason: CheckoutReason = outcome.reason;

  if (reason === 'unauthenticated') {
    // The intent must survive sign-in, so the buyer is not dropped on a
    // dashboard having forgotten what they came to buy. `redirect` is the param
    // both /login and the auth middleware already use, and it points back here,
    // so authentication is followed immediately by Stripe.
    const login = new URL('/login', request.nextUrl.origin);
    login.searchParams.set(
      'redirect',
      request.nextUrl.pathname + request.nextUrl.search,
    );
    return noStore(NextResponse.redirect(login, 303));
  }

  return statusRedirect(request, { checkout_error: reason });
}
