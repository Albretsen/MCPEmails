-- ============================================================
-- MCPEmails: public.workspaces is written by the server only, and the
-- action-usage meter is callable by the service role only.
-- 20261016160100_workspaces_server_owned_writes
--
-- WHY
--   1. Entitlement self-service through PostgREST.
--      20260524150000_row_level_security_policies.sql gave `authenticated` an
--      INSERT policy (owner_id = auth.uid()) and an UPDATE policy
--      (owner_id = auth.uid()) on public.workspaces, with no column limit, and
--      Supabase's default table grants give anon and authenticated full
--      INSERT/UPDATE/DELETE/TRUNCATE. Every signed-up user owns a workspace and
--      holds their own JWT next to the public anon key, so any user could
--        PATCH /rest/v1/workspaces?id=eq.<own>
--          {"plan":"pro","free_action_cap_exempt":true,"web_client_enabled":true}
--      and get Pro limits, an uncapped meter, the hand-allow-listed web client
--      and internal-only flags without paying, or plant another customer's
--      `stripe_customer_id` (see apps/web/app/api/stripe/portal/route.ts).
--
--      Every legitimate write to this table already runs as the service role
--      or inside a SECURITY DEFINER function owned by postgres:
--        - signup: public.handle_new_user() (trigger on auth.users, definer)
--        - extra workspaces: public.create_workspace() (definer, gated on
--          user_billing)
--        - rename / draft-editor preference: PATCH /api/workspaces/[id]
--          (owner/admin check, then the service role)
--        - soft delete, Stripe webhook, onboarding, acquisition stamps,
--          funnel markers, MCP server: service role
--      The two writes that still used the user's own session (the OAuth
--      sign-up attribution stamp in app/auth/callback/route.ts and
--      app/api/analytics/first-tool-reported/route.ts) move to the service role
--      in the same change. So the user's session needs no write privilege at
--      all, and none is kept: there is no column a user may set directly.
--
--   2. reserve_action_usage / finalize_action_usage_reservation.
--      Both are SECURITY DEFINER, take a caller-supplied workspace and cap, and
--      do no auth.uid() check. Their grants only revoked FROM PUBLIC, and
--      Supabase grants EXECUTE on new public functions to anon and
--      authenticated directly, so anyone holding the anon key could reserve and
--      finalise billable actions against any workspace and burn its allowance.
--      Only the MCP server (service role) calls them.
--
-- WHAT
--   - Revoke INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on
--     public.workspaces from anon and authenticated, at table AND column level
--     (a table-level REVOKE leaves column grants in place). SELECT is kept:
--     members read their workspace through RLS (workspaces_select_members).
--   - Drop the two write policies. They no longer authorise anything, and with
--     them gone a future accidental GRANT still matches no row (RLS default
--     deny) instead of reopening owner-wide writes.
--   - Revoke EXECUTE on the two usage functions (and on any other overload of
--     them) from PUBLIC, anon and authenticated; service_role keeps it.
--
-- AUDIT (2026-10-16): every SECURITY DEFINER function in public whose current
-- grants never revoke anon/authenticated. Only the two meter functions are
-- service-role only; the rest are called by user sessions on purpose and
-- scope themselves, so they keep EXECUTE:
--   create_workspace(text)          auth.uid() + user_billing gate; web, user client
--   effective_workspace_plan(uuid)  filters on my_workspace_ids(); web, user client
--   get_current_user_sessions()     auth.uid(); /api/security/sessions, user client
--   get_workspace_members(uuid)     filters on my_workspace_ids(); dashboard, user client
--   my_workspace_ids()              auth.uid(); used by RLS policies
-- Trigger functions (handle_new_user, apply_comped_scale_to_new_workspace,
-- audit_user_usage_entitlement, ...) cannot be called through PostgREST.
--
-- Idempotent: REVOKE of a privilege that is not held, DROP POLICY IF EXISTS
-- and the catalog-driven loops are all safe to re-run.
-- ============================================================

-- ── 1. public.workspaces: no direct writes from user sessions ─────────────────

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.workspaces
  FROM anon, authenticated;

DO $$
DECLARE
  v_col text;
BEGIN
  FOR v_col IN
    SELECT a.attname
      FROM pg_attribute a
     WHERE a.attrelid = 'public.workspaces'::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped
  LOOP
    EXECUTE format(
      'REVOKE INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON TABLE public.workspaces FROM anon, authenticated',
      v_col
    );
  END LOOP;
END
$$;

DROP POLICY IF EXISTS "workspaces_insert_authenticated" ON public.workspaces;
DROP POLICY IF EXISTS "workspaces_update_owner" ON public.workspaces;

-- The service role keeps full write access (it bypasses RLS). Stated
-- explicitly so this file does not depend on Supabase's default grants.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workspaces TO service_role;

COMMENT ON TABLE public.workspaces IS
  'Tenant root. Members SELECT through RLS (workspaces_select_members). '
  'anon/authenticated hold NO write privilege: plan, billing, entitlement and '
  'stamp columns are server-owned. Writes go through the service role or a '
  'SECURITY DEFINER function (handle_new_user, create_workspace). '
  'See 20261016160100_workspaces_server_owned_writes.sql.';

-- ── 2. Service-role-only SECURITY DEFINER functions ─────────────────────────
--
-- Revoked from PUBLIC, anon and authenticated for EVERY overload of each name,
-- so a signature drift between environments cannot leave one exposed. Each
-- one has no auth.uid() check, trusts its arguments, and is called only from
-- service-role code (or from other definer functions / pg_cron).
--
--   reserve_action_usage                 caller-chosen workspace + cap; MCP server
--   finalize_action_usage_reservation    turns any reservation id into billable usage; MCP server

DO $$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY (ARRAY[
         'reserve_action_usage',
         'finalize_action_usage_reservation'
       ])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$$;
