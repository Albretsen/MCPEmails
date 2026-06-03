import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { stripe } from '@/lib/stripe/client';

/**
 * POST /api/stripe/portal
 *
 * Creates a Stripe Billing Portal session for the authenticated user's
 * workspace. Returns the portal URL to redirect to.
 *
 * The Billing Portal lets customers:
 *   - View and download invoices
 *   - Update their payment method
 *   - Change or cancel their subscription
 *
 * Prerequisites:
 *   - Stripe Billing Portal must be configured in the Stripe dashboard:
 *     https://dashboard.stripe.com/test/settings/billing/portal
 *   - The workspace must have a stripe_customer_id (set after first checkout).
 *
 * Request body: (empty, no params required)
 *
 * Response (200):
 *   { url: string } : the Stripe Customer Portal URL to redirect to
 *
 * Response (4xx / 5xx):
 *   { error: string }
 *
 * Security:
 *   - Requires authenticated Supabase session.
 *   - The portal session is scoped to the workspace's Stripe customer,
 *     so a user cannot access another workspace's billing.
 */
export async function POST(_request: NextRequest): Promise<NextResponse> {
  // ── 1. Authenticate ────────────────────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── 2. Resolve the user's billing record ──────────────────────────────────
  // Billing (the Stripe customer) is tied to the user, not a workspace.
  const { data: billing } = await supabase
    .from('user_billing')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();

  // ── 3. Guard: only users with a Stripe customer have a portal ─────────────
  if (!billing?.stripe_customer_id) {
    return NextResponse.json(
      {
        error:
          'No billing account found. ' +
          'Upgrade to a paid plan to access the customer portal.',
      },
      { status: 422 },
    );
  }

  // ── 4. Build the return URL ────────────────────────────────────────────────
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  const returnUrl = `${appUrl}/dashboard`;

  // ── 5. Create the Stripe Billing Portal session ────────────────────────────
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: billing.stripe_customer_id,
      return_url: returnUrl,
    });

    return NextResponse.json({ url: session.url }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[portal] stripe.billingPortal.sessions.create failed:', message);

    // Surface a helpful message if the portal is not configured in Stripe.
    if (message.includes('portal configuration')) {
      return NextResponse.json(
        {
          error:
            'The Stripe Customer Portal has not been configured. ' +
            'Visit https://dashboard.stripe.com/settings/billing/portal to enable it.',
        },
        { status: 503 },
      );
    }

    return NextResponse.json(
      { error: 'Failed to open the billing portal. Please try again.' },
      { status: 500 },
    );
  }
}
