-- ============================================================
-- public.workspaces is server-owned; the action meter is service-role only
-- (20261016160100_workspaces_server_owned_writes.sql)
-- ============================================================
-- Proves:
--   1. An authenticated OWNER cannot change any entitlement, billing or stamp
--      column of their own workspace through PostgREST (plan,
--      free_action_cap_exempt, grandfathered, web_client_enabled,
--      draft_editor_enabled, card_diagnostics, stripe_customer_id, deleted_at,
--      owner_id, acquisition/analytics/onboarding stamps), cannot INSERT a
--      workspace (with plan = 'pro' or at all), cannot DELETE or TRUNCATE.
--   2. No column of workspaces is writable by anon or authenticated.
--   3. Every legitimate path still works: members read their workspace, the
--      signup trigger provisions one, create_workspace() (definer) still
--      creates one for a Team user, effective_workspace_plan() still answers,
--      and the service role (rename, webhook plan projection, stamps) writes.
--   4. anon and authenticated cannot execute reserve_action_usage /
--      finalize_action_usage_reservation; service_role can.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(40);

-- ── Seed (postgres) ──────────────────────────────────────────────────────────
-- The real signup trigger provisions each user's default workspace.
INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('5e100000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ws-owner@server-owned.invalid',
   'x', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'),
  ('5e200000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ws-team@server-owned.invalid',
   'x', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}');

CREATE TEMP TABLE t_ids ON COMMIT DROP AS
SELECT
  (SELECT id FROM public.workspaces WHERE owner_id = '5e100000-0000-0000-0000-000000000001') AS owner_ws,
  (SELECT id FROM public.workspaces WHERE owner_id = '5e200000-0000-0000-0000-000000000002') AS team_ws;
GRANT SELECT ON t_ids TO anon, authenticated, service_role;

SELECT isnt((SELECT owner_ws FROM t_ids), NULL, 'the signup trigger still provisions a workspace');
SELECT is((SELECT plan FROM public.workspaces WHERE id = (SELECT owner_ws FROM t_ids)), 'free',
  'a new workspace starts on free');

-- The Team user is entitled to extra workspaces (create_workspace gate).
INSERT INTO public.user_billing (user_id, plan)
VALUES ('5e200000-0000-0000-0000-000000000002', 'pro')
ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan;

-- ── 1. The owner, through their own session ─────────────────────────────────
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO
  '{"sub":"5e100000-0000-0000-0000-000000000001","role":"authenticated"}';

SELECT is((SELECT count(*)::int FROM public.workspaces WHERE id = (SELECT owner_ws FROM t_ids)), 1,
  '[read] the owner still reads their workspace');
SELECT is((SELECT plan FROM public.effective_workspace_plan((SELECT owner_ws FROM t_ids))), 'free',
  '[read] effective_workspace_plan still answers for the owner');

SELECT throws_ok($$UPDATE public.workspaces SET plan = 'pro' WHERE id = (SELECT owner_ws FROM t_ids)$$,
  '42501', NULL, '[update] owner cannot set plan');
SELECT throws_ok($$UPDATE public.workspaces SET free_action_cap_exempt = true WHERE id = (SELECT owner_ws FROM t_ids)$$,
  '42501', NULL, '[update] owner cannot set free_action_cap_exempt');
SELECT throws_ok($$UPDATE public.workspaces SET grandfathered = true WHERE id = (SELECT owner_ws FROM t_ids)$$,
  '42501', NULL, '[update] owner cannot set grandfathered');
SELECT throws_ok($$UPDATE public.workspaces SET web_client_enabled = true WHERE id = (SELECT owner_ws FROM t_ids)$$,
  '42501', NULL, '[update] owner cannot set web_client_enabled');
SELECT throws_ok($$UPDATE public.workspaces SET draft_editor_enabled = true WHERE id = (SELECT owner_ws FROM t_ids)$$,
  '42501', NULL, '[update] owner cannot set draft_editor_enabled');
SELECT throws_ok($$UPDATE public.workspaces SET card_diagnostics = true WHERE id = (SELECT owner_ws FROM t_ids)$$,
  '42501', NULL, '[update] owner cannot set card_diagnostics');
SELECT throws_ok($$UPDATE public.workspaces SET stripe_customer_id = 'cus_victim' WHERE id = (SELECT owner_ws FROM t_ids)$$,
  '42501', NULL, '[update] owner cannot plant a stripe_customer_id');
SELECT throws_ok($$UPDATE public.workspaces SET deleted_at = now() WHERE id = (SELECT owner_ws FROM t_ids)$$,
  '42501', NULL, '[update] owner cannot set deleted_at directly');
SELECT throws_ok($$UPDATE public.workspaces SET owner_id = '5e200000-0000-0000-0000-000000000002' WHERE id = (SELECT owner_ws FROM t_ids)$$,
  '42501', NULL, '[update] owner cannot hand the workspace to someone else');
SELECT throws_ok($$UPDATE public.workspaces SET acquisition_source = 'google_ads' WHERE id = (SELECT owner_ws FROM t_ids)$$,
  '42501', NULL, '[update] owner cannot rewrite attribution');
SELECT throws_ok($$UPDATE public.workspaces SET analytics_first_tool_reported_at = now() WHERE id = (SELECT owner_ws FROM t_ids)$$,
  '42501', NULL, '[update] analytics stamps are server-written');
SELECT throws_ok($$UPDATE public.workspaces SET onboarding_stage = 'value_activation' WHERE id = (SELECT owner_ws FROM t_ids)$$,
  '42501', NULL, '[update] onboarding stamps are server-written');
SELECT throws_ok($$UPDATE public.workspaces SET display_name = 'Renamed' WHERE id = (SELECT owner_ws FROM t_ids)$$,
  '42501', NULL, '[update] even the name goes through PATCH /api/workspaces/[id], not PostgREST');

SELECT throws_ok(
  $$INSERT INTO public.workspaces (slug, display_name, owner_id, plan)
    VALUES ('self-made-pro', 'Self-made Pro', '5e100000-0000-0000-0000-000000000001', 'pro')$$,
  '42501', NULL, '[insert] owner cannot insert a workspace with plan = pro');
SELECT throws_ok(
  $$INSERT INTO public.workspaces (slug, display_name, owner_id)
    VALUES ('self-made-free', 'Self-made', '5e100000-0000-0000-0000-000000000001')$$,
  '42501', NULL, '[insert] owner cannot insert any workspace directly');
SELECT throws_ok($$DELETE FROM public.workspaces WHERE id = (SELECT owner_ws FROM t_ids)$$,
  '42501', NULL, '[delete] owner cannot delete the row directly');
SELECT throws_ok($$TRUNCATE public.workspaces CASCADE$$,
  '42501', NULL, '[truncate] authenticated cannot truncate workspaces');

-- create_workspace() refuses a non-Team caller, as before.
SELECT throws_ok($$SELECT * FROM public.create_workspace('Not allowed')$$,
  'P0001', 'workspace_create_requires_pro', '[rpc] create_workspace still gates on user_billing');

-- ── 2. The usage meter, as authenticated ────────────────────────────────────
SELECT throws_ok(
  $$SELECT * FROM public.reserve_action_usage((SELECT team_ws FROM t_ids), 'email_read', 1, 2147483647,
      now() - interval '1 day', now() + interval '1 day')$$,
  '42501', NULL, '[meter] authenticated cannot reserve usage against any workspace');
SELECT throws_ok(
  $$SELECT public.finalize_action_usage_reservation(gen_random_uuid(), true)$$,
  '42501', NULL, '[meter] authenticated cannot finalize a reservation');

RESET ROLE;

-- ── 3. A Team user still creates a workspace through the definer RPC ─────────
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO
  '{"sub":"5e200000-0000-0000-0000-000000000002","role":"authenticated"}';
SELECT lives_ok($$SELECT * FROM public.create_workspace('Second Team Space')$$,
  '[rpc] create_workspace still creates a workspace for a Team user');
RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM public.workspaces
    WHERE owner_id = '5e200000-0000-0000-0000-000000000002' AND display_name = 'Second Team Space'),
  1, '[rpc] the created workspace exists and is owned by the caller');

