import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import type { SsoDefaultRole } from '@/lib/sso/types';

/**
 * Typed wrapper for the team tier's membership contract:
 *
 *   public.add_workspace_member(p_workspace_id uuid, p_user_id uuid,
 *                               p_role text, p_source text) returns void
 *
 * SECURITY DEFINER, enforces the seat cap, idempotent. The team tier owns it
 * and the workspace_members table; SSO code never writes members itself.
 *
 * BLOCKED ON THAT CONTRACT. As of 2026-10-19 the function exists neither on
 * main nor in an open PR. Until it does, PostgREST answers PGRST202 (function
 * not found) and this returns `{ ok: false, reason: 'contract_missing' }`, so
 * the SSO callback refuses the sign-in with a clear error instead of landing
 * the user in a dashboard with no workspace. Nothing else needs to change once
 * the function ships; regenerate database.types.ts then and drop the cast.
 */

export type AddWorkspaceMemberArgs = {
  workspaceId: string;
  userId: string;
  role: SsoDefaultRole;
  source: 'sso';
};

export type AddWorkspaceMemberResult =
  | { ok: true }
  | { ok: false; reason: 'contract_missing' | 'refused'; message: string };

export type AddWorkspaceMember = (args: AddWorkspaceMemberArgs) => Promise<AddWorkspaceMemberResult>;

type RpcError = { code?: string; message: string };

/** PostgREST: the function is not in the schema cache. */
const FUNCTION_NOT_FOUND = 'PGRST202';
/** Postgres: undefined_function, if the call ever reaches the database. */
const UNDEFINED_FUNCTION = '42883';

export function addWorkspaceMemberVia(service: SupabaseClient<Database>): AddWorkspaceMember {
  // Not in the generated Database types yet, so it is called through a
  // narrowly typed view of rpc(), bound back to the client (rpc() reads
  // `this`; see app/api/workspaces/route.ts for the same note).
  const rpc = (service.rpc as unknown as (
    fn: 'add_workspace_member',
    args: { p_workspace_id: string; p_user_id: string; p_role: string; p_source: string },
  ) => PromiseLike<{ error: RpcError | null }>).bind(service);

  return async ({ workspaceId, userId, role, source }) => {
    const { error } = await rpc('add_workspace_member', {
      p_workspace_id: workspaceId,
      p_user_id: userId,
      p_role: role,
      p_source: source,
    });
    if (!error) return { ok: true };
    if (error.code === FUNCTION_NOT_FOUND || error.code === UNDEFINED_FUNCTION) {
      return { ok: false, reason: 'contract_missing', message: error.message };
    }
    // Seat cap, a deleted workspace, or anything else the team tier refuses.
    return { ok: false, reason: 'refused', message: error.message };
  };
}
