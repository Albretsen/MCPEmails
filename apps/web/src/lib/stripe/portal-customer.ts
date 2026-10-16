/**
 * Ownership check for the billing portal's legacy customer fallback.
 *
 * `user_billing.stripe_customer_id` is written only by server code (checkout,
 * webhook), so the portal trusts it. `workspaces.stripe_customer_id` is a
 * legacy copy from the workspace-scoped billing of May/June 2026. Until
 * 20261016160100_workspaces_server_owned_writes.sql a workspace owner could
 * write that column through PostgREST, and its UNIQUE constraint was dropped in
 * 20260607040000, so a value already stored there proves nothing. Before the
 * portal opens a session for such an id, the Stripe customer itself has to say
 * it belongs to the caller.
 *
 * Every customer this app has created carries ownership metadata:
 *   - since 2026-06-03: `metadata.user_id` (src/lib/stripe/customer.ts)
 *   - 2026-05-25 .. 2026-06-03: `metadata.workspace_id` (workspace-scoped era)
 * A customer created by hand in the Stripe dashboard has neither; it is
 * accepted only when its email is the caller's own confirmed email address.
 */

export interface PortalCustomerCandidate {
  id: string;
  deleted?: boolean | null;
  email?: string | null;
  metadata?: Record<string, string> | null;
}

export interface PortalCaller {
  id: string;
  email?: string | null;
  /** Supabase's confirmation stamp. An unconfirmed address proves nothing. */
  email_confirmed_at?: string | null;
}

export type PortalOwnershipVerdict =
  | { owned: true; via: 'user_id' | 'workspace_id' | 'email' }
  | { owned: false; reason: 'deleted' | 'other_user' | 'other_workspace' | 'no_proof' };

/**
 * Decide whether `customer` belongs to `caller`.
 *
 * `ownedWorkspaceIds` is the list of workspaces the caller owns, read by the
 * server (never taken from the request).
 *
 * A present ownership field that names someone else is final: it is never
 * overridden by a weaker signal such as a matching email.
 */
export function verifyPortalCustomerOwnership(
  customer: PortalCustomerCandidate,
  caller: PortalCaller,
  ownedWorkspaceIds: readonly string[],
): PortalOwnershipVerdict {
  if (customer.deleted) return { owned: false, reason: 'deleted' };

  const metadata = customer.metadata ?? {};
  const metaUserId = typeof metadata.user_id === 'string' ? metadata.user_id.trim() : '';
  if (metaUserId) {
    return metaUserId === caller.id
      ? { owned: true, via: 'user_id' }
      : { owned: false, reason: 'other_user' };
  }

  const metaWorkspaceId = typeof metadata.workspace_id === 'string' ? metadata.workspace_id.trim() : '';
  if (metaWorkspaceId) {
    return ownedWorkspaceIds.includes(metaWorkspaceId)
      ? { owned: true, via: 'workspace_id' }
      : { owned: false, reason: 'other_workspace' };
  }

  const customerEmail = normaliseEmail(customer.email);
  const callerEmail = normaliseEmail(caller.email);
  if (customerEmail && callerEmail && caller.email_confirmed_at && customerEmail === callerEmail) {
    return { owned: true, via: 'email' };
  }
  return { owned: false, reason: 'no_proof' };
}

function normaliseEmail(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
