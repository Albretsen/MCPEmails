/**
 * Stripe customer management helpers.
 *
 * Server-side only. Never import in client bundles.
 *
 * Responsibilities:
 *  - Create a Stripe Customer for a workspace on first checkout.
 *  - Store the resulting `cus_...` ID in `workspaces.stripe_customer_id`.
 *  - Return the existing customer ID on subsequent calls (idempotent).
 */

import { stripe } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/service';
import type { GetOrCreateCustomerResult } from '@/lib/stripe/plans';

interface GetOrCreateCustomerOptions {
  /** The workspace ID (UUID from `workspaces.id`). */
  workspaceId: string;
  /** The workspace owner's email address, passed to Stripe for the customer record. */
  ownerEmail: string;
  /** Human-readable workspace name, appears in the Stripe dashboard. */
  workspaceName: string;
}

/**
 * Idempotently fetch or create a Stripe Customer for the given workspace.
 *
 * 1. Reads `stripe_customer_id` from the workspace row.
 * 2. If already set, returns it without touching Stripe.
 * 3. If null, creates a new Stripe Customer, writes the ID back to Supabase,
 *    and returns it.
 *
 * Concurrent calls are safe: if two requests race, the `UNIQUE` constraint on
 * `stripe_customer_id` causes the second write to fail; the caller should retry.
 */
export async function getOrCreateStripeCustomer(
  options: GetOrCreateCustomerOptions,
): Promise<GetOrCreateCustomerResult> {
  const { workspaceId, ownerEmail, workspaceName } = options;

  const supabase = createServiceRoleClient();

  // 1. Read current stripe_customer_id.
  const { data: workspace, error: readError } = await supabase
    .from('workspaces')
    .select('stripe_customer_id')
    .eq('id', workspaceId)
    .single();

  if (readError || !workspace) {
    throw new Error(
      `Failed to read workspace ${workspaceId}: ${readError?.message ?? 'not found'}`,
    );
  }

  // 2. Already has a customer; return immediately.
  if (workspace.stripe_customer_id) {
    return { customerId: workspace.stripe_customer_id, created: false };
  }

  // 3. Create a new Stripe Customer.
  const customer = await stripe.customers.create({
    email: ownerEmail,
    name: workspaceName,
    metadata: {
      workspace_id: workspaceId,
    },
  });

  // 4. Persist the customer ID in Supabase.
  const { error: writeError } = await supabase
    .from('workspaces')
    .update({ stripe_customer_id: customer.id })
    .eq('id', workspaceId)
    // Safety: only update if it's still null to avoid overwriting on a race.
    .is('stripe_customer_id', null);

  if (writeError) {
    // The customer was created in Stripe but couldn't be saved. Log and
    // surface the error so the caller can retry (the customer can be
    // recovered by searching Stripe by workspace_id metadata).
    throw new Error(
      `Stripe customer ${customer.id} created but could not be saved to workspace ${workspaceId}: ${writeError.message}`,
    );
  }

  return { customerId: customer.id, created: true };
}
