import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { isNewAccountSignup } from '@/lib/acquisition-context.mjs';
import { ssoProviderIdOf, type SsoRoute } from '@/lib/sso/sign-in';
import { SSO_AUDIT_EVENTS, type RecordSsoAudit } from '@/lib/sso/audit';
import type { AddWorkspaceMember } from '@/lib/sso/workspace-member';
import type { SsoConnectionStatus, SsoDefaultRole } from '@/lib/sso/types';

/**
 * What /auth/callback does for an SSO session: check the connection still
 * routes this user, then make sure they are a member of its workspace.
 *
 * An SSO sign-in is always its own auth.users row with no personal workspace
 * (the new-user trigger skips `sso:` users), so a user this cannot place in
 * the company workspace has nowhere to land. Every failure therefore refuses
 * the session; the callback signs it out and shows an error.
 *
 * WHY RE-CHECK THE DOMAIN. The identity provider asserts the email. A
 * connection's IdP could assert an address on a domain it does not own, so
 * the user's own email domain must route, through our verified sso_domains,
 * to the very provider they signed in with. That one lookup also refuses an
 * unverified domain and a connection disabled after the redirect.
 */

export type SsoConnectionForJoin = {
  id: string;
  workspace_id: string;
  status: SsoConnectionStatus;
  default_role: SsoDefaultRole;
};

export type SsoJoinDeps = {
  /** ssoRouteForEmail, bound to the service-role rpc. Throws on lookup failure. */
  routeForEmail: (email: unknown) => Promise<SsoRoute>;
  /** The connection that owns a Supabase SSO provider, or null. */
  findConnection: (providerId: string) => Promise<SsoConnectionForJoin | null>;
  addMember: AddWorkspaceMember;
  audit: RecordSsoAudit;
  now?: () => number;
};

export type SsoJoinUser = {
  id: string;
  email?: string | null;
  created_at?: string;
  app_metadata?: { provider?: unknown } | null;
};

export type SsoJoinRefusal = 'sso_not_configured' | 'sso_join_failed';

export type SsoJoinResult =
  | { ok: true; workspaceId: string; joined: boolean }
  | { ok: false; reason: SsoJoinRefusal };

export type SsoRequestMeta = { ipAddress: string | null; userAgent: string | null };

export async function completeSsoSignIn(
  deps: SsoJoinDeps,
  user: SsoJoinUser,
  meta: SsoRequestMeta,
): Promise<SsoJoinResult> {
  const providerId = ssoProviderIdOf(user);
  if (!providerId) return { ok: false, reason: 'sso_not_configured' };

  let connection: SsoConnectionForJoin | null;
  let route: SsoRoute;
  try {
    [connection, route] = await Promise.all([
      deps.findConnection(providerId),
      deps.routeForEmail(user.email),
    ]);
  } catch (err) {
    console.error('[sso-join] lookup failed:', err);
    return { ok: false, reason: 'sso_join_failed' };
  }

  // Unknown provider: nothing to join and no workspace to audit against.
  if (!connection) return { ok: false, reason: 'sso_not_configured' };

  const audit = (event: (typeof SSO_AUDIT_EVENTS)[keyof typeof SSO_AUDIT_EVENTS], errorCode: string | null) =>
    deps.audit({
      workspaceId: connection.workspace_id,
      connectionId: connection.id,
      userId: user.id,
      event,
      status: errorCode ? 'error' : 'success',
      errorCode,
      ...meta,
    });

  if (connection.status !== 'active') {
    await audit(SSO_AUDIT_EVENTS.signIn, 'connection_disabled');
    return { ok: false, reason: 'sso_not_configured' };
  }
  if (!route.sso) {
    // Unverified, removed or unknown domain, or a consumer address.
    await audit(SSO_AUDIT_EVENTS.signIn, 'domain_not_verified');
    return { ok: false, reason: 'sso_not_configured' };
  }
  if (route.providerId !== providerId) {
    await audit(SSO_AUDIT_EVENTS.signIn, 'domain_other_connection');
    return { ok: false, reason: 'sso_not_configured' };
  }

  // Idempotent on the team tier's side, so it runs on every sign-in: a member
  // an admin removed rejoins only while the connection still routes them, and
  // a first attempt that failed (seat cap) succeeds once a seat is free.
  const added = await deps.addMember({
    workspaceId: connection.workspace_id,
    userId: user.id,
    role: connection.default_role,
    source: 'sso',
  });
  if (!added.ok) {
    console.error(`[sso-join] add_workspace_member ${added.reason}:`, added.message);
    await audit(SSO_AUDIT_EVENTS.jitJoin, added.reason);
    return { ok: false, reason: 'sso_join_failed' };
  }

  // add_workspace_member returns void, so "joined" means this is the
  // account's first sign-in (the SSO account was created by this exchange).
  const joined = isNewAccountSignup(user.created_at, deps.now?.() ?? Date.now());
  if (joined) await audit(SSO_AUDIT_EVENTS.jitJoin, null);
  await audit(SSO_AUDIT_EVENTS.signIn, null);
  return { ok: true, workspaceId: connection.workspace_id, joined };
}

/** findConnection backed by the service-role client. */
export function findSsoConnectionVia(
  service: SupabaseClient<Database>,
): SsoJoinDeps['findConnection'] {
  return async (providerId) => {
    const { data, error } = await service
      .from('sso_connections')
      .select('id, workspace_id, status, default_role')
      .eq('supabase_sso_provider_id', providerId)
      .maybeSingle();
    if (error) throw new Error(`sso_connections lookup failed: ${error.message}`);
    // status and default_role are text columns with CHECK constraints, so the
    // generated type is string; the constraint guarantees the narrower union.
    return data as SsoConnectionForJoin | null;
  };
}