-- ── 4. anon ─────────────────────────────────────────────────────────────────
SET LOCAL ROLE anon;
SELECT throws_ok(
  $$SELECT * FROM public.reserve_action_usage((SELECT team_ws FROM t_ids), 'email_read', 1, 2147483647,
      now() - interval '1 day', now() + interval '1 day')$$,
  '42501', NULL, '[meter] anon cannot reserve usage');
SELECT throws_ok(
  $$SELECT public.finalize_action_usage_reservation(gen_random_uuid(), true)$$,
  '42501', NULL, '[meter] anon cannot finalize a reservation');
SELECT throws_ok($$UPDATE public.workspaces SET plan = 'pro'$$,
  '42501', NULL, '[update] anon cannot update workspaces');
RESET ROLE;

-- ── 5. Catalog: nothing writable remains for anon / authenticated ─────────────
SELECT is(
  (SELECT count(*)::int
     FROM pg_attribute a, unnest(ARRAY['anon', 'authenticated']) AS r(role_name),
          unnest(ARRAY['INSERT', 'UPDATE']) AS p(priv)
    WHERE a.attrelid = 'public.workspaces'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND has_column_privilege(r.role_name, a.attrelid, a.attnum, p.priv)),
  0, '[catalog] no workspaces column is insertable or updatable by anon or authenticated');
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.workspaces', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.workspaces', 'DELETE')
  AND NOT has_table_privilege('authenticated', 'public.workspaces', 'TRUNCATE')
  AND NOT has_table_privilege('anon', 'public.workspaces', 'TRUNCATE'),
  '[catalog] no DELETE or TRUNCATE for anon or authenticated');
