import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { stripe } from '@/lib/stripe/client';
import { verifyPortalCustomerOwnership } from '@/lib/stripe/portal-customer';
import {
  planCategory,
  primaryWorkspaceId,
  recordPortalOpened,
} from '@/lib/analytics/billing-funnel';

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
 *   - The portal session is scoped to the user's own Stripe customer. A
 *     customer id found only on a workspace row is used after Stripe confirms
 *     it belongs to this user, so a user cannot open another customer's portal.
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

  // ── 2. Resolve the user's Stripe customer id ──────────────────────────────
  // Billing (the Stripe customer) is tied to the user, not a workspace, so the
  // authoritative source is `user_billing.stripe_customer_id`, which only server
  // code writes. However, plans that were seeded manually (or by the older
  // workspace-scoped flow) can leave it NULL while a workspace the user owns
  // still carries the real `cus_...` id. Those users are genuinely paying and
  // must still reach their portal, so the workspace column stays as a fallback.
  //
  // That column was writable by the workspace owner until
  // 20261016160100_workspaces_server_owned_writes.sql and is not unique, so a
  // stored value is only a CANDIDATE: the Stripe customer must itself name this
  // user (or one of their workspaces) before a portal session is created or the
  // id is copied into user_billing. See src/lib/stripe/portal-customer.ts.
  const { data: billing } = await supabase
    .from('user_billing')
    .select('stripe_customer_id, plan')
    .eq('user_id', user.id)
    .maybeSingle();

  let customerId: string | null = billing?.stripe_customer_id ?? null;

  if (!customerId) {
    customerId = await verifiedWorkspaceCustomerId(user);

    if (customerId) {
      // Backfill user_billing (service role: the user RLS policy may block the
      // write, and this self-heals the desync so the webhook stays authoritative).
      try {
        const serviceClient = createServiceRoleClient();
        await serviceClient
          .from('user_billing')
          .upsert(
            { user_id: user.id, stripe_customer_id: customerId },
            { onConflict: 'user_id' },
          );
      } catch (backfillErr) {
        // Non-fatal: we can still open the portal with the verified customer id.
        console.error('[portal] user_billing backfill failed:', backfillErr);
      }
    }
  }

  // ── 3. Guard: only users with a Stripe customer have a portal ─────────────
  if (!customerId) {
    await recordPortalOpened(
      await primaryWorkspaceId(supabase, user.id),
      'free',
      'no_customer',
    );
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
  //
  // We pin our OWN portal configuration rather than the account default. The
  // same Stripe account bills another product, so the default configuration is
  // shared and must not be reshaped around MCPEmails plans.
  //
  // Plan switching is deliberately NOT offered in the portal: the API silently
  // drops `features.subscription_update.products` on this account, so the
  // update screen cannot be given a price list to offer. Upgrades and interval
  // changes go through our own checkout instead, where the copy is ours. The
  // portal still covers invoices, payment method, tax ID, and cancellation
  // (at period end, matching the published refund policy).
  const portalConfiguration = process.env.STRIPE_PORTAL_CONFIGURATION_ID;

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      ...(portalConfiguration ? { configuration: portalConfiguration } : {}),
    });

    await recordPortalOpened(
      await primaryWorkspaceId(supabase, user.id),
      planCategory(billing?.plan),
    );
    return NextResponse.json({ url: session.url }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stripeCode = (err as Record<string, unknown>)?.code as string | undefined;
    console.error('[portal] stripe.billingPortal.sessions.create failed:', message);
    await recordPortalOpened(
      await primaryWorkspaceId(supabase, user.id),
      planCategory(billing?.plan),
      'stripe_error',
    );

    // ── 5a. Missing / invalid customer (e.g. test-mode ID used against live key)
    // Self-heal: null out the stale customer ID so the account recovers on the
    // next checkout attempt (which will create a fresh live-mode customer).
    const isResourceMissing =
      stripeCode === 'resource_missing' ||
      message.toLowerCase().includes('no such customer');

    if (isResourceMissing) {
      try {
        const serviceClient = createServiceRoleClient();
        // Null the stale id on BOTH user_billing and every owned workspace.
        // If we only cleared user_billing, the workspace fallback (step 2) would
        // re-pick the same dead id on the next attempt and loop indefinitely.
        await Promise.all([
          serviceClient
            .from('user_billing')
            .update({ stripe_customer_id: null })
            .eq('user_id', user.id),
          serviceClient
            .from('workspaces')
            .update({ stripe_customer_id: null })
            .eq('owner_id', user.id)
            .eq('stripe_customer_id', customerId),
        ]);
        console.error(
          '[portal] nulled stale stripe_customer_id for user',
          user.id,
          '(resource_missing)',
        );
      } catch (healErr) {
        console.error('[portal] self-heal update failed:', healErr);
      }
      return NextResponse.json(
        {
          error:
            'No active billing account found. ' +
            'Start a subscription to manage billing.',
        },
        { status: 422 },
      );
    }

    // ── 5b. Portal not configured in Stripe dashboard
    const isPortalUnconfigured =
      message.includes('portal configuration') ||
      message.toLowerCase().includes('no configuration provided') ||
      message.toLowerCase().includes('default configuration has not been created') ||
      (message.toLowerCase().includes('configuration') && stripeCode === 'invalid_request_error');

    if (isPortalUnconfigured) {
      // An operator fix (Stripe dashboard > Settings > Billing > Customer
      // portal), so the log says how and the customer is pointed at support.
      console.error('[portal] Stripe Customer Portal is not configured: enable it at https://dashboard.stripe.com/settings/billing/portal');
      return NextResponse.json(
        {
          error:
            'Billing management is not available right now. ' +
            'Write to support@mcpemails.com and we will sort it out.',
        },
        { status: 503 },
      );
    }

    // ── 5c. Genuinely unexpected error
    return NextResponse.json(
      { error: 'Failed to open the billing portal. Please try again. If it keeps failing, write to support@mcpemails.com.' },
      { status: 500 },
    );
  }
}

