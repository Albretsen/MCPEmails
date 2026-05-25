/**
 * POST /api/stripe/webhook
 *
 * Stripe webhook handler. Listens for billing events and syncs subscription
 * state to the `workspaces.plan` column in Supabase.
 *
 * Handled events:
 *   checkout.session.completed        — customer completed a checkout; activate plan
 *   customer.subscription.updated     — subscription changed (upgrade/downgrade/renewal)
 *   customer.subscription.deleted     — subscription cancelled; revert to free
 *
 * Security:
 *   Every request is verified against STRIPE_WEBHOOK_SECRET using the raw
 *   request body. Requests that fail signature verification are rejected with 400.
 *   This handler uses the service-role Supabase client (bypasses RLS) because it
 *   runs in a server-side webhook context with no authenticated user session.
 *
 * Idempotency:
 *   Stripe may deliver the same event more than once. All DB updates are
 *   idempotent — setting `plan` to the same value is a no-op.
 *
 * Deployment:
 *   Configured in vercel.json with `maxDuration: 30` to allow time for Stripe
 *   API calls and Supabase writes.
 *
 * References:
 *   Documents/Architecture/deployment-architecture.md §3 (env vars)
 *   src/lib/stripe/plans.ts  (plan catalogue, getPlanByStripePriceId)
 *   src/lib/stripe/client.ts (stripe SDK instance)
 */

import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { stripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { getPlanByStripePriceId, type PlanId } from '@/lib/stripe/plans';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Verify webhook signature ───────────────────────────────────────────
  if (!WEBHOOK_SECRET) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set.');
    return NextResponse.json(
      { error: 'Webhook secret not configured.' },
      { status: 500 },
    );
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json(
      { error: 'Missing stripe-signature header.' },
      { status: 400 },
    );
  }

  // Read raw body — required for signature verification.
  // Using arrayBuffer so the bytes are not decoded before Stripe inspects them.
  let rawBody: Buffer;
  try {
    const buffer = await request.arrayBuffer();
    rawBody = Buffer.from(buffer);
  } catch {
    return NextResponse.json(
      { error: 'Failed to read request body.' },
      { status: 400 },
    );
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[stripe-webhook] Signature verification failed:', message);
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${message}` },
      { status: 400 },
    );
  }

  // ── 2. Route to event handler ─────────────────────────────────────────────
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(
          event.data.object as Stripe.Checkout.Session,
        );
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(
          event.data.object as Stripe.Subscription,
        );
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(
          event.data.object as Stripe.Subscription,
        );
        break;

      default:
        // Unhandled event types are acknowledged but not processed.
        // Stripe will not retry on 200, so this is safe.
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[stripe-webhook] Error handling event ${event.type}:`, message);
    // Return 500 so Stripe retries the event.
    return NextResponse.json(
      { error: 'Internal server error processing webhook.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ received: true }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * checkout.session.completed
 *
 * Fired after a customer successfully completes a Stripe Checkout session.
 * The session metadata contains `workspace_id` and `plan_id` which were
 * embedded when the checkout session was created in /api/stripe/checkout.
 *
 * This is the primary event for activating a new subscription. We update the
 * workspace's plan immediately rather than waiting for
 * `customer.subscription.updated` to avoid a race condition between the
 * checkout redirect and the plan taking effect in the dashboard.
 */
async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  // Only process subscription checkouts.
  if (session.mode !== 'subscription') {
    return;
  }

  const workspaceId = session.metadata?.workspace_id;
  const planId = session.metadata?.plan_id as PlanId | undefined;

  if (!workspaceId || !planId) {
    console.error(
      '[stripe-webhook] checkout.session.completed missing workspace_id or plan_id in metadata:',
      session.id,
    );
    return;
  }

  // Validate that planId is a known value.
  if (planId !== 'pro' && planId !== 'enterprise') {
    console.error(
      `[stripe-webhook] checkout.session.completed unknown planId "${planId}" for session ${session.id}`,
    );
    return;
  }

  const customerId =
    typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id ?? null;

  await syncWorkspacePlan({
    workspaceId,
    newPlan: planId,
    stripeCustomerId: customerId,
    source: 'checkout.session.completed',
  });
}

/**
 * customer.subscription.updated
 *
 * Fired whenever a subscription is updated: plan change, renewal, trial end,
 * quantity change, or status change (e.g. past_due → active).
 *
 * We look up the workspace by stripe_customer_id, derive the plan from the
 * first line item's price ID, and sync the plan column.
 *
 * Subscriptions with status other than 'active' or 'trialing' are treated as
 * inactive — the workspace is downgraded to free.
 */
async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription,
): Promise<void> {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer.id;

  const workspaceId = subscription.metadata?.workspace_id ?? null;

  // Determine whether the subscription is in a billable state.
  const isActive =
    subscription.status === 'active' || subscription.status === 'trialing';

  if (!isActive) {
    // Subscription is past_due, unpaid, cancelled, or paused — downgrade.
    await syncWorkspacePlan({
      customerId,
      workspaceId: workspaceId ?? undefined,
      newPlan: 'free',
      stripeCustomerId: customerId,
      source: `customer.subscription.updated (status=${subscription.status})`,
    });
    return;
  }

  // Resolve plan from the first line item's price ID.
  const priceId = subscription.items.data[0]?.price?.id;
  if (!priceId) {
    console.error(
      '[stripe-webhook] customer.subscription.updated has no price ID on first item:',
      subscription.id,
    );
    return;
  }

  const resolved = getPlanByStripePriceId(priceId);
  if (!resolved) {
    console.error(
      `[stripe-webhook] customer.subscription.updated: price ID "${priceId}" does not map to a known plan. Subscription: ${subscription.id}`,
    );
    return;
  }

  await syncWorkspacePlan({
    customerId,
    workspaceId: workspaceId ?? undefined,
    newPlan: resolved.plan.id,
    stripeCustomerId: customerId,
    source: 'customer.subscription.updated',
  });
}

