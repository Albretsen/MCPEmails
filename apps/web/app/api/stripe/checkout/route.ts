import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { stripe } from '@/lib/stripe/client';
import { getOrCreateStripeCustomer } from '@/lib/stripe/customer';
import { PLANS, type PlanId, type BillingInterval } from '@/lib/stripe/plans';
import {
  billingTarget,
  primaryWorkspaceId,
  recordCheckoutStarted,
} from '@/lib/analytics/billing-funnel';

/**
 * POST /api/stripe/checkout
 *
 * Creates a Stripe Checkout session for upgrading the authenticated user's
 * workspace to a paid plan.
 *
 * Request body:
 *   planId   : 'solo' | 'pro'
 *   interval : 'month' | 'year'
 *
 * Response (200):
 *   { url: string } : the Stripe Checkout hosted page URL to redirect to
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

  if (planId !== 'solo' && planId !== 'pro') {
    return NextResponse.json(
      { error: 'planId must be "solo" or "pro".' },
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

  const target = billingTarget(planId, interval);

  if (!priceId) {
    // An unset STRIPE_PRICE_* env var makes a plan silently unbuyable, which is
    // indistinguishable from disinterest unless it is recorded here.
    await recordCheckoutStarted(
      await primaryWorkspaceId(supabase, user.id),
      target,
      'price_not_configured',
    );
    return NextResponse.json(
      {
        error:
          `Stripe price ID for ${planId}/${interval} is not configured. ` +
          'Please try again later or contact support.',
      },
      { status: 503 },
    );
  }

  // ── 4. Resolve the user's primary workspace (for a display label only) ────
  // The subscription is tied to the USER, not this workspace; we only read the
  // workspace to give the Stripe customer a friendly name.
  const { data: workspace, error: wsError } = await supabase
    .from('workspaces')
    .select('id, display_name')
    .eq('owner_id', user.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  if (wsError || !workspace) {
    return NextResponse.json(
      { error: 'Workspace not found.' },
      { status: 404 },
    );
  }

  // ── 4b. Guard against a duplicate / no-op subscription ─────────────────────
  // The subscription is per-user. If the user already has an entitled plan,
  // route plan/interval changes through the Billing Portal instead of creating
  // a second Stripe subscription (which would double-charge them).
  const { data: billing } = await supabase
    .from('user_billing')
    .select('plan, subscription_status')
    .eq('user_id', user.id)
    .maybeSingle();

  const entitledStatuses = ['active', 'trialing', 'past_due', 'unpaid'];
  const hasEntitledSubscription =
    billing != null &&
    billing.plan !== 'free' &&
    (billing.subscription_status == null ||
      entitledStatuses.includes(billing.subscription_status));

  if (hasEntitledSubscription) {
    await recordCheckoutStarted(workspace.id, target, 'subscription_exists');
    if (billing!.plan === planId) {
      return NextResponse.json(
        { error: `You are already on the ${plan.name} plan.` },
        { status: 409 },
      );
    }
    // Different paid plan: must change it in the portal, not via a new checkout.
    return NextResponse.json(
      {
        error:
          'You already have an active subscription. ' +
          'Use the billing portal to change your plan or interval.',
        error_code: 'subscription_exists',
        portal: true,
      },
      { status: 409 },
    );
  }

  // ── 5. Get or create the single Stripe Customer for this user ─────────────
  const ownerEmail = user.email ?? '';
  let customerId: string;

  try {
    const result = await getOrCreateStripeCustomer({
      userId: user.id,
      ownerEmail,
      displayName: workspace.display_name,
    });
    customerId = result.customerId;
  } catch (err) {
    console.error('[checkout] getOrCreateStripeCustomer failed:', err);
    await recordCheckoutStarted(workspace.id, target, 'stripe_error');
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
      // Billing address is collected by Stripe: required for tax calculation.
      billing_address_collection: 'auto',
      // Pass USER context through to the subscription for the webhook handler.
      // The subscription is tied to the user; the webhook resolves the owner
      // from user_id (or the customer) and propagates to all owned workspaces.
      subscription_data: {
        metadata: {
          user_id: user.id,
        },
      },
      metadata: {
        user_id: user.id,
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

    // The user is now on Stripe's hosted page. A `checkout_completed` event
    // that never follows this one is the abandonment signal.
    await recordCheckoutStarted(workspace.id, target);
    return NextResponse.json({ url: session.url }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[checkout] stripe.checkout.sessions.create failed:', message);
    await recordCheckoutStarted(workspace.id, target, 'stripe_error');
    return NextResponse.json(
      { error: 'Failed to create checkout session. Please try again.' },
      { status: 500 },
    );
  }
}
