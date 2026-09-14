import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceRoleClient } from '@/lib/supabase/service';
import {
  recordProductFunnelEvent,
  type BillingPlanCategory,
  type BillingTargetCategory,
  type PricingSurfaceCategory,
  type ProductFunnelEvent,
} from '@/lib/analytics/product-funnel';

/**
 * Billing funnel recording.
 *
 * Stripe routes are user-scoped (one subscription per user, reused across every
 * workspace they own) but `product_funnel_events` is workspace-scoped. These
 * helpers resolve the user's primary workspace the same way the checkout route
 * does (oldest active owned workspace) so a billing event lands on the same row
 * the activation funnel already uses. Without that, the two halves of the
 * funnel could not be joined.
 *
 * Every helper is best-effort and never throws: analytics must not be able to
 * fail a payment. Callers deliberately do not await-and-branch on the result.
 */

/** Resolve the workspace a user's billing events belong to. */
export async function primaryWorkspaceId(
  db: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('workspaces')
    .select('id')
    .eq('owner_id', userId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[billing-funnel] workspace resolve failed', { error: error.message });
    return null;
  }
  return data?.id ?? null;
}

export function billingTarget(
  planId: 'personal' | 'solo' | 'pro',
  interval: 'month' | 'year',
): BillingTargetCategory {
  return `${planId}_${interval}` as BillingTargetCategory;
}

/** Normalise any stored plan slug to the bounded category vocabulary. */
export function planCategory(plan: string | null | undefined): BillingPlanCategory {
  return plan === 'personal' || plan === 'solo' || plan === 'pro' ? plan : 'free';
}

