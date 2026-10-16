import type { SupabaseClient } from '@supabase/supabase-js';

import { VIEWER_SCOPES } from '@/lib/api-keys/scopes';
import { IDENTITY_SCOPES } from '@/lib/oauth/metadata';
import type { Database } from '@/types/database.types';

/**
 * What an OAuth grant may carry, given the grantee's CURRENT workspace role.
 *
 * WHY THIS EXISTS. Every other way of getting an MCP credential already applies
 * the viewer rule: POST /api/api-keys and PATCH /api/api-keys/[id] refuse any
 * scope outside VIEWER_SCOPES for a viewer, and demotion revokes keys that fall
 * outside it. The OAuth path did not. The consent POST never read the caller's
 * role, and /api/oauth/token minted whatever the code or refresh chain carried
 * for whoever it was issued to, member or not. So a viewer could consent to
 * send:email/delete:email/manage:automations, and an ex-member could redeem a
 * code or a legacy refresh chain after removal.
 *
 * Both the consent POST and BOTH token grants go through this module so the
 * rule is decided once:
 *
 *   owner/admin/member   every tool scope the client may hold (unchanged).
 *   viewer               only VIEWER_SCOPES.
 *   anything else        treated as viewer: an unknown role must never widen.
 *   not a member         nothing at all; the grant is refused.
 *
 * The OIDC identity scopes (`openid`, `email`) pass through untouched for every
 * role. They unlock only the account's own email at /api/oauth/userinfo and no
 * mailbox, so they are not a permission the viewer rule is about, and they
 * never count as "at least one permission" on their own.
 */

const IDENTITY_SCOPE_SET: ReadonlySet<string> = new Set(IDENTITY_SCOPES);

/** Roles that may hold every tool scope. Mirrors the api-keys routes, which restrict only viewers. */
const FULL_SCOPE_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'member']);

export function isIdentityScope(scope: string): boolean {
  return IDENTITY_SCOPE_SET.has(scope);
}

/** True when the role may only hold the read-only allow-list. */
export function isScopeLimitedRole(role: string | null | undefined): boolean {
  return !FULL_SCOPE_ROLES.has(role ?? '');
}

/**
 * `scopes` narrowed to what `role` may hold, order preserved. Identity scopes
 * are kept. A null role (not a member) keeps nothing.
 */
export function scopesAllowedForRole(
  role: string | null | undefined,
  scopes: readonly string[],
): string[] {
  if (!role) return [];
  if (!isScopeLimitedRole(role)) return [...scopes];
  return scopes.filter((s) => VIEWER_SCOPES.has(s) || IDENTITY_SCOPE_SET.has(s));
}

/** True when `scopes` contains at least one scope that authorizes a tool. */
export function hasToolScope(scopes: readonly string[]): boolean {
  return scopes.some((s) => !IDENTITY_SCOPE_SET.has(s));
}

/**
 * True when `scopes` holds a TOOL scope a viewer may not hold. Identity scopes
 * are ignored, so an OAuth key carrying `openid` next to `read:email` is not
 * mistaken for an over-privileged one.
 */
export function exceedsViewerToolScopes(scopes: readonly string[] | null | undefined): boolean {
  return (scopes ?? []).some((s) => !VIEWER_SCOPES.has(s) && !IDENTITY_SCOPE_SET.has(s));
}

export interface RoleLookup {
  /** The member's role, or null when they are not a member of the workspace. */
  role: string | null;
  error: { message: string } | null;
}

/**
 * The user's role in one workspace. Works with the user-scoped client (RLS lets
 * a member read their own row) and with the service-role client.
 */
export async function lookupWorkspaceRole(
  db: SupabaseClient<Database>,
  workspaceId: string,
  userId: string,
): Promise<RoleLookup> {
  const { data, error } = await db
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) return { role: null, error };
  return { role: (data as { role: string } | null)?.role ?? null, error: null };
}

export type GrantCheck =
  | {
      ok: true;
      role: string;
      /** The scopes the grant may carry now; identical to the input unless narrowed. */
      scopes: string[];
      /** True when at least one scope was dropped because of the role. */
      narrowed: boolean;
    }
  | {
      ok: false;
      reason: 'not_member' | 'no_allowed_scopes' | 'lookup_failed';
      message: string;
    };

/**
 * Decide whether a grant for (workspaceId, userId) with `scopes` may be issued
 * or rotated right now, and with which scopes. Used by /api/oauth/token on
 * both grants; never throws.
 */
export async function checkGrantForMember(
  db: SupabaseClient<Database>,
  args: { workspaceId: string; userId: string; scopes: readonly string[] },
): Promise<GrantCheck> {
  let lookup: RoleLookup;
  try {
    lookup = await lookupWorkspaceRole(db, args.workspaceId, args.userId);
  } catch (err) {
    lookup = { role: null, error: { message: err instanceof Error ? err.message : String(err) } };
  }

  if (lookup.error) {
    return { ok: false, reason: 'lookup_failed', message: lookup.error.message };
  }
  if (!lookup.role) {
    return {
      ok: false,
      reason: 'not_member',
      message: 'The user who authorized this connection is no longer a member of the workspace.',
    };
  }

  const scopes = scopesAllowedForRole(lookup.role, args.scopes);
  if (!hasToolScope(scopes)) {
    return {
      ok: false,
      reason: 'no_allowed_scopes',
      message: 'The user’s workspace role no longer allows any of the permissions on this connection.',
    };
  }

  return { ok: true, role: lookup.role, scopes, narrowed: scopes.length !== args.scopes.length };
}
