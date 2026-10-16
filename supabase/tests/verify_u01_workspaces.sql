-- ============================================================
-- Independent verification of 20261016160100_workspaces_server_owned_writes.
-- Adversarial cases the fixer's file does not cover. Each of the write cases
-- below succeeded on origin/main (owner-only RLS + default grants).
-- ============================================================
BEGIN;
SELECT plan(14);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('0e100000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'v-owner@verify-u01.invalid', 'x', now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{}'),
  ('0e100000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'v-admin@verify-u01.invalid', 'x', now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{}');

CREATE TEMP TABLE v_ids ON COMMIT DROP AS
SELECT (SELECT id FROM public.workspaces WHERE owner_id = '0e100000-0000-0000-0000-0000000000a1') AS ws,
       (SELECT id FROM public.workspaces WHERE owner_id = '0e100000-0000-0000-0000-0000000000a2') AS admin_ws;
GRANT SELECT ON v_ids TO anon, authenticated, service_role;

-- The admin is an admin member of the owner's workspace.
INSERT INTO public.workspace_members (workspace_id, user_id, role)
SELECT ws, '0e100000-0000-0000-0000-0000000000a2', 'admin' FROM v_ids
ON CONFLICT DO NOTHING;

-- ── Owner: upsert / ON CONFLICT path PostgREST uses for Prefer: resolution ──
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"0e100000-0000-0000-0000-0000000000a1","role":"authenticated"}';

SELECT throws_ok(
  $$INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
    SELECT ws, 'x-upsert', 'x', '0e100000-0000-0000-0000-0000000000a1', 'pro' FROM v_ids
    ON CONFLICT (id) DO UPDATE SET plan = 'pro'$$,
  '42501', NULL, '[upsert] owner cannot upsert their own workspace to pro');
SELECT throws_ok(
  $$UPDATE public.workspaces SET free_action_cap_exempt = true, plan = 'pro'
     WHERE id = (SELECT ws FROM v_ids) RETURNING id$$,
  '42501', NULL, '[update+returning] owner cannot set entitlements with RETURNING');
SELECT throws_ok(
  $$UPDATE public.workspaces SET draft_editor_hidden = true WHERE id = (SELECT ws FROM v_ids)$$,
  '42501', NULL, '[update] draft_editor_hidden goes through the API/MCP server, not PostgREST');
SELECT throws_ok(
  $$UPDATE public.workspaces SET updated_at = now() WHERE id = (SELECT ws FROM v_ids)$$,
  '42501', NULL, '[update] not even updated_at is user-writable');
SELECT is((SELECT plan FROM public.workspaces WHERE id = (SELECT ws FROM v_ids)), 'free',
  '[read] owner still reads, plan unchanged');
RESET ROLE;

-- ── Admin member of someone else's workspace ──
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"0e100000-0000-0000-0000-0000000000a2","role":"authenticated"}';
SELECT is((SELECT count(*)::int FROM public.workspaces WHERE id = (SELECT ws FROM v_ids)), 1,
  '[admin] admin member still reads the shared workspace');
SELECT throws_ok(
  $$UPDATE public.workspaces SET plan = 'pro' WHERE id = (SELECT ws FROM v_ids)$$,
  '42501', NULL, '[admin] admin member cannot change the plan');
SELECT throws_ok(
  $$UPDATE public.workspaces SET web_client_enabled = true WHERE id = (SELECT admin_ws FROM v_ids)$$,
  '42501', NULL, '[admin] admin cannot flip web_client_enabled on their own workspace');
SELECT is(
  (SELECT count(*)::int FROM public.get_workspace_members((SELECT ws FROM v_ids))), 2,
  '[rpc] get_workspace_members (definer, kept) still answers for a member');
RESET ROLE;

-- ── anon ──
SET LOCAL ROLE anon;
SELECT throws_ok(
  $$INSERT INTO public.workspaces (slug, display_name, owner_id, plan)
    VALUES ('anon-pro', 'a', '0e100000-0000-0000-0000-0000000000a1', 'pro')$$,
  '42501', NULL, '[anon] anon cannot insert a workspace');
SELECT throws_ok($$DELETE FROM public.workspaces$$,
  '42501', NULL, '[anon] anon cannot delete');
RESET ROLE;

-- ── Grants: service_role keeps meter EXECUTE on every overload; postgres-owned
--    definer callers unaffected ──
SELECT ok(
  (SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE'))
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('reserve_action_usage', 'finalize_action_usage_reservation')),
  '[catalog] service_role executes every meter overload');
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('reserve_action_usage', 'finalize_action_usage_reservation')
       AND has_function_privilege('public', p.oid, 'EXECUTE')),
  '[catalog] PUBLIC holds no EXECUTE on the meter');
-- Signup provisioning still works end to end for a brand new user (trigger path).
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('0e100000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'v-new@verify-u01.invalid', 'x', now(), now(), now(),
   '{"provider":"google","providers":["google"]}', '{}');
SELECT is((SELECT count(*)::int FROM public.workspace_members m JOIN public.workspaces w ON w.id = m.workspace_id
            WHERE m.user_id = '0e100000-0000-0000-0000-0000000000a3' AND m.role = 'owner'), 1,
  '[signup] OAuth signup still provisions an owned workspace + owner membership');

SELECT * FROM finish();
ROLLBACK;
