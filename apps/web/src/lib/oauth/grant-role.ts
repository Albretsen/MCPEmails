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
      reason: 'not_member' | 'workspace_deleted' | 'no_allowed_scopes' | 'lookup_failed';
      message: string;
    };

interface LookupResult<T> {
  value: T;
  error: { message: string } | null;
}

/**
 * Run a read, and run it ONE more time if it errors (or throws). A single
 * database blip must not fail a legitimate member's refresh: the client would
 * surface that as a broken connection. Twice in a row is reported as a lookup
 * failure, which the token endpoint answers with server_error without touching
 * the grant, so the client can still retry later.
 */
async function withOneRetry<T>(read: () => Promise<LookupResult<T>>, empty: T): Promise<LookupResult<T>> {
  let last: LookupResult<T> = { value: empty, error: null };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      last = await read();
    } catch (err) {
      last = { value: empty, error: { message: err instanceof Error ? err.message : String(err) } };
    }
    if (!last.error) return last;
  }
  return last;
}

/**
 * Decide whether a grant for (workspaceId, userId) with `scopes` may be issued
 * or rotated right now, and with which scopes. Used by /api/oauth/token on
 * both grants; never throws.
 *
 * Refused when the user is no longer a member, when the workspace itself is
 * soft-deleted (or gone), and when the role leaves no tool scope. Each read is
 * retried once on a transient error.
 */
export async function checkGrantForMember(
  db: SupabaseClient<Database>,
  args: { workspaceId: string; userId: string; scopes: readonly string[] },
): Promise<GrantCheck> {
  const membership = await withOneRetry(async () => {
    const r = await lookupWorkspaceRole(db, args.workspaceId, args.userId);
    return { value: r.role, error: r.error };
  }, null as string | null);

  if (membership.error) {
    return { ok: false, reason: 'lookup_failed', message: membership.error.message };
  }
  const lookup = { role: membership.value };
  if (!lookup.role) {
    return {
      ok: false,
      reason: 'not_member',
      message: 'The user who authorized this connection is no longer a member of the workspace.',
    };
  }

  // A soft-deleted workspace keeps its membership rows, so membership alone
  // does not prove the workspace still exists. A missing row is refused too.
  const workspace = await withOneRetry(async () => {
    const { data, error } = await db
      .from('workspaces')
      .select('id, deleted_at')
      .eq('id', args.workspaceId)
      .maybeSingle();
    return { value: (data as { deleted_at: string | null } | null) ?? null, error };
  }, null as { deleted_at: string | null } | null);

  if (workspace.error) {
    return { ok: false, reason: 'lookup_failed', message: workspace.error.message };
  }
  if (!workspace.value || workspace.value.deleted_at) {
    return {
      ok: false,
      reason: 'workspace_deleted',
      message: 'The workspace this connection belongs to has been deleted.',
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
