import { NextRequest, NextResponse } from 'next/server';
import { runCheckout } from '@/lib/stripe/checkout-core';

/**
 * POST /api/stripe/checkout
 *
 * Creates a Stripe Checkout session for upgrading the authenticated user's
 * workspace to a paid plan. Called by the in-dashboard billing cards, which
 * need a JSON answer so they can toast an error in place instead of navigating.
 *
 * Every decision this route used to make now lives in `runCheckout`
 * (src/lib/stripe/checkout-core.ts), shared with GET /api/stripe/checkout/start.
 * This handler is presentation only: it turns a request body into the core's
 * input and the core's outcome into a JSON response. The response payloads are
 * unchanged, deliberately, so the dashboard client needed no edit.
 *
 * Request body:
 *   planId   : any purchasable plan id ('personal' | 'solo' | 'pro')
 *   interval : 'month' | 'year'
 *
 * Response (200):
 *   { url: string }        : the Stripe Checkout hosted page URL to redirect to
 *   { changed: true, ... } : an existing subscription's price was swapped
 *
 * Response (4xx / 5xx):
 *   { error: string, error_code?: string }
 *
 * Security:
 *   - Requires authenticated Supabase session (enforced inside runCheckout).
 *   - The Stripe Checkout session is scoped to the user's Stripe customer, so a
 *     user cannot check out on behalf of anyone else.
 *   - Success and cancel URLs redirect back to the dashboard; plan sync is
 *     handled by the Stripe webhook handler (POST /api/webhooks/stripe).
 *
 * References:
 *   Documents/Architecture/deployment-architecture.md §3 (env vars)
 *   src/lib/stripe/checkout-core.ts (the shared decision logic)
 *   src/lib/stripe/plans.ts (plan catalogue and price IDs)
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json(
      { error: 'Request body must be a JSON object.' },
      { status: 400 },
    );
  }

  const { planId, interval } = body as Record<string, unknown>;

  const outcome = await runCheckout({ planId, interval });

  if (outcome.kind === 'checkout') {
    return NextResponse.json({ url: outcome.url }, { status: 200 });
  }

  if (outcome.kind === 'changed') {
    return NextResponse.json(
      { changed: true, plan: outcome.planName, interval: outcome.interval },
      { status: 200 },
    );
  }

  return NextResponse.json(
    outcome.errorCode
      ? { error: outcome.message, error_code: outcome.errorCode }
      : { error: outcome.message },
    { status: outcome.status },
  );
}
