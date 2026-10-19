/**
 * Row shapes and enums for SAML SSO, as created by
 * supabase/migrations/20261019140000_sso_connections.sql.
 *
 * Hand-written because the migration is not applied yet, so
 * src/types/database.types.ts does not know these tables. Once it is applied
 * and `npm run gen:types` has run, queries should use the generated types and
 * these stay as the app-level names for the same columns.
 *
 * WHO MAY WRITE WHAT (enforced by column grants and RLS, not by this file):
 * owner/admin may create a draft connection, change display_name and
 * default_role, add a pending domain and remove one. supabase_sso_provider_id,
 * status, enforced, verified_at and verification_token are service-role only.
 */

export const SSO_CONNECTION_STATUSES = ['draft', 'active', 'disabled'] as const;
export type SsoConnectionStatus = (typeof SSO_CONNECTION_STATUSES)[number];

/** Roles SSO may hand out on join. Never owner or admin. */
export const SSO_DEFAULT_ROLES = ['member', 'viewer'] as const;
export type SsoDefaultRole = (typeof SSO_DEFAULT_ROLES)[number];

export interface SsoConnection {
  id: string;
  workspace_id: string;
  /** auth.sso_providers.id in Supabase; null until the Management API call. */
  supabase_sso_provider_id: string | null;
  display_name: string;
  status: SsoConnectionStatus;
  /** Refuse every non-SSO sign-in for this connection's verified domains. */
  enforced: boolean;
  default_role: SsoDefaultRole;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SsoDomain {
  id: string;
  connection_id: string;
  workspace_id: string;
  /** Lower case, no trailing dot. */
  domain: string;
  /** Published by the customer as TXT `mcpemails-verification=<token>`. */
  verification_token: string;
  /** Routes sign-ins only when set. */
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}
