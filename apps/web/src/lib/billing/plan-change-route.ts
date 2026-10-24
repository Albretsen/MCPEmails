/**
 * Shared plumbing for POST /api/billing/pause and POST /api/billing/downgrade.
 *
 * AUTH AND OWNERSHIP, as /api/stripe/portal does it: a signed-in user, the
 * Stripe customer from `user_billing` (only server code writes that row), and
 * the subscription id from the same row. The subscription is then read from
 * Stripe and must belong to that customer, and, when it names a user, to this
 * user. No workspace fallback: a plan change is never made on a customer id
 * the caller could have planted.
 *
 * THE HANDSHAKE, as runCheckout's confirmChange: every action that changes a
 * subscription answers a quote unless the body says `confirm: true` (the
 * boolean, nothing truthy), and only then calls Stripe.
 */
import type Stripe from 'stripe';

import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { stripe } from '@/lib/stripe/client';
import { chooseActiveInboxes } from '@/lib/billing/parking';
import { inboxCapFor } from '@/lib/billing/plan-change-sync';
import { PARKING_USAGE_DAYS } from '@/lib/billing/parking';
import type { PlanId } from '@/lib/stripe/plans';

export interface OwnSubscription {
  user: { id: string; email: string | null };
  customerId: string;
  subscription: Stripe.Subscription;
}

export type OwnSubscriptionResult =
  | { ok: true; value: OwnSubscription }
  | { ok: false; status: number; error: string; code: string };

/** Signed-in user only, without the Stripe read. */
export async function currentUser(): Promise<{ id: string; email: string | null } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

export async function loadOwnSubscription(user: { id: string; email: string | null }): Promise<OwnSubscriptionResult> {
  const supabase = await createClient();
  const { data: billing, error } = await supabase
    .from('user_billing')
    .select('stripe_customer_id, stripe_subscription_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) {
    console.error('[plan-change-route] user_billing read failed:', error.message);
    return { ok: false, status: 500, error: 'Could not read your billing details.', code: 'billing_read_failed' };
  }
  const customerId = billing?.stripe_customer_id ?? null;
  const subscriptionId = billing?.stripe_subscription_id ?? null;
  if (!customerId || !subscriptionId) {
    return { ok: false, status: 409, error: 'There is no subscription on this account.', code: 'no_subscription' };
  }

  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    console.error('[plan-change-route] subscription read failed:', err instanceof Error ? err.message : String(err));
    return { ok: false, status: 502, error: 'Could not reach the billing provider. Please try again.', code: 'stripe_error' };
  }
  const owner = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const namedUser = subscription.metadata?.user_id;
  if (owner !== customerId || (namedUser && namedUser !== user.id)) {
    console.error(`[plan-change-route] subscription ${subscriptionId} does not belong to user ${user.id}; refused.`);
    return { ok: false, status: 403, error: 'This subscription does not belong to your account.', code: 'not_owner' };
  }
  return { ok: true, value: { user, customerId, subscription } };
}

/** The JSON body, or an empty object. Never throws. */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface InboxChoiceRow {
  id: string;
  email: string;
  workspaceId: string;
  /** Preselected to stay active at the target plan's cap. */
  keep: boolean;
}

/**
 * The owner's connected inboxes, ranked the way parking will rank them
 * (parking.ts chooseActiveInboxes: customer order, already active, 30-day
 * usage, age), with the ones that would stay active at `plan`'s cap marked.
 * `cap` is null when the plan (or a grandfather / comped grant) is unlimited.
 * Read with the service role, scoped to the owner's own workspaces.
 */
export async function inboxChoice(
  ownerId: string,
  plan: PlanId | 'free',
  keepOrder: readonly string[] = [],
): Promise<{ cap: number | null; inboxes: InboxChoiceRow[]; overCap: boolean }> {
  const db = createServiceRoleClient();
  const { data: workspaces } = await db
    .from('workspaces')
    .select('id')
    .eq('owner_id', ownerId)
    .is('deleted_at', null);
  const ids = (workspaces ?? []).map((w) => w.id);
  if (ids.length === 0) return { cap: null, inboxes: [], overCap: false };

  const { data: entitlements } = await db
    .from('user_usage_entitlements')
    .select('kind, unlimited_inboxes, expires_at')
    .eq('user_id', ownerId);
  const live = (entitlements ?? []).filter((e) => !e.expires_at || new Date(e.expires_at).getTime() > Date.now());
  const cap = inboxCapFor(plan, {
    unlimitedInboxes: live.some((e) => e.unlimited_inboxes === true),
    compedScale: live.some((e) => e.kind === 'comped_scale'),
  });

  const { data: rows } = await db
    .from('inboxes')
    .select('id, email_address, workspace_id, created_at, parked_at')
    .in('workspace_id', ids)
    .is('deleted_at', null);

  const out: InboxChoiceRow[] = [];
  let overCap = false;
  for (const workspaceId of ids) {
    const inWorkspace = (rows ?? []).filter((r) => r.workspace_id === workspaceId);
    if (inWorkspace.length === 0) continue;
    const usage = await db.rpc('workspace_inbox_activity', { p_workspace_id: workspaceId, p_days: PARKING_USAGE_DAYS });
    const calls = new Map<string, number>((usage.data ?? []).map((u) => [u.inbox_id, u.calls ?? 0]));
    const choice = chooseActiveInboxes(
      inWorkspace.map((r) => ({ id: r.id, created_at: r.created_at, parked_at: r.parked_at, calls: calls.get(r.id) ?? 0 })),
      cap,
      keepOrder,
    );
    if (choice.parked.length > 0) overCap = true;
    const email = new Map(inWorkspace.map((r) => [r.id, r.email_address ?? '']));
    for (const inbox of choice.active) out.push({ id: inbox.id, email: email.get(inbox.id) ?? '', workspaceId, keep: true });
    for (const inbox of choice.parked) out.push({ id: inbox.id, email: email.get(inbox.id) ?? '', workspaceId, keep: false });
  }
  return { cap, inboxes: out, overCap };
}

/** Unix seconds to ISO, or null. */
export function isoOf(seconds: number | null | undefined): string | null {
  return seconds == null ? null : new Date(seconds * 1000).toISOString();
}