/**
 * The legacy fallback: the first customer id stored on a live workspace the
 * user owns whose Stripe record proves it is theirs, or null.
 *
 * Read with the service role so the owner filter, not RLS membership, decides
 * which rows count, and so a workspace the user has since deleted still counts
 * as theirs for a customer created in the workspace-scoped era.
 *
 * Self-heal (as step 5a does for the user_billing id): a candidate that Stripe
 * no longer has (resource_missing), that is deleted, or that provably belongs
 * to someone else (planted or foreign) is nulled on the caller's own live
 * workspaces that carry it, so the next portal click does not repeat the
 * Stripe call. A customer with no ownership proof either way ('no_proof') is
 * left in place: it may be the user's own hand-made customer under another
 * email, which support can still recover.
 */
async function verifiedWorkspaceCustomerId(user: {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
}): Promise<string | null> {
  const service = createServiceRoleClient();
  const { data: owned, error } = await service
    .from('workspaces')
    .select('id, stripe_customer_id, deleted_at')
    .eq('owner_id', user.id)
    .order('created_at', { ascending: true });
  if (error || !owned) {
    if (error) console.error('[portal] owned workspace lookup failed:', error.message);
    return null;
  }

  const ownedIds = owned.map((w) => w.id);
  const candidates = [
    ...new Set(
      owned
        .filter((w) => !w.deleted_at && w.stripe_customer_id)
        .map((w) => w.stripe_customer_id as string),
    ),
  ];

  const workspaceIdsCarrying = (candidate: string) =>
    owned.filter((w) => !w.deleted_at && w.stripe_customer_id === candidate).map((w) => w.id);

  /** Null `candidate` on the caller's own live workspaces that carry it. */
  const clearCandidate = async (candidate: string, reason: string) => {
    try {
      const { error: clearError } = await service
        .from('workspaces')
        .update({ stripe_customer_id: null })
        .in('id', workspaceIdsCarrying(candidate))
        .eq('owner_id', user.id)
        .eq('stripe_customer_id', candidate);
      if (clearError) throw new Error(clearError.message);
      console.error('[portal] nulled workspace stripe_customer_id for user', user.id, `(${reason})`);
    } catch (healErr) {
      console.error('[portal] workspace self-heal failed:', healErr);
    }
  };

  for (const candidate of candidates) {
    let customer;
    try {
      customer = await stripe.customers.retrieve(candidate);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as Record<string, unknown>)?.code;
      console.error('[portal] fallback customer lookup failed:', message);
      // Only a definite "no such customer" is healed. A network blip or a
      // Stripe outage must never erase a paying user's id.
      if (code === 'resource_missing' || message.toLowerCase().includes('no such customer')) {
        await clearCandidate(candidate, 'resource_missing');
      }
      continue;
    }
    const verdict = verifyPortalCustomerOwnership(
      {
        id: customer.id,
        deleted: (customer as { deleted?: unknown }).deleted === true,
        email: 'email' in customer ? customer.email : null,
        metadata: 'metadata' in customer ? customer.metadata : null,
      },
      user,
      ownedIds,
    );
    if (verdict.owned) return candidate;
    console.error('[portal] refused workspace customer fallback for user', user.id, `(${verdict.reason})`);
    if (verdict.reason !== 'no_proof') await clearCandidate(candidate, verdict.reason);
  }
  return null;
}
