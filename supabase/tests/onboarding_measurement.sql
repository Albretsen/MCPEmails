-- ============================================================
-- Onboarding measurement (20261026191717_onboarding_measurement.sql)
-- ============================================================
-- Proves:
--   1. Every new account gets exactly one signup_completed funnel row on its
--      workspace, from the database, with the method taken from the auth
--      provider: email, google, github, azure -> microsoft, else unknown.
--   2. The vocabulary change kept older stages and categories and still
--      refuses an undeclared stage.
--   3. The automation-run marker is documented on activity_log.user_agent.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(10);

INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
)
SELECT
  ('b7000000-0000-0000-0000-00000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'signup' || n || '@measurement-test.invalid',
  'x', now(), now(), now(), meta::jsonb, '{}'
FROM (VALUES
  (1, '{"provider":"email","providers":["email"]}'),
  (2, '{"provider":"google","providers":["google"]}'),
  (3, '{"provider":"github","providers":["github"]}'),
  (4, '{"provider":"azure","providers":["azure"]}'),
  (5, '{}')
) AS v(n, meta);

CREATE TEMP TABLE signup_rows AS
  SELECT right(w.owner_id::text, 1)::int AS n, e.category, e.outcome
  FROM public.product_funnel_events e
  JOIN public.workspaces w ON w.id = e.workspace_id
  WHERE e.stage = 'signup_completed'
    AND w.owner_id::text LIKE 'b7000000-0000-0000-0000-00000000000%';

SELECT is((SELECT count(*)::int FROM signup_rows), 5, 'one signup_completed row per new account');
SELECT is((SELECT category FROM signup_rows WHERE n = 1), 'email', 'password signup is email');
SELECT is((SELECT category FROM signup_rows WHERE n = 2), 'google', 'Google signup is google');
SELECT is((SELECT category FROM signup_rows WHERE n = 3), 'github', 'GitHub signup is github');
SELECT is((SELECT category FROM signup_rows WHERE n = 4), 'microsoft', 'the azure provider is microsoft');
SELECT is((SELECT category FROM signup_rows WHERE n = 5), 'unknown', 'no provider is unknown');
SELECT is((SELECT count(*)::int FROM signup_rows WHERE outcome <> 'success'), 0, 'every row is a success');

SELECT lives_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
    SELECT id, 'first_tool_call', 'success', 'claude' FROM public.workspaces
    WHERE owner_id = 'b7000000-0000-0000-0000-000000000001'$$,
  'older stages and categories are still accepted');

SELECT throws_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
    SELECT id, 'not_a_stage', 'success', 'email' FROM public.workspaces
    WHERE owner_id = 'b7000000-0000-0000-0000-000000000001'$$,
  '23514', NULL, 'an undeclared stage is refused');

SELECT ok(
  col_description('public.activity_log'::regclass,
    (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.activity_log'::regclass AND attname = 'user_agent'))
  LIKE '%mcp-emails-triage-runner%',
  'activity_log.user_agent documents the automation-run marker');

SELECT * FROM finish();
ROLLBACK;
