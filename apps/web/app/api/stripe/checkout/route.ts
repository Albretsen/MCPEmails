import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { stripe } from '@/lib/stripe/client';
import { getOrCreateStripeCustomer } from '@/lib/stripe/customer';
import { PLANS, type PlanId, type BillingInterval } from '@/lib/stripe/plans';

/**
 * POST /api/stripe/checkout
 *
 * Creates a Stripe Checkout session for upgrading the authenticated user's
 * workspace to a paid plan.
 *
 * Request body:
 *   planId   — 'solo' | 'pro' | 'enterprise'
 *   interval — 'month' | 'year'
 *
 * Response (200):
 *   { url: string } — the Stripe Checkout hosted page URL to redirect to
 *
 * Response (4xx / 5xx):
 *   { error: string }
 *
 * Security:
 *   - Requires authenticated Supabase session.
 *   - The Stripe Checkout session is scoped to the workspace's Stripe customer,
 *     so a user cannot check out on behalf of another workspace.
 *   - Success and cancel URLs redirect back to the dashboard; plan sync is
 *     handled by the Stripe webhook handler (POST /api/webhooks/stripe).
 *
 * References:
 *   Documents/Architecture/deployment-architecture.md §3 (env vars)
 *   src/lib/stripe/plans.ts (plan catalogue and price IDs)
 *   src/lib/stripe/customer.ts (getOrCreateStripeCustomer)
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Authenticate ────────────────────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── 2. Parse and validate request body ────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }

  const { planId, interval } = body as Record<string, unknown>;

  if (planId !== 'solo' && planId !== 'pro' && planId !== 'enterprise') {
    return NextResponse.json(
      { error: 'planId must be "solo", "pro", or "enterprise".' },
      { status: 400 },
    );
  }

  if (interval !== 'month' && interval !== 'year') {
    return NextResponse.json(
      { error: 'interval must be "month" or "year".' },
      { status: 400 },
    );
  }

  // ── 3. Resolve the target Stripe price ID ─────────────────────────────────
  const plan = PLANS[planId as PlanId];
  const priceId =
    interval === 'year' ? plan.stripePriceIdYearly : plan.stripePriceIdMonthly;

  if (!priceId) {
    return NextResponse.json(
      {
        error:
          `Stripe price ID for ${planId}/${interval} is not configured. ` +
          'See Documents/Human-Input/STRIPE_SETUP_NEEDED.md for setup instructions.',
      },
      { status: 503 },
    );
  }

  // ── 4. Resolve the user's workspace ───────────────────────────────────────
  const { data: workspace, error: wsError } = await supabase
    .from('workspaces')
    .select('id, display_name, plan, owner_id')
    .eq('owner_id', user.id)
    .is('deleted_at', null)
    .single();

  if (wsError || !workspace) {
    return NextResponse.json(
      { error: 'Workspace not found.' },
      { status: 404 },
    );
  }

  // Prevent a no-op checkout: if the workspace is already on this plan, bail.
  if (workspace.plan === planId) {
    return NextResponse.json(
      { error: `Your workspace is already on the ${plan.name} plan.` },
      { status: 409 },
    );
  }

  // ── 5. Get or create the Stripe Customer for this workspace ───────────────
  const ownerEmail = user.email ?? '';
  let customerId: string;

  try {
    const result = await getOrCreateStripeCustomer({
      workspaceId: workspace.id,
      ownerEmail,
      workspaceName: workspace.display_name,
    });
    customerId = result.customerId;
  } catch (err) {
    console.error('[checkout] getOrCreateStripeCustomer failed:', err);
    return NextResponse.json(
      { error: 'Failed to create Stripe customer. Please try again.' },
      { status: 500 },
    );
  }

  // ── 6. Build success / cancel URLs ────────────────────────────────────────
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  const successUrl = `${appUrl}/dashboard?checkout=success&plan=${planId}`;
  const cancelUrl = `${appUrl}/dashboard?checkout=cancelled`;

  // ── 7. Create the Stripe Checkout session ─────────────────────────────────
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      // Billing address is collected by Stripe — required for tax calculation.
      billing_address_collection: 'auto',
      // Pass workspace context through to the subscription for the webhook handler.
      subscription_data: {
        metadata: {
          workspace_id: workspace.id,
        },
        // Solo and Pro advertise a 14-day free trial. A payment method is
        // collected at checkout (Stripe's default for subscription mode) and
        // the first charge lands when the trial ends.
        ...(planId === 'solo' || planId === 'pro'
          ? { trial_period_days: 14 }
          : {}),
      },
      metadata: {
        workspace_id: workspace.id,
        plan_id: planId,
        interval,
      },
      // Automatically tax based on the customer's location (requires Stripe Tax).
      // Comment out if Stripe Tax is not enabled on the account.
      // automatic_tax: { enabled: true },
    });

    if (!session.url) {
      throw new Error('Stripe returned a session without a URL.');
    }

    return NextResponse.json({ url: session.url }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[checkout] stripe.checkout.sessions.create failed:', message);
    return NextResponse.json(
      { error: 'Failed to create checkout session. Please try again.' },
      { status: 500 },
    );
  }
}
