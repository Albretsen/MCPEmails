import type { SupabaseClient } from '@supabase/supabase-js';
import { VIEWER_SCOPES, viewerScopeList } from '@/lib/api-keys/scopes';

/**
 * The membership side effects that must happen identically wherever a person
 * stops being a member, or stops being allowed to do what their keys do.
 *
 * WHY THESE LIVE TOGETHER. A workspace member's API keys are a credential that
 * outlives the session that created them: they authenticate straight into the
 * MCP server and keep working until `api_keys.deleted_at` is set. So every
 * change to what a person may do in a workspace has to be mirrored onto the
 * keys they are already holding, or the change is cosmetic. Two paths were
 * getting this wrong in opposite directions:
 *
 *   - Admin removal (DELETE /api/workspaces/members/[userId]) got it right,
 *     but its key-revocation step existed only inside that handler, so the
 *     new self-service "leave workspace" flow had nothing to reuse.
 *   - Demotion (PATCH on the same route) did not do it at all. Demoting an
 *     admin to `viewer` changed one row in workspace_members and nothing else,
 *     leaving every key that person had already minted holding `send:email`
 *     and every other write scope, still fully live through the MCP server.
 *
 * Every function here takes the SERVICE-ROLE client. Setting `deleted_at`
 * moves a row out of its own RLS SELECT policy, which Postgres rejects under a
 * user's RLS context ("new row violates row-level security policy"), and the
 * caller is the wrong identity anyway when an admin is acting on someone else.
 * Callers MUST have established authorization before calling in; nothing here
 * authenticates or authorises.
 */

interface WriteFailure {
  error: { message: string } | null;
}

/**
 * Soft-revoke every one of this member's live API keys in this workspace.
 *
 * Used when the person leaves the workspace entirely, by their own hand or an
 * admin's. Scoped to workspace_id so a member of several workspaces keeps the
 * keys they hold in the ones they are still in.
 */
export async function revokeMemberApiKeys(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: SupabaseClient<any>,
  workspaceId: string,
  userId: string,
): Promise<WriteFailure> {
  return service
    .from('api_keys')
    .update({ deleted_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('created_by', userId)
    .is('deleted_at', null);
}

/**
 * Remove a member from a workspace: revoke their keys, then drop the
 * membership row. The order matters. Revoking first means a failure part-way
 * through leaves an over-revoked member rather than an ex-member holding live
 * credentials.
 */
export async function removeWorkspaceMember(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: SupabaseClient<any>,
  workspaceId: string,
  userId: string,
): Promise<WriteFailure> {
  const revoked = await revokeMemberApiKeys(service, workspaceId, userId);
  if (revoked.error) return revoked;

  return service
    .from('workspace_members')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId);
}

export interface DemotionKeyRevocation {
  /** Ids of the keys that were revoked because a viewer may not hold them. */
  revokedKeyIds: string[];
  error: { message: string } | null;
}

/**
 * Bring a newly-demoted viewer's existing keys back inside the read-only
 * allow-list, by revoking the ones that fall outside it.
 *
 * WHY REVOKE RATHER THAN NARROW. Rewriting a live key's `scopes` down to the
 * viewer allow-list is the tempting alternative and it is the wrong one: the
 * user would still be holding a credential they were handed under a
 * description that no longer matches what it does, in a client config they
 * cannot see the scopes of. Their agent would start failing mid-task with
 * permission errors from a key the dashboard still lists as working. Revoking
 * says the true thing out loud: that credential is gone, mint a new one within
 * what you may now do. Keys already inside the allow-list are untouched, so a
 * demoted member does not lose read access they are still entitled to.
 *
 * The scope filter is applied in JS rather than SQL because `scopes` is a
 * text[] and "contains anything outside this set" has no clean PostgREST
 * expression; the row count here is a handful of keys per member.
 */
export async function revokeApiKeysBeyondViewerScopes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: SupabaseClient<any>,
  workspaceId: string,
  userId: string,
): Promise<DemotionKeyRevocation> {
  const { data: keys, error: readError } = await service
    .from('api_keys')
    .select('id, scopes')
    .eq('workspace_id', workspaceId)
    .eq('created_by', userId)
    .is('deleted_at', null);

  if (readError) return { revokedKeyIds: [], error: readError };

  const overPrivileged = (keys ?? [])
    .filter((k: { scopes: string[] | null }) =>
      (k.scopes ?? []).some((s) => !VIEWER_SCOPES.has(s)))
    .map((k: { id: string }) => k.id);

  if (overPrivileged.length === 0) return { revokedKeyIds: [], error: null };

  const { error: writeError } = await service
    .from('api_keys')
    .update({ deleted_at: new Date().toISOString() })
    .in('id', overPrivileged)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null);

  if (writeError) return { revokedKeyIds: [], error: writeError };
  return { revokedKeyIds: overPrivileged, error: null };
}

/** Sentence for the demotion response, naming what a viewer is left with. */
export function demotionRevocationNotice(count: number): string {
  return count === 1
    ? `1 API key was revoked because a viewer may only hold keys scoped to ${viewerScopeList()}.`
    : `${count} API keys were revoked because a viewer may only hold keys scoped to ${viewerScopeList()}.`;
}
