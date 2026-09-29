-- ============================================================
-- Marketing email consent (20260929100000_marketing_consent.sql)
-- ============================================================
-- Proves the three things the consent record has to be worth anything:
--   1. It is written only when the signup metadata says the box was ticked,
--      with a known wording version, and the timestamp is the database's.
--   2. A signed-in user cannot write it on themselves afterwards, while the
--      unsubscribe columns (the withdrawal path) stay writable.
--   3. The OAuth RPC is service-role only, new accounts only, first write wins.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(26);

-- ================================================================
-- 0. Seed through auth.users, exactly like GoTrue does, so the real
--    on_auth_user_created -> handle_new_user -> public.users path runs.
-- ================================================================

INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  -- ticked the box, password signup
  ('a7000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ticked@consent-test.invalid',
   'x', now(), now(), now(), '{"provider":"email","providers":["email"]}',
   '{"marketing_consent":true,"marketing_consent_version":"signup_checkbox_v1","acquisition_source":"direct"}'),
  -- left the box unticked: no consent keys at all
  ('a7000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'unticked@consent-test.invalid',
   'x', now(), now(), now(), '{"provider":"email","providers":["email"]}',
   '{"acquisition_source":"direct"}'),
  -- the string "true" is not a ticked box
  ('a7000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'stringtrue@consent-test.invalid',
   'x', now(), now(), now(), '{"provider":"email","providers":["email"]}',
   '{"marketing_consent":"true","marketing_consent_version":"signup_checkbox_v1"}'),
  -- ticked, but a wording version we have no record of
  ('a7000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'unknownversion@consent-test.invalid',
   'x', now(), now(), now(), '{"provider":"email","providers":["email"]}',
   '{"marketing_consent":true,"marketing_consent_version":"signup_checkbox_v99"}'),
  -- OAuth signup: provider claims only, never consent keys
  ('a7000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'oauth@consent-test.invalid',
   'x', now(), now(), now(), '{"provider":"google","providers":["google"]}',
   '{"full_name":"OAuth Person","avatar_url":"https://example.invalid/a.png","email_verified":true}'),
  -- an account from yesterday (for the RPC's new-account window)
  ('a7000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'old@consent-test.invalid',
   'x', now(), now() - interval '1 day', now(), '{"provider":"github","providers":["github"]}',
   '{}'),
  -- ticked, but consent explicitly false
  ('a7000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'false@consent-test.invalid',
   'x', now(), now(), now(), '{"provider":"email","providers":["email"]}',
   '{"marketing_consent":false,"marketing_consent_version":"signup_checkbox_v1"}')
ON CONFLICT DO NOTHING;

-- ================================================================
-- 1. Signup trigger
-- ================================================================

SELECT isnt(
  (SELECT marketing_consent_at FROM public.users WHERE id = 'a7000000-0000-0000-0000-000000000001'),
  NULL,
  '[signup] ticked box records a consent timestamp'
);

SELECT is(
  (SELECT marketing_consent_source FROM public.users WHERE id = 'a7000000-0000-0000-0000-000000000001'),
  'signup_checkbox_v1',
  '[signup] ticked box records the wording version'
);

SELECT is(
  (SELECT marketing_consent_at FROM public.users WHERE id = 'a7000000-0000-0000-0000-000000000001'),
  now(),
  '[signup] the timestamp is the database''s now(), not a client value'
);

SELECT ok(
  (SELECT marketing_consent_at IS NULL AND marketing_consent_source IS NULL
     FROM public.users WHERE id = 'a7000000-0000-0000-0000-000000000002'),
  '[signup] unticked box records nothing'
);

SELECT ok(
  (SELECT marketing_consent_at IS NULL FROM public.users WHERE id = 'a7000000-0000-0000-0000-000000000003'),
  '[signup] the string "true" is not consent'
);

SELECT ok(
  (SELECT marketing_consent_at IS NULL FROM public.users WHERE id = 'a7000000-0000-0000-0000-000000000004'),
  '[signup] an unknown wording version is not consent'
);

SELECT ok(
  (SELECT marketing_consent_at IS NULL FROM public.users WHERE id = 'a7000000-0000-0000-0000-000000000005'),
  '[signup] an OAuth signup defaults to no consent'
);

SELECT ok(
  (SELECT marketing_consent_at IS NULL FROM public.users WHERE id = 'a7000000-0000-0000-0000-000000000007'),
  '[signup] marketing_consent false is not consent'
);

-- The trigger did not break the rest of signup provisioning.
SELECT is(
  (SELECT count(*)::int FROM public.workspace_members
     WHERE user_id = 'a7000000-0000-0000-0000-000000000001' AND role = 'owner'),
  1,
  '[signup] the consenting user still gets their owner workspace'
);

-- ================================================================
-- 2. Constraints (as the table owner, i.e. the most privileged writer)
-- ================================================================

SELECT throws_ok(
  $$UPDATE public.users SET marketing_consent_at = now()
     WHERE id = 'a7000000-0000-0000-0000-000000000002'$$,
  '23514',
  NULL,
  '[constraint] a timestamp without a wording version is rejected'
);

SELECT throws_ok(
  $$UPDATE public.users SET marketing_consent_at = now(), marketing_consent_source = 'made_up'
     WHERE id = 'a7000000-0000-0000-0000-000000000002'$$,
  '23514',
  NULL,
  '[constraint] an unknown wording version is rejected'
);

-- ================================================================
-- 3. A signed-in user cannot write consent on themselves
-- ================================================================

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO
  '{"sub":"a7000000-0000-0000-0000-000000000002","role":"authenticated"}';

SELECT throws_ok(
  $$UPDATE public.users
       SET marketing_consent_at = now(), marketing_consent_source = 'signup_checkbox_v1'
     WHERE id = 'a7000000-0000-0000-0000-000000000002'$$,
  '42501',
  NULL,
  '[guard] a user cannot grant themselves consent'
);

SELECT lives_ok(
  $$UPDATE public.users SET display_name = 'Still editable'
     WHERE id = 'a7000000-0000-0000-0000-000000000002'$$,
  '[guard] other own-row updates (display_name) still work'
);

SELECT throws_ok(
  $$SELECT public.record_signup_marketing_consent(
      'a7000000-0000-0000-0000-000000000002'::uuid, 'signup_checkbox_v1')$$,
  '42501',
  NULL,
  '[rpc] authenticated cannot call record_signup_marketing_consent'
);

RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO
  '{"sub":"a7000000-0000-0000-0000-000000000001","role":"authenticated"}';

SELECT throws_ok(
  $$UPDATE public.users SET marketing_consent_at = now() - interval '1 year'
     WHERE id = 'a7000000-0000-0000-0000-000000000001'$$,
  '42501',
  NULL,
  '[guard] a user cannot back-date their consent'
);

SELECT throws_ok(
  $$UPDATE public.users SET marketing_consent_at = NULL, marketing_consent_source = NULL
     WHERE id = 'a7000000-0000-0000-0000-000000000001'$$,
  '42501',
  NULL,
  '[guard] a user cannot erase the consent record (withdrawal goes through unsubscribe)'
);

SELECT lives_ok(
  $$UPDATE public.users SET unsubscribed_at = now()
     WHERE id = 'a7000000-0000-0000-0000-000000000001'$$,
  '[guard] the unsubscribe columns stay writable'
);

RESET ROLE;

SELECT ok(
  (SELECT unsubscribed_at IS NOT NULL AND marketing_consent_source = 'signup_checkbox_v1'
     FROM public.users WHERE id = 'a7000000-0000-0000-0000-000000000001'),
  '[guard] after an unsubscribe the opt-out is set and the consent record is kept'
);

SELECT is(
  (SELECT has_function_privilege('anon', 'public.record_signup_marketing_consent(uuid, text)', 'EXECUTE')),
  false,
  '[rpc] anon cannot call record_signup_marketing_consent'
);

-- ================================================================
-- 4. The OAuth RPC, as the service role (what /auth/callback uses)
-- ================================================================

SET LOCAL ROLE service_role;

SELECT is(
  public.record_signup_marketing_consent('a7000000-0000-0000-0000-000000000005'::uuid, 'signup_checkbox_v99'),
  false,
  '[rpc] an unknown version records nothing'
);

SELECT is(
  public.record_signup_marketing_consent('a7000000-0000-0000-0000-000000000005'::uuid, 'signup_checkbox_v1'),
  true,
  '[rpc] a new OAuth account with the cookie gets consent recorded'
);

SELECT is(
  public.record_signup_marketing_consent('a7000000-0000-0000-0000-000000000005'::uuid, 'signup_checkbox_v1'),
  false,
  '[rpc] a second call does not overwrite the first consent'
);

SELECT is(
  public.record_signup_marketing_consent('a7000000-0000-0000-0000-000000000006'::uuid, 'signup_checkbox_v1'),
  false,
  '[rpc] an account older than the signup window gets nothing'
);

SELECT lives_ok(
  $$UPDATE public.users SET unsubscribed_categories = ARRAY['lifecycle']
     WHERE id = 'a7000000-0000-0000-0000-000000000005'$$,
  '[unsubscribe] the service role can still write the opt-out columns'
);

RESET ROLE;

SELECT ok(
  (SELECT marketing_consent_at = now() AND marketing_consent_source = 'signup_checkbox_v1'
     FROM public.users WHERE id = 'a7000000-0000-0000-0000-000000000005'),
  '[rpc] the recorded timestamp is now() and the version is stored'
);

SELECT ok(
  (SELECT marketing_consent_at IS NULL FROM public.users WHERE id = 'a7000000-0000-0000-0000-000000000006'),
  '[rpc] the old account still has no consent'
);

SELECT * FROM finish();
ROLLBACK;
