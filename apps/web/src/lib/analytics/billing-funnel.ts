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
  planId: 'solo' | 'pro',
  interval: 'month' | 'year',
): BillingTargetCategory {
  return `${planId}_${interval}` as BillingTargetCategory;
}

/** Normalise any stored plan slug to the bounded category vocabulary. */
export function planCategory(plan: string | null | undefined): BillingPlanCategory {
  return plan === 'solo' || plan === 'pro' ? plan : 'free';
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

/** A checkout session was requested. `outcome: 'success'` means Stripe returned a URL. */
export async function recordCheckoutStarted(
  workspaceId: string | null,
  target: BillingTargetCategory,
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
