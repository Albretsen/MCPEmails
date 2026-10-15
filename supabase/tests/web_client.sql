-- ============================================================
-- Web client: gate column, hidden api key, assistant allowance
-- ============================================================
-- Covers migrations 20261004100000 .. 20261004100300:
--   - workspaces.web_client_enabled defaults false
--   - api_keys.kind: CHECK, one live web_client key per workspace, and the
--     member RLS policies can neither see, create nor edit a system key
--   - the growth functions and their api_keys counts ignore the hidden key
--   - workspace_assistant_allowance / reserve / finalize: caps per plan, the
--     atomic reservation, usage recorded only for runs that used tokens
--   - assistant_usage tenant isolation, and the three functions are not
--     executable by a browser session
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(42);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('c1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'webclient-alice@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('c2000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'webclient-bob@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

-- Explicit fixtures with stable ids; the default workspace auth provisioning
-- creates for each user is left alone.
INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES
  ('ca000000-0000-0000-0000-00000000000a', 'wc-alice-free', 'WC Alice Free', 'c1000000-0000-0000-0000-000000000001', 'free'),
  ('cb000000-0000-0000-0000-00000000000b', 'wc-alice-solo', 'WC Alice Solo', 'c1000000-0000-0000-0000-000000000001', 'solo'),
  ('cc000000-0000-0000-0000-00000000000c', 'wc-bob-personal', 'WC Bob Personal', 'c2000000-0000-0000-0000-000000000002', 'personal'),
  ('cd000000-0000-0000-0000-00000000000d', 'wc-bob-team', 'WC Bob Team', 'c2000000-0000-0000-0000-000000000002', 'pro');

INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES
  ('ca000000-0000-0000-0000-00000000000a', 'c1000000-0000-0000-0000-000000000001', 'owner'),
  ('cb000000-0000-0000-0000-00000000000b', 'c1000000-0000-0000-0000-000000000001', 'owner'),
  ('cc000000-0000-0000-0000-00000000000c', 'c2000000-0000-0000-0000-000000000002', 'owner'),
  ('cd000000-0000-0000-0000-00000000000d', 'c2000000-0000-0000-0000-000000000002', 'owner');

-- ------------------------------------------------------------
-- 1. The gate column
-- ------------------------------------------------------------
SELECT is(
  (SELECT web_client_enabled FROM public.workspaces WHERE id = 'ca000000-0000-0000-0000-00000000000a'),
  false,
  'web_client_enabled defaults to false for a new workspace');
SELECT is(
  (SELECT count(*) FROM public.workspaces WHERE web_client_enabled),
  0::bigint,
  'the migration turns the web client on for nobody');

-- ------------------------------------------------------------
-- 2. api_keys.kind
-- ------------------------------------------------------------
INSERT INTO public.api_keys (id, workspace_id, created_by, name, key_prefix, key_hash, scopes)
VALUES ('c0000000-0000-0000-0000-0000000000a1', 'ca000000-0000-0000-0000-00000000000a',
        'c1000000-0000-0000-0000-000000000001', 'Alice laptop', 'mcpe_test', 'wc-hash-ordinary', '{read:email}');
SELECT is(
  (SELECT kind FROM public.api_keys WHERE id = 'c0000000-0000-0000-0000-0000000000a1'),
  NULL,
  'an ordinary key has kind NULL');

INSERT INTO public.api_keys (id, workspace_id, created_by, name, key_prefix, key_hash, scopes, kind)
VALUES ('c0000000-0000-0000-0000-0000000000a2', 'ca000000-0000-0000-0000-00000000000a',
        NULL, '__web_client__', 'mcpe_webclient', '!web-client:alice-free', '{read:email,send:email}', 'web_client');

SELECT throws_ok(
  $$INSERT INTO public.api_keys (workspace_id, name, key_prefix, key_hash, kind)
    VALUES ('ca000000-0000-0000-0000-00000000000a', 'x', 'p', 'wc-hash-bogus', 'bogus')$$,
  '23514', NULL,
  'kind accepts only NULL or web_client');

SELECT throws_ok(
  $$INSERT INTO public.api_keys (workspace_id, name, key_prefix, key_hash, kind)
    VALUES ('ca000000-0000-0000-0000-00000000000a', '__web_client__', 'mcpe_webclient', '!web-client:second', 'web_client')$$,
  '23505', NULL,
  'a workspace cannot hold two live web_client keys');

SELECT lives_ok(
  $$INSERT INTO public.api_keys (workspace_id, name, key_prefix, key_hash, kind)
    VALUES ('cc000000-0000-0000-0000-00000000000c', '__web_client__', 'mcpe_webclient', '!web-client:bob', 'web_client')$$,
  'another workspace gets its own web_client key');

SELECT lives_ok(
  $$INSERT INTO public.api_keys (workspace_id, name, key_prefix, key_hash, kind, deleted_at)
    VALUES ('ca000000-0000-0000-0000-00000000000a', '__web_client__', 'mcpe_webclient', '!web-client:old', 'web_client', now())$$,
  'a soft-deleted web_client key does not occupy the slot');

-- Member view: Alice, through her own session.
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"c1000000-0000-0000-0000-000000000001","role":"authenticated"}';

SELECT is(
  (SELECT count(*) FROM public.api_keys WHERE workspace_id = 'ca000000-0000-0000-0000-00000000000a'),
  1::bigint,
  'a member lists only the ordinary key');
SELECT is(
  (SELECT count(*) FROM public.api_keys WHERE kind = 'web_client'),
  0::bigint,
  'a member cannot see any web_client key');
SELECT throws_ok(
  $$INSERT INTO public.api_keys (workspace_id, created_by, name, key_prefix, key_hash, kind)
    VALUES ('cb000000-0000-0000-0000-00000000000b', 'c1000000-0000-0000-0000-000000000001',
            '__web_client__', 'mcpe_webclient', '!web-client:forged', 'web_client')$$,
  '42501', NULL,
  'a member cannot create a web_client key');
SELECT lives_ok(
  $$INSERT INTO public.api_keys (workspace_id, created_by, name, key_prefix, key_hash)
    VALUES ('cb000000-0000-0000-0000-00000000000b', 'c1000000-0000-0000-0000-000000000001',
            'Alice second', 'mcpe_test', 'wc-hash-member-made')$$,
  'a member can still create an ordinary key');
-- An UPDATE the policy filters out is not an error: it matches zero rows.
UPDATE public.api_keys SET scopes = '{}' WHERE id = 'c0000000-0000-0000-0000-0000000000a2';
SELECT throws_ok(
  $$UPDATE public.api_keys SET kind = 'web_client' WHERE id = 'c0000000-0000-0000-0000-0000000000a1'$$,
  '42501', NULL,
  'a member cannot turn an ordinary key into a web_client key');

RESET ROLE;

SELECT is(
  (SELECT scopes FROM public.api_keys WHERE id = 'c0000000-0000-0000-0000-0000000000a2'),
  '{read:email,send:email}'::text[],
  'a member''s UPDATE did not reach the web_client key');

-- ------------------------------------------------------------
-- 3. The hidden key is not a credential on the growth board
-- ------------------------------------------------------------
SELECT is(
  (SELECT api_keys FROM public.growth_user_workspaces('c1000000-0000-0000-0000-000000000001', 30)
   WHERE workspace_id = 'ca000000-0000-0000-0000-00000000000a'),
  1,
  'growth_user_workspaces counts the ordinary key only');
SELECT is(
  (SELECT api_keys FROM public.growth_user_workspaces('c2000000-0000-0000-0000-000000000002', 30)
   WHERE workspace_id = 'cc000000-0000-0000-0000-00000000000c'),
  0,
  'a workspace whose only key is the web_client key reports zero keys');
SELECT is(
  (SELECT api_keys FROM public.growth_user_directory(30, 10, 'c2000000-0000-0000-0000-000000000002')),
  0,
  'growth_user_directory counts no key for an owner with only the web_client key');
SELECT is(
  (SELECT api_keys FROM public.growth_user_directory(30, 10, 'c1000000-0000-0000-0000-000000000001')),
  2,
  'growth_user_directory counts an owner''s ordinary keys');
SELECT is(
  (SELECT count(*) FROM public.growth_user_timeline('c2000000-0000-0000-0000-000000000002', 200) WHERE kind = 'key'),
  0::bigint,
  'growth_user_timeline has no key event for the web_client key');
SELECT is(
  (SELECT grants_selected FROM public.revoke_dormant_oauth_grants(90, true)),
  0,
  'the dormant-grant sweep selects nothing here, and still runs with the kind filter');

-- ------------------------------------------------------------
-- 4. Assistant allowance: caps and the counting window
-- ------------------------------------------------------------
SELECT is(
  (SELECT plan || ':' || cap || ':' || used || ':' || remaining
   FROM public.workspace_assistant_allowance('ca000000-0000-0000-0000-00000000000a')),
  'free:20:0:20', 'Free: 20 runs per period');
SELECT is(
  (SELECT cap FROM public.workspace_assistant_allowance('cc000000-0000-0000-0000-00000000000c')),
  200, 'Personal: 200 runs');
SELECT is(
  (SELECT cap FROM public.workspace_assistant_allowance('cb000000-0000-0000-0000-00000000000b')),
  1000, 'solo (sold as Pro): 1000 runs');
SELECT is(
  (SELECT cap FROM public.workspace_assistant_allowance('cd000000-0000-0000-0000-00000000000d')),
  3000, 'pro (sold as Team): 3000 runs');
SELECT is(
  (SELECT count(*) FROM public.workspace_assistant_allowance('00000000-0000-0000-0000-0000000000ff')),
  0::bigint, 'an unknown workspace returns no row');
SELECT is(
  (SELECT period_end - period_start FROM public.workspace_assistant_allowance('ca000000-0000-0000-0000-00000000000a')),
  (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') - date_trunc('month', now() AT TIME ZONE 'UTC'),
  'Free counts over the UTC calendar month');

-- The action-cap exemption does not exempt a workspace from this meter.
UPDATE public.workspaces SET free_action_cap_exempt = true WHERE id = 'ca000000-0000-0000-0000-00000000000a';
SELECT is(
  (SELECT cap FROM public.workspace_assistant_allowance('ca000000-0000-0000-0000-00000000000a')),
  20, 'an action-cap-exempt workspace still has an assistant cap');

-- ------------------------------------------------------------
-- 5. Reserve and finalize
-- ------------------------------------------------------------
CREATE TEMP TABLE wc_reservation ON COMMIT DROP AS
  SELECT * FROM public.reserve_assistant_run('ca000000-0000-0000-0000-00000000000a', 'c1000000-0000-0000-0000-000000000001');

SELECT is((SELECT allowed || ':' || used || ':' || remaining FROM wc_reservation), 'true:1:19',
  'the first run is reserved and occupies a slot');
SELECT is(
  (SELECT used FROM public.workspace_assistant_allowance('ca000000-0000-0000-0000-00000000000a')),
  0, 'a run in flight is not yet a finished run');

SELECT is(
  public.finalize_assistant_run((SELECT reservation_id FROM wc_reservation), 1200, 300, 4500, 'gpt-test'),
  true, 'finalize settles the reservation');
SELECT is(
  (SELECT used || ':' || input_tokens || ':' || output_tokens || ':' || cost_micro_usd
   FROM public.workspace_assistant_allowance('ca000000-0000-0000-0000-00000000000a')),
  '1:1200:300:4500', 'the finished run is counted with its tokens and cost');
SELECT is(
  public.finalize_assistant_run((SELECT reservation_id FROM wc_reservation), 1200, 300, 4500, 'gpt-test'),
  false, 'finalizing twice is a no-op');
SELECT is(
  (SELECT count(*) FROM public.assistant_usage WHERE workspace_id = 'ca000000-0000-0000-0000-00000000000a'),
  1::bigint, 'a double finalize wrote one usage row');

-- A run that never reached the model releases its slot and is not counted.
SELECT is(
  public.finalize_assistant_run(
    (SELECT reservation_id FROM public.reserve_assistant_run('ca000000-0000-0000-0000-00000000000a', 'c1000000-0000-0000-0000-000000000001')),
    0, 0, 0, 'gpt-test'),
  true, 'a zero-token run is settled');
SELECT is(
  (SELECT used FROM public.workspace_assistant_allowance('ca000000-0000-0000-0000-00000000000a')),
  1, 'a zero-token run is not counted against the allowance');

-- Fill the Free allowance: 1 finished + 18 more finished + 1 in flight = 20.
INSERT INTO public.assistant_usage (workspace_id, user_id, model, input_tokens, output_tokens, cost_micro_usd)
SELECT 'ca000000-0000-0000-0000-00000000000a', 'c1000000-0000-0000-0000-000000000001', 'gpt-test', 10, 10, 1
FROM generate_series(1, 18);
SELECT is(
  (SELECT allowed FROM public.reserve_assistant_run('ca000000-0000-0000-0000-00000000000a', 'c1000000-0000-0000-0000-000000000001')),
  true, 'the 20th slot can be reserved');
SELECT is(
  (SELECT allowed || ':' || coalesce(reservation_id::text, 'none') || ':' || remaining
   FROM public.reserve_assistant_run('ca000000-0000-0000-0000-00000000000a', 'c1000000-0000-0000-0000-000000000001')),
  'false:none:0', 'the 21st is refused: finished runs plus the one in flight reach the cap');

-- ------------------------------------------------------------
-- 6. Tenant isolation and function privileges
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"c2000000-0000-0000-0000-000000000002","role":"authenticated"}';
SELECT is(
  (SELECT count(*) FROM public.assistant_usage),
  0::bigint, 'Bob sees none of Alice''s assistant usage');
SELECT throws_ok(
  $$INSERT INTO public.assistant_usage (workspace_id, model) VALUES ('cc000000-0000-0000-0000-00000000000c', 'forged')$$,
  '42501', NULL,
  'a member cannot write assistant usage, even for their own workspace');
SELECT throws_ok(
  $$SELECT * FROM public.workspace_assistant_allowance('ca000000-0000-0000-0000-00000000000a')$$,
  '42501', NULL,
  'a browser session cannot read an allowance by workspace id');
SELECT throws_ok(
  $$SELECT * FROM public.reserve_assistant_run('ca000000-0000-0000-0000-00000000000a', 'c2000000-0000-0000-0000-000000000002')$$,
  '42501', NULL,
  'a browser session cannot reserve a run');
SELECT throws_ok(
  $$SELECT public.finalize_assistant_run('00000000-0000-0000-0000-000000000001', 1, 1, 1, 'x')$$,
  '42501', NULL,
  'a browser session cannot finalize a run');
RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"c1000000-0000-0000-0000-000000000001","role":"authenticated"}';
SELECT is(
  (SELECT count(*) FROM public.assistant_usage WHERE workspace_id = 'ca000000-0000-0000-0000-00000000000a'),
  19::bigint, 'Alice reads her own workspace''s assistant usage');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
