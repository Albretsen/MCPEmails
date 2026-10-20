-- ============================================================
-- mcp_tools_call_preflight (migration 20261020100000)
-- ============================================================
-- The tools/call pre-handler reads in one round trip. Pins: the three key
-- filters authenticateRequest applies (hash, not revoked, not expired), the
-- window counts in caller order, the workspace and entitlement rows, the
-- allowance only on request, and service-role-only execution.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(16);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('9f000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'preflight-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('af000000-0000-0000-0000-000000000010', 'preflight-ws', 'Preflight', '9f000000-0000-0000-0000-000000000001', 'personal');

INSERT INTO public.api_keys (id, workspace_id, created_by, name, key_prefix, key_hash, scopes, expires_at, deleted_at)
VALUES
  ('bf000000-0000-0000-0000-000000000001', 'af000000-0000-0000-0000-000000000010', '9f000000-0000-0000-0000-000000000001',
   'Live', 'mcpe_li', 'preflight_hash_live', ARRAY['read:email'], NULL, NULL),
  ('bf000000-0000-0000-0000-000000000002', 'af000000-0000-0000-0000-000000000010', '9f000000-0000-0000-0000-000000000001',
   'Revoked', 'mcpe_rv', 'preflight_hash_revoked', ARRAY['read:email'], NULL, now() - interval '1 minute'),
  ('bf000000-0000-0000-0000-000000000003', 'af000000-0000-0000-0000-000000000010', '9f000000-0000-0000-0000-000000000001',
   'Expired', 'mcpe_ex', 'preflight_hash_expired', ARRAY['read:email'], now() - interval '1 minute', NULL),
  ('bf000000-0000-0000-0000-000000000004', 'af000000-0000-0000-0000-000000000010', '9f000000-0000-0000-0000-000000000001',
   'Future', 'mcpe_fu', 'preflight_hash_future', ARRAY['read:email'], now() + interval '1 day', NULL);

-- Three rows for the live key 10, 20 and 30 seconds ago, one for another key
-- of the same workspace. All inside one minute, so no partition boundary.
INSERT INTO public.activity_log (workspace_id, api_key_id, tool_name, status, created_at)
VALUES
  ('af000000-0000-0000-0000-000000000010', 'bf000000-0000-0000-0000-000000000001', 'email_read', 'success', now() - interval '10 seconds'),
  ('af000000-0000-0000-0000-000000000010', 'bf000000-0000-0000-0000-000000000001', 'email_read', 'success', now() - interval '20 seconds'),
  ('af000000-0000-0000-0000-000000000010', 'bf000000-0000-0000-0000-000000000001', 'email_read', 'success', now() - interval '30 seconds'),
  ('af000000-0000-0000-0000-000000000010', 'bf000000-0000-0000-0000-000000000004', 'email_read', 'success', now() - interval '5 seconds');

INSERT INTO public.user_usage_entitlements (user_id, kind, reason, source)
VALUES ('9f000000-0000-0000-0000-000000000001', 'comped_scale', 'pgTAP fixture', 'support');

CREATE TEMP TABLE preflight_answer AS
SELECT public.mcp_tools_call_preflight(
  'preflight_hash_live',
  ARRAY[now() - interval '15 seconds', now() - interval '25 seconds', now() - interval '1 minute'],
  now() - interval '1 minute',
  true
) AS a;

SELECT is((SELECT a->'key'->>'id' FROM preflight_answer), 'bf000000-0000-0000-0000-000000000001',
  'a live key is returned');
SELECT is((SELECT a->'key'->>'key_hash' FROM preflight_answer), 'preflight_hash_live',
  'with the hash acceptKeyRow compares');
SELECT is((SELECT count(*)::int FROM preflight_answer, jsonb_object_keys(a->'key')), 13,
  'with exactly the 13 columns lookupApiKey selects');
SELECT is((SELECT a->'key_counts' FROM preflight_answer), '[1, 2, 3]'::jsonb,
  'one per-key count per window start, in the caller''s order');
SELECT is((SELECT (a->>'workspace_count')::int FROM preflight_answer), 4,
  'the workspace count covers every key of the workspace');
SELECT is((SELECT a->'workspace'->>'plan' FROM preflight_answer), 'personal',
  'the workspace row carries the plan');
SELECT ok((SELECT a->'workspace' ? 'analytics_first_tool_used_at' FROM preflight_answer),
  'and the activation markers');
SELECT is((SELECT a->'entitlement'->>'kind' FROM preflight_answer), 'comped_scale',
  'the owner''s entitlement is returned');
SELECT is((SELECT a->'allowance'->>'plan' FROM preflight_answer), 'personal',
  'the allowance row is returned when asked for');

SELECT is(
  public.mcp_tools_call_preflight('preflight_hash_live', ARRAY[now()], now(), false)->'allowance',
  'null'::jsonb,
  'and not when it is not');

SELECT is(public.mcp_tools_call_preflight('preflight_hash_revoked', ARRAY[now()], now(), true),
  '{"key": null}'::jsonb, 'a revoked key returns key: null and nothing else');
SELECT is(public.mcp_tools_call_preflight('preflight_hash_expired', ARRAY[now()], now(), true),
  '{"key": null}'::jsonb, 'an expired key returns key: null');
SELECT is(public.mcp_tools_call_preflight('no_such_hash', ARRAY[now()], now(), true),
  '{"key": null}'::jsonb, 'an unknown key returns key: null');
SELECT is(public.mcp_tools_call_preflight('preflight_hash_future', ARRAY[now()], now(), false)->'key'->>'name',
  'Future', 'a key that expires later is live');

SELECT ok(
  NOT has_function_privilege('anon', 'public.mcp_tools_call_preflight(text, timestamptz[], timestamptz, boolean)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.mcp_tools_call_preflight(text, timestamptz[], timestamptz, boolean)', 'EXECUTE'),
  'anon and authenticated cannot execute it');
SELECT ok(
  has_function_privilege('service_role', 'public.mcp_tools_call_preflight(text, timestamptz[], timestamptz, boolean)', 'EXECUTE'),
  'service_role can');

SELECT * FROM finish();
ROLLBACK;