async function record(event: ProductFunnelEvent): Promise<void> {
  try {
    await recordProductFunnelEvent(createServiceRoleClient(), event);
  } catch (err) {
    // Swallow: a failed analytics write must never surface to the payer.
    console.error('[billing-funnel] record failed', {
      stage: event.stage,
      outcome: event.outcome,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A checkout session was requested. `outcome: 'success'` means Stripe returned a URL.
 *
 * `target` widens to `'unknown'` for the one case that has no plan+interval to
 * name: an attempt refused for a bad `planId` or a bad `interval`. Those are
 * still checkout attempts and still belong in the funnel, and `'unknown'` is in
 * the category CHECK constraint for exactly this sort of row. Guessing a
 * plausible target instead would file the attempt under a price nobody asked
 * for, and echoing the caller's own string into the column would put unbounded
 * input in a bounded vocabulary.
 */
export async function recordCheckoutStarted(
  workspaceId: string | null,
  target: BillingTargetCategory | 'unknown',
  failure?: ProductFunnelEvent['errorCategory'],
): Promise<void> {
  if (!workspaceId) return;
  await record({
    workspaceId,
    stage: 'checkout_started',
    outcome: failure ? 'failure' : 'success',
    category: target,
    errorCategory: failure,
  });
}

/** Stripe confirmed a paid checkout. Recorded from the webhook, never the client. */
export async function recordCheckoutCompleted(
  workspaceId: string | null,
  target: BillingTargetCategory,
): Promise<void> {
  if (!workspaceId) return;
  await record({ workspaceId, stage: 'checkout_completed', outcome: 'success', category: target });
}

/**
 * Which way an in-place plan change moved.
 *
 * Not derivable from the row it produces: `category` carries the plan the
 * change landed ON, and a single "changed plan" bucket cannot tell expansion
 * from contraction. `planCommitmentRank` (plans.ts) is the ordering.
 */
export type PlanChangeDirection = 'upgrade' | 'downgrade';

/**
 * An existing subscriber's subscription was re-priced in place.
 *
 * NOT a `checkout_completed`, and not a `checkout_started` either. Until
 * 2026-09-14 this path wrote `checkout_started / failure / subscription_exists`
 * on the CONFIRMED pass, which is to say the funnel recorded a successful,
 * invoiced, paid upgrade as a checkout that never got off the ground. One real
 * customer had made that journey and the only row it left behind said the
 * opposite of what happened.
 *
 * The stage is not `checkout_completed` either, and that is the part worth
 * spelling out: `billing_funnel_by_workspace` exposes `MIN(checkout_completed)`
 * as `paid_at`, and `growth_experiment_readout` reads `paid_at IS NOT NULL` as
 * "this workspace converted". A downgrade filed there would count as a new
 * sale, in an experiment read-out, forever.
 *
 * `outcome` carries what actually happened to the money:
 *   success  the swap was applied and the proration was invoiced AND paid.
 *   started  Stripe accepted the swap but holds it as a pending update until
 *            the invoice is paid (3DS, or a declined card). The customer is
 *            still on the plan they had, so this is not a completed change.
 *   failure  the call to Stripe threw; nothing moved.
 *
 * KNOWN GAP, deliberately left: a `started` row is never followed by a success
 * row of its own. Stripe applies a pending update by itself when the invoice is
 * paid, and the only evidence is a `customer.subscription.updated` webhook that
 * cannot tell an upgrade it is completing from one this function already
 * recorded (nothing stores the price a subscription was previously on, so the
 * webhook cannot see an interval change at all). Recording from both places
 * would double-count every ordinary upgrade, which is a worse error than
 * missing a rare held one. The workspace's plan and the MRR read-out both still
 * move when the payment lands.
 */
export async function recordPlanChange(args: {
  workspaceId: string | null;
  direction: PlanChangeDirection;
  /** The plan+interval the change landed on, never the one it came from. */
  target: BillingTargetCategory;
  outcome: 'started' | 'success' | 'failure';
  failure?: ProductFunnelEvent['errorCategory'];
}): Promise<void> {
  const { workspaceId, direction, target, outcome, failure } = args;
  if (!workspaceId) return;
  await record({
    workspaceId,
    stage: direction === 'upgrade' ? 'plan_upgraded' : 'plan_downgraded',
    outcome,
    category: target,
    // `product_funnel_events_terminal_error_check` rejects a reason on any
    // outcome but `failure`, so this is a constraint, not a style choice.
    errorCategory: outcome === 'failure' ? failure : undefined,
  });
}

/** An existing subscriber opened the Stripe billing portal. */
export async function recordPortalOpened(
  workspaceId: string | null,
  plan: BillingPlanCategory,
  failure?: ProductFunnelEvent['errorCategory'],
): Promise<void> {
  if (!workspaceId) return;
  await record({
    workspaceId,
    stage: 'billing_portal_opened',
    outcome: failure ? 'failure' : 'success',
    category: plan,
    errorCategory: failure,
  });
}

/**
 * The inbox-cap upgrade panel was shown to a user trying to connect an inbox.
 *
 * `paywall_reached` already exists on this table, written by
 * `record_usage_limit_event` when the action cap refuses a billable MCP call.
 * That is a different surface with a different meaning, so these rows carry
 * `connection_type = 'first_connect'`: the cap that blocked this user was the
 * connected-inbox cap, and the thing it blocked was a first connect. The
 * action-cap rows leave the column NULL, which keeps the two separable in
 * `billing_funnel_by_workspace` without a schema change.
 *
 * `outcome` is `started`, not `success`: showing someone a price is the start
 * of an upgrade decision, not the successful completion of anything. The
 * category is the plan they were on when they hit the wall, which is what makes
 * "Free users who saw the panel and bought" answerable at all.
 *
 * Not deduped server-side. Re-opening the connect modal after hitting the cap
 * is a genuine second attempt to add an inbox, and collapsing those would erase
 * exactly the repeated intent that distinguishes a blocked power user from
 * someone who wandered past the panel once. The per-modal-open guard on the
 * client is what stops a render loop from inflating it.
 */
export async function recordInboxPaywallReached(workspaceId: string | null): Promise<void> {
  if (!workspaceId) return;
  const db = createServiceRoleClient();
  // Read the plan server-side rather than trusting the browser with it: the
  // beacon carries no body at all, so there is nothing for a caller to forge.
  const { data, error } = await db.from('workspaces').select('plan').eq('id', workspaceId).maybeSingle();
  if (error) console.error('[billing-funnel] paywall plan lookup failed', { error: error.message });
  await record({
    workspaceId,
    stage: 'paywall_reached',
    outcome: 'started',
    category: planCategory(data?.plan),
    connectionType: 'first_connect',
  });
}

/**
 * A signed-in user looked at the plans.
 *
 * Deduped to one row per workspace / surface / UTC day so a refresh loop or a
 * dashboard tab left open cannot inflate intent. Anonymous marketing traffic to
 * /pricing is deliberately NOT recorded: `product_funnel_events.workspace_id`
 * is NOT NULL by design, and logged-out page views belong in web analytics
 * rather than in the product funnel.
 */
export async function recordPricingViewed(
  workspaceId: string | null,
  surface: PricingSurfaceCategory,
): Promise<void> {
  if (!workspaceId) return;
  const db = createServiceRoleClient();
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (db as any)
    .from('product_funnel_events')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('stage', 'pricing_viewed')
    .eq('category', surface)
    .gte('occurred_at', dayStart.toISOString())
    .limit(1)
    .maybeSingle();
  if (existing) return;
  await record({ workspaceId, stage: 'pricing_viewed', outcome: 'success', category: surface });
}
