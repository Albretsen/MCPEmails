-- ============================================================
-- MCPEmails — Row-Level Security Policies
-- 20260524150000_row_level_security_policies
-- ============================================================
-- Enables RLS on every public table and creates least-privilege
-- policies per the architecture in Documents/Architecture/row-level-security.md.
-- All tenant-scoped tables are filtered via the my_workspace_ids() helper,
-- which resolves the current user's workspace memberships from the JWT.
-- ============================================================

-- ----------------------------------------------------------------
-- Helper: returns the set of workspace IDs the current user is a member of.
-- SECURITY DEFINER so it can read workspace_members regardless of caller role.
-- STABLE so the planner can memoize within a single query.
-- search_path pinned to prevent search-path injection.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_workspace_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ARRAY(
    SELECT workspace_id
    FROM   public.workspace_members
    WHERE  user_id = auth.uid()
  );
$$;

-- ================================================================
-- public.users
-- A user can read and modify only their own row.
-- INSERT is handled by the auth trigger (service_role); no authenticated policy.
-- DELETE is not permitted via application code — cascades from auth.users.
-- ================================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_select_own"
  ON public.users FOR SELECT
  TO authenticated
  USING (id = auth.uid());

CREATE POLICY "users_update_own"
  ON public.users FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- ================================================================
-- public.workspaces
-- Visible to all workspace members; only the owner may update.
-- DELETE denied for authenticated; handled via service_role after ownership check.
-- ================================================================
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

-- SELECT: all members of the workspace can read it.
CREATE POLICY "workspaces_select_members"
  ON public.workspaces FOR SELECT
  TO authenticated
  USING (id = ANY(public.my_workspace_ids()));

-- INSERT: a user may create a workspace they own.
-- The membership row is created by a SECURITY DEFINER trigger / service_role call.
CREATE POLICY "workspaces_insert_authenticated"
  ON public.workspaces FOR INSERT
  TO authenticated
  WITH CHECK (owner_id = auth.uid());

-- UPDATE: only the owner may change workspace settings.
CREATE POLICY "workspaces_update_owner"
  ON public.workspaces FOR UPDATE
  TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- ================================================================
-- public.workspace_members
-- Members can read the membership list; writes are delegated to
-- service_role Edge Functions to prevent privilege escalation.
-- ================================================================
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;

-- SELECT: members can see all members of their own workspace.
CREATE POLICY "workspace_members_select"
  ON public.workspace_members FOR SELECT
  TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

-- INSERT / UPDATE / DELETE: no policies for authenticated.
-- All membership changes go through service_role Edge Functions
-- that verify ownership before executing.

-- ================================================================
-- public.inboxes
-- Scoped to a workspace. Soft-deleted rows (deleted_at IS NOT NULL)
-- are invisible to authenticated; only service_role can see them.
-- Hard DELETE is not permitted; soft delete via UPDATE (sets deleted_at).
-- ================================================================
ALTER TABLE public.inboxes ENABLE ROW LEVEL SECURITY;

-- SELECT: workspace members see active (non-deleted) inboxes.
CREATE POLICY "inboxes_select_members"
  ON public.inboxes FOR SELECT
  TO authenticated
  USING (
    workspace_id = ANY(public.my_workspace_ids())
    AND deleted_at IS NULL
  );

-- INSERT: workspace members may connect a new inbox.
CREATE POLICY "inboxes_insert_members"
  ON public.inboxes FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id = ANY(public.my_workspace_ids())
  );

-- UPDATE: workspace members may update inbox settings.
-- Application code must not allow untrusted writes to credential columns.
CREATE POLICY "inboxes_update_members"
  ON public.inboxes FOR UPDATE
  TO authenticated
  USING (
    workspace_id = ANY(public.my_workspace_ids())
    AND deleted_at IS NULL
  )
  WITH CHECK (
    workspace_id = ANY(public.my_workspace_ids())
  );

-- ================================================================
-- public.api_keys
-- Scoped to a workspace. Revoked keys (deleted_at IS NOT NULL) are
-- hidden from authenticated queries. Hard DELETE not permitted.
-- MCP auth lookups use service_role (workspace not yet known at that point).
-- ================================================================
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- SELECT: workspace members see active (non-revoked) keys.
CREATE POLICY "api_keys_select_members"
  ON public.api_keys FOR SELECT
  TO authenticated
  USING (
    workspace_id = ANY(public.my_workspace_ids())
    AND deleted_at IS NULL
  );

-- INSERT: workspace members may create a key, and must be the creator.
CREATE POLICY "api_keys_insert_members"
  ON public.api_keys FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id = ANY(public.my_workspace_ids())
    AND created_by = auth.uid()
  );

-- UPDATE: workspace members may rename/update scope of an active key.
CREATE POLICY "api_keys_update_members"
  ON public.api_keys FOR UPDATE
  TO authenticated
  USING (
    workspace_id = ANY(public.my_workspace_ids())
    AND deleted_at IS NULL
  )
  WITH CHECK (
    workspace_id = ANY(public.my_workspace_ids())
  );

-- ================================================================
-- public.oauth_states
-- Short-lived nonces scoped to a user. Only the initiating user
-- may read or delete their own state rows. UPDATE not permitted.
-- ================================================================
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

-- SELECT: a user sees only their own unexpired state rows.
CREATE POLICY "oauth_states_select_own"
  ON public.oauth_states FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    AND expires_at > now()
  );

-- INSERT: a user may create a nonce for a workspace they belong to.
CREATE POLICY "oauth_states_insert_own"
  ON public.oauth_states FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id = ANY(public.my_workspace_ids())
    AND user_id = auth.uid()
  );

-- DELETE: the OAuth callback handler consumes (deletes) the state row.
CREATE POLICY "oauth_states_delete_own"
  ON public.oauth_states FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- ================================================================
-- public.activity_log (range-partitioned by created_at)
-- Append-only for authenticated: SELECT only; no UPDATE/DELETE policies.
-- INSERT is performed by service_role MCP Edge Functions.
-- RLS is enabled on the parent and all current partitions.
-- Policies on the parent apply to queries routed through the parent;
-- enabling RLS on each partition covers direct partition queries.
-- ================================================================
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

-- SELECT: workspace members may read their workspace's activity.
CREATE POLICY "activity_log_select_members"
  ON public.activity_log FOR SELECT
  TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

-- Enable RLS on existing partitions (no separate policies needed;
-- the parent's policies apply for queries routed via the parent).
ALTER TABLE public.activity_log_2026_05 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_log_2026_06 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_log_2026_07 ENABLE ROW LEVEL SECURITY;

-- Add matching SELECT policy on each partition for direct partition queries.
CREATE POLICY "activity_log_2026_05_select_members"
  ON public.activity_log_2026_05 FOR SELECT
  TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

CREATE POLICY "activity_log_2026_06_select_members"
  ON public.activity_log_2026_06 FOR SELECT
  TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

CREATE POLICY "activity_log_2026_07_select_members"
  ON public.activity_log_2026_07 FOR SELECT
  TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

-- ================================================================
-- public.auth_logs
-- Security events; append-only. Users may read events tied to their
-- own user ID or to any workspace they belong to.
-- INSERT / UPDATE / DELETE: no authenticated policies.
-- All writes come from service_role Auth hooks and Edge Functions.
-- ================================================================
ALTER TABLE public.auth_logs ENABLE ROW LEVEL SECURITY;

-- SELECT: users see events tied to themselves or their workspaces.
CREATE POLICY "auth_logs_select_own"
  ON public.auth_logs FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR workspace_id = ANY(public.my_workspace_ids())
  );
