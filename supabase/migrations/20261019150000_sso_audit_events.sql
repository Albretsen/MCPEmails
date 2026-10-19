-- ============================================================================
-- SSO admin audit trail, and the "has an admin tested SSO sign-in" check
-- ============================================================================
--
-- WHY A NEW TABLE. The Security page's audit log is public.activity_log, which
-- records MCP tool calls and feeds usage counts, the Free allowance and the
-- growth board. An admin changing SSO settings is not a tool call, and a row
-- there would be counted as usage. So SSO configuration changes get their own
-- append-only table, read by the SSO settings section.
--
-- WHO WRITES. Only the server (service role), from apps/web/app/api/sso/**,
-- after it has checked that the caller is owner/admin of the workspace and the
-- workspace is entitled to SSO. Owner/admin may read their workspace's rows.
-- Nobody may update or delete through the API: rows go away only with their
-- workspace.
--
-- TEST SIGN-IN. Enforcing SSO refuses every other sign-in method for the
-- connection's domains, so a broken SAML setup would lock the company out.
-- The admin route therefore only turns enforcement on after someone who is
-- owner or admin of the workspace has completed a real SAML sign-in through
-- the connection's provider. Supabase never links an SSO identity, so that
-- sign-in leaves its own public.users row with sso_provider_id set (see
-- 20261019140000_sso_connections.sql). sso_admin_test_sign_in_seen() looks
-- for one whose email matches an owner/admin of the workspace, or which is
-- itself an owner/admin member.
--
-- RE-RUNNABLE: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS.
-- Apply after 20261019140000_sso_connections.sql.
-- ============================================================================


-- ── 1. sso_audit_events ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sso_audit_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  connection_id  uuid REFERENCES public.sso_connections(id) ON DELETE SET NULL,
  -- The admin who made the change. NULL only if their account is later deleted.
  actor_user_id  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  action         text NOT NULL
                   CHECK (action IN (
                     'connection.created',
                     'connection.metadata_updated',
                     'connection.default_role_changed',
                     'connection.enforced',
                     'connection.enforcement_removed',
                     'connection.disabled',
                     'connection.enabled',
                     'domain.added',
                     'domain.removed',
                     'domain.verified'
                   )),
  -- Small, value-free context: a domain, a role, a host. Never a token.
  details        jsonb NOT NULL DEFAULT '{}'::jsonb
                   CHECK (jsonb_typeof(details) = 'object' AND pg_column_size(details) <= 2048),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sso_audit_events_workspace_created_idx
  ON public.sso_audit_events (workspace_id, created_at DESC);

ALTER TABLE public.sso_audit_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sso_audit_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sso_audit_events TO authenticated;
GRANT ALL ON TABLE public.sso_audit_events TO service_role;

DROP POLICY IF EXISTS "sso_audit_events_select_admins" ON public.sso_audit_events;
CREATE POLICY "sso_audit_events_select_admins"
  ON public.sso_audit_events FOR SELECT
  TO authenticated
  USING (workspace_id = ANY (public.sso_admin_workspace_ids()));

COMMENT ON TABLE public.sso_audit_events IS
  'Append-only record of SSO configuration changes (connection, domains, enforcement). '
  'Written only by the server after an owner/admin check; owner/admin may read.';


-- ── 2. Has an owner/admin completed a SAML sign-in through this connection? ──
CREATE OR REPLACE FUNCTION public.sso_admin_test_sign_in_seen(p_connection_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH conn AS (
    SELECT c.workspace_id, c.supabase_sso_provider_id AS provider_id
    FROM   public.sso_connections c
    WHERE  c.id = p_connection_id
    AND    c.supabase_sso_provider_id IS NOT NULL
  ),
  admins AS (
    SELECT wm.user_id, lower(u.email) AS email
    FROM   public.workspace_members wm
    JOIN   public.users u ON u.id = wm.user_id
    JOIN   conn ON conn.workspace_id = wm.workspace_id
    WHERE  wm.role IN ('owner', 'admin')
  )
  SELECT EXISTS (
    SELECT 1
    FROM   public.users s
    JOIN   conn ON s.sso_provider_id = conn.provider_id
    WHERE  s.id IN (SELECT user_id FROM admins)
       OR  lower(s.email) IN (SELECT email FROM admins)
  );
$$;

REVOKE ALL ON FUNCTION public.sso_admin_test_sign_in_seen(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sso_admin_test_sign_in_seen(uuid) TO service_role;
