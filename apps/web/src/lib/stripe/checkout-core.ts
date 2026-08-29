import { createClient } from '@/lib/supabase/server';
import { stripe } from '@/lib/stripe/client';
import { getOrCreateStripeCustomer } from '@/lib/stripe/customer';
import { PLANS, type PlanId, type BillingInterval } from '@/lib/stripe/plans';
import {
  billingTarget,
  recordCheckoutStarted,
} from '@/lib/analytics/billing-funnel';

/**
 * The shared checkout core.
 *
 * ONE implementation, TWO entry points:
 *
 *   POST /api/stripe/checkout        - the in-dashboard fetch, answers JSON.
 *   GET  /api/stripe/checkout/start  - the buy CTA, answers a 303 to Stripe.
 *
 * The GET entry point exists because the old buy path was a link to
 * /dashboard/settings?upgrade=<plan>, which server-rendered the whole dashboard
 * (workspaces, inboxes, usage, keys), hydrated it, and only then let a client
 * effect POST here. Two to three seconds of dead time at the highest-intent
 * moment in the product. `runCheckout` is everything that happened after that
 * wait, lifted out so the CTA can reach Stripe on the first request.
 *
 * NOTHING may be forked between the two callers. This is live billing code with
 * real subscribers: two divergent checkout paths would eventually disagree
 * about who is allowed to be charged, and the entitlement guards below are the
 * only thing standing between a grandfathered or comped account and a bill for
 * access they already have for nothing.
 *
 * The callers own only presentation: JSON body vs redirect target. Every
 * decision (validation, entitlement guards, price resolution, funnel recording,
 * the in-place price swap, session creation) lives here.
 */

/** The failure vocabulary `recordCheckoutStarted` accepts, without a new import. */
type CheckoutFailure = Parameters<typeof recordCheckoutStarted>[2];

/**
 * The purchasable plan ids: every plan in the catalogue except `free`.
 *
 * Derived from PLANS rather than listed literally so adding a tier cannot leave
 * checkout silently refusing to sell it. `enterprise` is not in the catalogue
 * and is therefore still rejected, as before.
 *
 * NAMING TRAP: these are internal ids, not display names. `solo` is sold as
 * "Pro" and `pro` is sold as "Team"; `personal` is the one id that matches its
 * own name. Use plan.name for anything a customer reads.
 */
export type PurchasablePlanId = Exclude<PlanId, 'free'>;

export const PURCHASABLE_PLAN_IDS: readonly PurchasablePlanId[] = (
  Object.keys(PLANS) as PlanId[]
).filter((id): id is PurchasablePlanId => id !== 'free');

export function isPurchasablePlanId(value: unknown): value is PurchasablePlanId {
  return (
    typeof value === 'string' &&
    (PURCHASABLE_PLAN_IDS as readonly string[]).includes(value)
  );
}

/**
 * Why a checkout attempt ended the way it did.
 *
 * This is the machine-readable half of the outcome and the reason the two entry
 * points can diverge in presentation without diverging in behaviour: the JSON
 * caller keeps returning the exact `message` and `errorCode` strings it always
 * has (no dashboard client changes), while the redirecting caller maps `reason`
 * onto a status parameter the dashboard can translate.
 *
 * Every value here is a terminal state of `runCheckout`.
 */
export type CheckoutReason =
  | 'unauthenticated'
  | 'invalid_plan'
  | 'invalid_interval'
  | 'workspace_not_found'
  | 'price_not_configured'
  | 'comped'
  | 'grandfathered_personal'
  | 'plan_not_self_service'
  | 'already_on_plan'
  | 'already_on_plan_interval'
  | 'stripe_customer_failed'
  | 'plan_change_failed'
  | 'stripe_session_failed';

export type CheckoutOutcome =
  /** A hosted Stripe Checkout page is waiting at `url`. */
  | { kind: 'checkout'; url: string }
  /**
   * An existing subscriber's price was swapped in place. There is no hosted
   * page for this: the change already happened.
   */
  | { kind: 'changed'; planId: PurchasablePlanId; planName: string; interval: BillingInterval }
  /** Nothing was created. `message`/`errorCode` are the legacy JSON payload. */
  | {
      kind: 'error';
      reason: CheckoutReason;
      status: number;
      message: string;
      errorCode?: 'subscription_not_self_service';
    };

function fail(
  reason: CheckoutReason,
  status: number,
  message: string,
  errorCode?: 'subscription_not_self_service',
): CheckoutOutcome {
  return { kind: 'error', reason, status, message, errorCode };
}

/**
 * Run a checkout attempt for the currently authenticated user.
 *
 * `planId` and `interval` arrive unvalidated (a JSON body from one caller, a
 * query string from the other) and are validated here, so neither entry point
 * can widen what is purchasable.
 */