/**
 * customer.subscription.deleted
 *
 * Fired when a subscription is fully cancelled (immediately or at period end).
 * Downgrade the workspace to the free plan.
 */
async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
): Promise<void> {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer.id;

  const workspaceId = subscription.metadata?.workspace_id ?? null;

  await syncWorkspacePlan({
    customerId,
    workspaceId: workspaceId ?? undefined,
    newPlan: 'free',
    stripeCustomerId: customerId,
    source: 'customer.subscription.deleted',
  });
}

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

interface SyncWorkspacePlanOptions {
  /** Direct workspace ID — used when available (faster, avoids customer lookup). */
  workspaceId?: string;
  /** Stripe customer ID — used to find the workspace when workspaceId is absent. */
  customerId?: string;
  /** Deprecated alias kept for internal call sites; treated the same as customerId. */
  stripeCustomerId?: string | null;
  /** The plan to set on the workspace. */
  newPlan: PlanId | 'free';
  /** Human-readable label for log messages. */
  source: string;
}

/**
 * Update `workspaces.plan` for the workspace identified by either workspaceId
 * or customerId (via stripe_customer_id lookup).
 *
 * Also ensures stripe_customer_id is persisted on the workspace row if it
 * was not set yet (handles the race where the checkout completes before the
 * customer write from the checkout route commits).
 */
async function syncWorkspacePlan(options: SyncWorkspacePlanOptions): Promise<void> {
  const {
    workspaceId,
    customerId,
    stripeCustomerId,
    newPlan,
    source,
  } = options;

  const effectiveCustomerId = stripeCustomerId ?? customerId ?? null;
  const supabase = createServiceRoleClient();

  // ── Resolve workspace row ─────────────────────────────────────────────────
  let resolvedWorkspaceId: string | null = workspaceId ?? null;

  if (!resolvedWorkspaceId && effectiveCustomerId) {
    // Look up by stripe_customer_id.
    const { data, error } = await supabase
      .from('workspaces')
      .select('id')
      .eq('stripe_customer_id', effectiveCustomerId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      throw new Error(
        `[stripe-webhook] Failed to look up workspace for customer ${effectiveCustomerId}: ${error.message}`,
      );
    }

    resolvedWorkspaceId = data?.id ?? null;
  }

  if (!resolvedWorkspaceId) {
    console.error(
      `[stripe-webhook] ${source}: could not resolve workspace. customerId=${effectiveCustomerId ?? 'none'}`,
    );
    return;
  }

  // ── Build update payload ──────────────────────────────────────────────────
  type WorkspaceUpdate = {
    plan: string;
    updated_at: string;
    stripe_customer_id?: string;
  };

  const updatePayload: WorkspaceUpdate = {
    plan: newPlan,
    updated_at: new Date().toISOString(),
  };

  // Persist the customer ID if we have one and it might not be set yet.
  if (effectiveCustomerId) {
    updatePayload.stripe_customer_id = effectiveCustomerId;
  }

  // ── Apply update ──────────────────────────────────────────────────────────
  const { error: updateError } = await supabase
    .from('workspaces')
    .update(updatePayload)
    .eq('id', resolvedWorkspaceId)
    .is('deleted_at', null);

  if (updateError) {
    throw new Error(
      `[stripe-webhook] ${source}: failed to update workspace ${resolvedWorkspaceId} to plan "${newPlan}": ${updateError.message}`,
    );
  }

  console.log(
    `[stripe-webhook] ${source}: workspace ${resolvedWorkspaceId} → plan "${newPlan}"`,
  );
}