SELECT ok(has_table_privilege('authenticated', 'public.workspaces', 'SELECT'),
  '[catalog] authenticated keeps SELECT (RLS scopes it to members)');
SELECT is(
  (SELECT count(*)::int FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'workspaces' AND cmd IN ('INSERT', 'UPDATE', 'ALL')),
  0, '[catalog] no INSERT/UPDATE policy remains on workspaces');
SELECT is(
  (SELECT count(*)::int
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
          unnest(ARRAY['anon', 'authenticated']) AS r(role_name)
    WHERE n.nspname = 'public'
      AND p.proname IN ('reserve_action_usage', 'finalize_action_usage_reservation')
      AND has_function_privilege(r.role_name, p.oid, 'EXECUTE')),
  0, '[catalog] no overload of the meter functions is executable by anon or authenticated');

-- ── 6. The service role keeps every server-side write ────────────────────────
SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$UPDATE public.workspaces SET display_name = 'Renamed by the API' WHERE id = (SELECT owner_ws FROM t_ids)$$,
  '[service] rename (PATCH /api/workspaces/[id]) still writes');
SELECT lives_ok(
  $$UPDATE public.workspaces SET plan = 'personal', stripe_customer_id = 'cus_real'
     WHERE id = (SELECT owner_ws FROM t_ids)$$,
  '[service] the Stripe webhook still projects plan and customer');
SELECT lives_ok(
  $$UPDATE public.workspaces SET analytics_first_tool_reported_at = now(), acquisition_source = 'direct'
     WHERE id = (SELECT owner_ws FROM t_ids) AND analytics_first_tool_reported_at IS NULL$$,
  '[service] server stamps (first-tool-reported, signup attribution) still write');
SELECT is(
  (SELECT allowed FROM public.reserve_action_usage((SELECT team_ws FROM t_ids), 'email_read', 1, 5,
      now() - interval '1 day', now() + interval '1 day')),
  true, '[meter] service_role can still reserve');
SELECT is(
  public.finalize_action_usage_reservation(
    (SELECT reservation_id FROM public.reserve_action_usage((SELECT team_ws FROM t_ids), 'email_read', 1, 5,
        now() - interval '1 day', now() + interval '1 day')), true),
  true, '[meter] service_role can still finalize');
RESET ROLE;

SELECT is(
  (SELECT plan || '/' || display_name || '/' || stripe_customer_id FROM public.workspaces WHERE id = (SELECT owner_ws FROM t_ids)),
  'personal/Renamed by the API/cus_real',
  'only the service-role writes landed on the owner''s workspace');

SELECT * FROM finish();
ROLLBACK;
