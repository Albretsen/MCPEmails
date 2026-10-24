import { NextRequest, NextResponse } from 'next/server';
import { runCheckout, runPassCheckout } from '@/lib/stripe/checkout-core';
import { PERSONAL_PASS_3M } from '@/lib/stripe/plans';
import { countryFromHeaders } from '@/lib/acquisition-country.mjs';

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
 * input and the core's outcome into a JSON response.
 *
 * Request body:
 *   planId   : any purchasable plan id ('personal' | 'solo' | 'pro')
 *   interval : 'month' | 'year'
 *   confirm  : true only when the caller is acting on a person who has just
 *              been shown, and accepted, the amount from a previous call. An
 *              existing subscriber's plan change is a two-call handshake:
 *              the first returns the quote, the second performs it.
 *   locale   : the buyer's app-realm language. Only 'de' changes anything (a
 *              German hosted page); any other value, or none, is English.
  const { planId, interval, confirm, locale, offer, product, arm, surface } = body as Record<string, unknown>;

  if (product !== undefined && product !== PERSONAL_PASS_3M.id) {
    return NextResponse.json({ error: 'Unknown product.' }, { status: 400 });
  }

  const outcome =
    product === PERSONAL_PASS_3M.id
      ? await runPassCheckout({ locale, experimentArm: arm, surface })
      : await runCheckout({
          planId,
          interval,
          confirmChange: confirm,
          locale,
          ...(offer !== undefined ? { quotedOffer: offer } : {}),
        });
 *
 * Response (200):
 *   { url: string }        : the Stripe Checkout hosted page URL to redirect to
 *   { confirmation_required: true, ... } : the quote for an in-place change.
 *                            NOTHING has changed and nothing was charged.
 *   { changed: true, ... } : an existing subscription's price was swapped and
 *                            the proration charged
 *   { payment_required: true, ... } : the swap is held pending payment; the
 *                            subscription is unchanged
 *
 * Response (4xx / 5xx):
 *   { error: string, error_code?: string }
 *
 * Security:
 *   - Requires authenticated Supabase session (enforced inside runCheckout).
 *   - The Stripe Checkout session is scoped to the user's Stripe customer, so a
 *     user cannot check out on behalf of anyone else.
 *   - A plan change cannot happen on a single request: without `confirm: true`
 *     the core only quotes. That is what keeps one click on an upgrade button
 *     from re-pricing a live subscription before the customer has seen a
 *     number.
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

  const { planId, interval, confirm, locale, offer, product, arm, surface } = body as Record<string, unknown>;

  if (product !== undefined && product !== PERSONAL_PASS_3M.id) {
    return NextResponse.json({ error: 'Unknown product.' }, { status: 400 });
  }

  // Vercel's geolocation of this request, for the EUR currency choice and VAT
  // evidence (see `country` on runCheckout). Absent locally and in tests.
  const country = countryFromHeaders(request.headers);

  const outcome =
    product === PERSONAL_PASS_3M.id
      ? await runPassCheckout({ locale, experimentArm: arm, surface })
      : await runCheckout({
          planId,
          interval,
          confirmChange: confirm,
          locale,
          ...(country ? { country } : {}),
          ...(offer !== undefined ? { quotedOffer: offer } : {}),
        });

  if (outcome.kind === 'checkout') {
    return NextResponse.json({ url: outcome.url }, { status: 200 });
  }

  if (outcome.kind === 'confirmation_required') {
    // A 200 carrying a quote, not a completed action. `preview` is null when
    // Stripe could not price the change; the dashboard words the dialog
    // without a figure rather than refusing the upgrade over it.
    return NextResponse.json(
      {
        confirmation_required: true,
        plan_id: outcome.planId,
        plan: outcome.planName,
        interval: outcome.interval,
        preview: outcome.preview,
        ...(outcome.offerEnded ? { seasonal_offer_ended: true } : {}),
      },
      { status: 200 },
    );
  }

  if (outcome.kind === 'changed') {
    return NextResponse.json(
      {
        changed: true,
        plan: outcome.planName,
        interval: outcome.interval,
        amount_paid_cents: outcome.amountPaidCents,
        currency: outcome.currency,
      },
      { status: 200 },
    );
  }

  if (outcome.kind === 'payment_required') {
    return NextResponse.json(
      {
        payment_required: true,
        plan: outcome.planName,
        interval: outcome.interval,
        invoice_url: outcome.invoiceUrl,
      },
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