export async function runCheckout(input: {
  planId: unknown;
  interval: unknown;
}): Promise<CheckoutOutcome> {
  // ── 1. Authenticate ────────────────────────────────────────────────────────
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return fail('unauthenticated', 401, 'Unauthorized');
  }

  // ── 2. Validate the requested plan and interval ───────────────────────────
  const { planId, interval } = input;

  if (!isPurchasablePlanId(planId)) {
    return fail(
      'invalid_plan',
      400,
      `planId must be one of: ${PURCHASABLE_PLAN_IDS.map((id) => `"${id}"`).join(', ')}.`,
    );
  }

  if (interval !== 'month' && interval !== 'year') {
    return fail('invalid_interval', 400, 'interval must be "month" or "year".');
  }

  // ── 3. Resolve the user's primary workspace ───────────────────────────────
  // Resolved BEFORE the Stripe price lookup, deliberately. Every funnel row
  // needs a workspace id (`product_funnel_events.workspace_id` is NOT NULL), so
  // a checkout attempt that dies on an unconfigured price has nothing to attach
  // its trace to until this has run. Nothing below may return before it.
  //
  // The subscription itself is tied to the USER, not this workspace; the
  // display name only gives the Stripe customer a friendly label.
  const { data: workspace, error: wsError } = await supabase
    .from('workspaces')
    .select('id, display_name')
    .eq('owner_id', user.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  if (wsError || !workspace) {
    return fail('workspace_not_found', 404, 'Workspace not found.');
  }

  // The one and only `checkout_started` writer for this request.
  //
  // Created here, above the price lookup, so no exit below can leave an attempt
  // untraced: a misconfiguration MUST show up in the data. The `recorded` latch
  // makes a second call a no-op, so a successful checkout can only ever produce
  // one row no matter how the branches below evolve. The latch is per call of
  // `runCheckout`, so the two entry points cannot double-record either: each
  // HTTP request runs this function exactly once.
  //
  // The attempt is not written eagerly with a provisional outcome: the view
  // over this table reads `outcome = 'success'` as "a checkout was started" and
  // `outcome = 'failure'` as "it never got off the ground", so each request
  // writes its row once, at the first point its outcome is known.
  const target = billingTarget(planId, interval);
  let recorded = false;
  const recordAttempt = async (failure?: CheckoutFailure): Promise<void> => {
    if (recorded) return;
    recorded = true;
    // recordCheckoutStarted swallows its own errors: analytics must never be
    // able to fail a payment.
    await recordCheckoutStarted(workspace.id, target, failure);
  };

  // ── 4. Resolve the target Stripe price ID ─────────────────────────────────
  const plan = PLANS[planId];
  const priceId =
    interval === 'year' ? plan.stripePriceIdYearly : plan.stripePriceIdMonthly;

  if (!priceId) {
    // An unset STRIPE_PRICE_* env var makes a plan silently unbuyable, which is
    // indistinguishable from disinterest unless it is recorded here.
    await recordAttempt('price_not_configured');
    return fail(
      'price_not_configured',
      503,
      `Stripe price ID for ${planId}/${interval} is not configured. ` +
        'Please try again later or contact support.',
    );
  }

  // ── 4b. Guard against a duplicate / no-op subscription ─────────────────────
  // The subscription is per-user. If the user already has an entitled plan,
  // route plan/interval changes through an in-place price swap instead of
  // creating a second Stripe subscription (which would double-charge them).
  const { data: billing } = await supabase
    .from('user_billing')
    .select('plan, subscription_status, stripe_subscription_id')
    .eq('user_id', user.id)
    .maybeSingle();

  // A comped grant lives in user_usage_entitlements, NOT in user_billing, so a
  // comped user can sit at plan 'free' here while already having full paid
  // access. Without this check they fall through to a real Checkout session
  // and pay for what they were given for nothing.
  const { data: entitlement } = await supabase
    .from('user_usage_entitlements')
    .select('kind, expires_at, unlimited_inboxes')
    .eq('user_id', user.id)
    .maybeSingle();

  const hasCompedGrant =
    entitlement?.kind === 'comped_scale' &&
    (entitlement.expires_at == null ||
      new Date(entitlement.expires_at) > new Date());

  if (hasCompedGrant) {
    await recordAttempt('subscription_exists');
    return fail(
      'comped',
      409,
      'Your account already has full access at no charge. ' +
        'Contact us if you need to change it.',
      'subscription_not_self_service',
    );
  }

  // GRANDFATHERING (2026-08-19 repricing). The pre-repricing cohort keeps
  // unlimited connected inboxes permanently, and that grant lives in
  // user_usage_entitlements while they stay stored as plan 'free' with no
  // subscription. So a request for {planId:'personal'} from one of them passes
  // every other check here and charges $5/mo for THREE inboxes: a paid
  // DOWNGRADE. The dashboard already hides the Personal card for them, but a
  // stale tab, a cached bundle, or a shared buy link defeats a client-side
  // rule, and this is the money path.
  //
  // Only Personal is refused. Pro and Team stay purchasable, because they buy
  // members, team roles, SSO, the audit log and a support tier, none of which
  // the grandfather grant includes.
  if (planId === 'personal' && entitlement?.unlimited_inboxes === true) {
    await recordAttempt('subscription_exists');
    return fail(
      'grandfathered_personal',
      409,
      'Your account already has unlimited inboxes at no charge, so ' +
        `${plan.name} would be a downgrade. Contact us if you need to change it.`,
      'subscription_not_self_service',
    );
  }

  const entitledStatuses = ['active', 'trialing', 'past_due', 'unpaid'];
  const hasEntitledSubscription =
    billing != null &&
    billing.plan !== 'free' &&
    (billing.subscription_status == null ||
      entitledStatuses.includes(billing.subscription_status));

  if (hasEntitledSubscription) {
    await recordAttempt('subscription_exists');
    if (billing!.plan === planId) {
      return fail('already_on_plan', 409, `You are already on the ${plan.name} plan.`);
    }
    // Different paid plan or interval: change the price on the existing
    // subscription rather than opening a second one.
    //
    // This used to send the customer to the Billing Portal, which was a dead
    // end: the portal cannot offer a plan list on this account (the API
    // silently drops features.subscription_update.products), and the account
    // default configuration belongs to a different product, so it must not be
    // reshaped around these plans. Doing the swap here also keeps the customer
    // on our own copy instead of Stripe's.
    const subscriptionId = billing!.stripe_subscription_id;

    if (!subscriptionId) {
      // Entitled with no subscription id is a comped or manually seeded plan.
      // Those are not ours to re-price from a self-service button.
      return fail(
        'plan_not_self_service',
        409,
        'Your plan is managed manually. Contact support to change it.',
        'subscription_not_self_service',
      );
    }

    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const currentItem = subscription.items.data[0];

      if (!currentItem) {
        throw new Error(`Subscription ${subscriptionId} has no items.`);
      }

      if (currentItem.price.id === priceId) {
        return fail(
          'already_on_plan_interval',
          409,
          `You are already on ${plan.name}, billed ${interval}ly.`,
        );
      }

      // `create_prorations` puts the adjustment on the next invoice instead of
      // charging the card the moment the button is pressed, so an upgrade
      // never produces a surprise immediate charge.
      await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: currentItem.id, price: priceId }],
        proration_behavior: 'create_prorations',
        metadata: { user_id: user.id, plan_id: planId, interval },
      });

      // The subscription.updated webhook projects the new plan onto
      // user_billing and every workspace the user owns.
      return { kind: 'changed', planId, planName: plan.name, interval };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[checkout] plan change failed:', message);
      return fail(
        'plan_change_failed',
        500,
        'Could not change your plan. Please try again.',
      );
    }
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
    await recordAttempt('stripe_error');
    return fail(
      'stripe_customer_failed',
      500,
      'Failed to create Stripe customer. Please try again.',
    );
  }

  // ── 6. Build success / cancel URLs ────────────────────────────────────────
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  // The interval rides along with the plan because the confirmation panel on
  // the other side cannot derive it: a plan id alone does not say whether the
  // buyer just paid the monthly or the yearly price, so without this the panel
  // can name the plan but not state what it cost or when it renews. Both values
  // are validated above (`planId` against PURCHASABLE_PLAN_IDS, `interval`
  // against 'month' | 'year'), so neither can put anything unexpected in the
  // query string. The panel treats a missing `interval` as "price unknown" and
  // simply omits those two rows, which is what any session created before this
  // shipped will still do when its buyer returns.
  const successUrl =
    `${appUrl}/dashboard?checkout=success&plan=${planId}&interval=${interval}`;
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
      // Stripe Tax stays OFF, deliberately (decision 2026-08-19).
      //
      // Stripe Tax IS active on the account, but the account holds ZERO tax
      // registrations. Stripe only calculates tax where you are registered, so
      // enabling automatic_tax today would add a "Tax: $0.00" line to every
      // checkout in every country and change nothing else. The prerequisite is
      // registering for Norway MVA, EU Non-Union OSS and UK VAT; until those
      // exist there is nothing for it to compute.
      //
      // Turning it on later needs no price migration: the prices created in the
      // repricing already carry tax_behavior=exclusive, so the displayed amount
      // stays the amount and tax is added on top the day registrations land.
      // automatic_tax: { enabled: true },
    });

    if (!session.url) {
      throw new Error('Stripe returned a session without a URL.');
    }

    // The user is now on Stripe's hosted page. A `checkout_completed` event
    // that never follows this one is the abandonment signal.
    await recordAttempt();
    return { kind: 'checkout', url: session.url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[checkout] stripe.checkout.sessions.create failed:', message);
    await recordAttempt('stripe_error');
    return fail(
      'stripe_session_failed',
      500,
      'Failed to create checkout session. Please try again.',
    );
  }
}
