/**
 * Stripe customer management helpers.
 *
 * Server-side only. Never import in client bundles.
 *
 * Responsibilities:
 *  - Create ONE Stripe Customer per USER (the owner) on first checkout.
 *  - Store the resulting `cus_...` ID in `user_billing.stripe_customer_id`.
 *  - Return the existing customer ID on subsequent calls (idempotent).
 *
 * Why user-scoped (not workspace-scoped):
 *  The subscription is tied to the user, so a user reuses a single Stripe
 *  customer across every workspace they own. See
 *  supabase/migrations/20260606000000_user_level_billing.sql.
 */

import { stripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/service';
import type { GetOrCreateCustomerResult } from '@/lib/stripe/plans';

interface GetOrCreateCustomerOptions {
  /** The user (owner) ID — the Stripe customer is keyed to this user. */
  userId: string;
  /** The user's email address, passed to Stripe for the customer record. */
  ownerEmail: string;
  /** Human-readable label (e.g. the user's primary workspace name) for the dashboard. */
  displayName: string;
}

/**
 * Idempotently fetch or create the single Stripe Customer for the given user.
 *
 * 1. Reads `stripe_customer_id` from the user's `user_billing` row.
 * 2. If already set, returns it without touching Stripe.
 * 3. If null/absent, creates a new Stripe Customer, upserts the ID into
 *    `user_billing`, and returns it.
 *
 * The Stripe customer carries `user_id` in its metadata so the webhook can
 * resolve the owner from the customer alone.
 */
export async function getOrCreateStripeCustomer(
  options: GetOrCreateCustomerOptions,
): Promise<GetOrCreateCustomerResult> {
  const { userId, ownerEmail, displayName } = options;

  const supabase = createServiceRoleClient();

  // 1. Read the user's current stripe_customer_id (row may not exist yet).
  const { data: billing, error: readError } = await supabase
    .from('user_billing')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (readError) {
    throw new Error(
      `Failed to read user_billing for ${userId}: ${readError.message}`,
    );
  }

  // 2. Already has a customer; return immediately.
  if (billing?.stripe_customer_id) {
    return { customerId: billing.stripe_customer_id, created: false };
  }

  // 3. Create a new Stripe Customer keyed to the user.
  const customer = await stripe.customers.create({
    email: ownerEmail,
    name: displayName,
    metadata: {
      user_id: userId,
    },
  });

  // 4. Persist the customer ID in user_billing (upsert: row may not exist yet).
  //    onConflict on the user_id PK; we never overwrite an existing customer id
  //    (ignoreDuplicates handles the race where another request created it).
  const { error: writeError } = await supabase
    .from('user_billing')
    .upsert(
      { user_id: userId, stripe_customer_id: customer.id },
      { onConflict: 'user_id', ignoreDuplicates: true },
    );

  if (writeError) {
    // The customer was created in Stripe but couldn't be saved. Delete it so a
    // retry does not leave one empty customer per attempt, then surface.
    await deleteStripeCustomerQuietly(customer.id);
    throw new Error(
      `Stripe customer ${customer.id} created but could not be saved for user ${userId}: ${writeError.message}`,
    );
  }

  // If a concurrent request already wrote a customer (ignoreDuplicates), re-read
  // to return the winning one rather than the orphan we just created.
  const { data: after } = await supabase
    .from('user_billing')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (after?.stripe_customer_id && after.stripe_customer_id !== customer.id) {
    // Lost the race: ours was never saved, so nothing will ever use it.
    await deleteStripeCustomerQuietly(customer.id);
    return { customerId: after.stripe_customer_id, created: false };
  }

  return { customerId: customer.id, created: true };
}

/** Delete a customer this request created. Never throws; logs on failure. */
async function deleteStripeCustomerQuietly(customerId: string): Promise<boolean> {
  try {
    await stripe.customers.del(customerId);
    return true;
  } catch (err) {
    console.error('[stripe-customer] could not delete unused customer', {
      customerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Undo `getOrCreateStripeCustomer` for a checkout that failed before Stripe
 * returned a session. Call it ONLY when that call answered `created: true`
 * in the same request: the customer is minutes old and nothing else holds it.
 *
 * Clears `user_billing.stripe_customer_id` first, and only while the row still
 * names this customer and carries no subscription, so a concurrent request
 * that already saw the id is never left pointing at a deleted customer
 * without a reason; then deletes the customer in Stripe. If the row moved on,
 * the customer is left alone. Never throws: a failed clean-up is logged and
 * the checkout's own error stands.
 */
export async function discardNewStripeCustomer(userId: string, customerId: string): Promise<void> {
  try {
    const supabase = createServiceRoleClient();
    const { data, error } = await supabase
      .from('user_billing')
      .update({ stripe_customer_id: null })
      .eq('user_id', userId)
      .eq('stripe_customer_id', customerId)
      .is('stripe_subscription_id', null)
      .select('user_id');
    if (error) {
      console.error('[stripe-customer] could not clear unused customer', { customerId, error: error.message });
      return;
    }
    if (!data || data.length === 0) return;
    await deleteStripeCustomerQuietly(customerId);
  } catch (err) {
    console.error('[stripe-customer] discard failed', {
      customerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
