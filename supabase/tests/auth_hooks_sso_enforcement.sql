-- ============================================================
-- Auth hooks: SSO enforcement and the Microsoft email guard
-- ============================================================
-- Covers 20261019153000_auth_hooks_sso_enforcement.sql.
--
-- Proven here, for the Custom Access Token hook (the enforcer):
--   - on an enforced domain, every non-SSO method is refused: password,
--     magic link, OTP, recovery, Google, GitHub and Microsoft OAuth, and
--     token refresh of an existing session
--   - the same methods are allowed on a domain whose connection is not
--     enforced, once enforcement is turned off, and with the kill switch off
--   - an SSO user of the enforced connection is allowed; an SSO user of
--     another provider asserting the domain is refused
--   - the workspace owner keeps every method (break-glass)
--   - an `azure` OAuth sign-in without a verified email is refused; verified,
--     consumer-tenant, non-OAuth and newer-Google sign-ins are not
--   - the hook fails open on an internal error and leaves claims untouched
-- and for the Before User Created hook (second layer), the same split for
-- new accounts. Plus grants: only supabase_auth_admin calls the hooks.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(72);

-- ------------------------------------------------------------
-- 0. Fixtures (as the migration owner, which bypasses RLS)
-- ------------------------------------------------------------
-- 660e...a1 owner of the company workspace, email on the enforced domain
-- 660e...b1 ordinary (non-SSO) user on the enforced domain
-- 660e...b2 SSO user of the enforced connection's provider
-- 660e...b3 SSO user of a DIFFERENT provider, same domain
-- 660e...c1 ordinary user on a domain whose connection is NOT enforced
-- 660e...d1 Microsoft user, azure identity without xms_edov
-- 660e...d2 Microsoft user, azure identity with xms_edov true
-- 660e...d3 Microsoft personal account (consumer tenant, no xms_edov)
-- 660e...d4 azure identity unverified, but a NEWER google sign-in
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, is_sso_user, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('660e0000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'boss@enforced-sso.example', 'x', now(), now(), now(), false, '{"provider":"email"}', '{}'),
  ('660e0000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'staff@enforced-sso.example', 'x', now(), now(), now(), false, '{"provider":"email"}', '{}'),
  ('660e0000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'staff@enforced-sso.example', NULL, now(), now(), now(), true,
   '{"provider":"sso:660ed000-0000-0000-0000-0000000000a1","providers":["sso:660ed000-0000-0000-0000-0000000000a1"]}', '{}'),
  ('660e0000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'staff@enforced-sso.example', NULL, now(), now(), now(), true,
   '{"provider":"sso:660ed000-0000-0000-0000-0000000000c1","providers":["sso:660ed000-0000-0000-0000-0000000000c1"]}', '{}'),
  ('660e0000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'staff@open-sso.example', 'x', now(), now(), now(), false, '{"provider":"email"}', '{}'),
  ('660e0000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'ms-unverified@hooks-test.example', NULL, now(), now(), now(), false, '{"provider":"email"}', '{}'),
  ('660e0000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'ms-verified@hooks-test.example', NULL, now(), now(), now(), false, '{"provider":"azure"}', '{}'),
  ('660e0000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'ms-personal@hooks-test.example', NULL, now(), now(), now(), false, '{"provider":"azure"}', '{}'),
  ('660e0000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'ms-then-google@hooks-test.example', NULL, now(), now(), now(), false, '{"provider":"azure"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at) VALUES
  -- An unverified Entra email linked to an existing email account: the gap.
  ('ms-d1', '660e0000-0000-0000-0000-0000000000d1',
   '{"sub":"ms-d1","email":"ms-unverified@hooks-test.example","custom_claims":{"tid":"11111111-1111-1111-1111-111111111111"}}',
   'azure', now(), now(), now()),
  ('ms-d2', '660e0000-0000-0000-0000-0000000000d2',
   '{"sub":"ms-d2","email":"ms-verified@hooks-test.example","custom_claims":{"tid":"11111111-1111-1111-1111-111111111111","xms_edov":true}}',
   'azure', now(), now(), now()),
  ('ms-d3', '660e0000-0000-0000-0000-0000000000d3',
   '{"sub":"ms-d3","email":"ms-personal@hooks-test.example","custom_claims":{"tid":"9188040d-6c67-4c5b-b112-36a304b66dad"}}',
   'azure', now(), now(), now()),
  ('ms-d4', '660e0000-0000-0000-0000-0000000000d4',
   '{"sub":"ms-d4","email":"ms-then-google@hooks-test.example","custom_claims":{"tid":"11111111-1111-1111-1111-111111111111"}}',
   'azure', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day'),
  ('google-d4', '660e0000-0000-0000-0000-0000000000d4',
   '{"sub":"google-d4","email":"ms-then-google@hooks-test.example","email_verified":true}',
   'google', now(), now(), now())
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('660eaaaa-0000-0000-0000-00000000000a', 'hooks-ws-enforced', 'Enforced WS', '660e0000-0000-0000-0000-0000000000a1', 'pro'),
  ('660ebbbb-0000-0000-0000-00000000000b', 'hooks-ws-open', 'Open WS', '660e0000-0000-0000-0000-0000000000c1', 'pro')
ON CONFLICT DO NOTHING;

INSERT INTO public.sso_connections (id, workspace_id, supabase_sso_provider_id, display_name, status, enforced) VALUES
  ('660ec000-0000-0000-0000-0000000000a1', '660eaaaa-0000-0000-0000-00000000000a',
   '660ed000-0000-0000-0000-0000000000a1', 'Enforced Entra', 'active', true),
  ('660ec000-0000-0000-0000-0000000000c1', '660ebbbb-0000-0000-0000-00000000000b',
   '660ed000-0000-0000-0000-0000000000c1', 'Open Entra', 'active', false);

INSERT INTO public.sso_domains (connection_id, domain, verified_at) VALUES
  ('660ec000-0000-0000-0000-0000000000a1', 'enforced-sso.example', now()),
  ('660ec000-0000-0000-0000-0000000000c1', 'open-sso.example', now());

-- Every method Supabase can pass, except SSO and the two that never sign in.
CREATE TEMP TABLE non_sso_methods (m text) ON COMMIT DROP;
INSERT INTO non_sso_methods VALUES
  ('password'), ('otp'), ('magiclink'), ('recovery'), ('invite'),
  ('email/signup'), ('oauth'), ('token_refresh');

-- ------------------------------------------------------------
-- 1. Catalog and grants
-- ------------------------------------------------------------
SELECT ok(has_function_privilege('supabase_auth_admin', 'public.auth_hook_custom_access_token(jsonb)', 'EXECUTE')
      AND has_function_privilege('supabase_auth_admin', 'public.auth_hook_before_user_created(jsonb)', 'EXECUTE'),
  'supabase_auth_admin may call both hooks');
SELECT ok(NOT has_function_privilege('anon', 'public.auth_hook_custom_access_token(jsonb)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.auth_hook_custom_access_token(jsonb)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.auth_hook_before_user_created(jsonb)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.auth_hook_before_user_created(jsonb)', 'EXECUTE'),
  'anon and authenticated cannot call the hooks');
SELECT ok(NOT has_function_privilege('anon', 'public.sso_sign_in_required(text)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.sso_sign_in_required(text)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.sso_enforced_connection_for_email(text)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.auth_token_refusal(uuid, text)', 'EXECUTE'),
  'the lookups are not callable from a browser');
SELECT ok(NOT has_table_privilege('anon', 'public.auth_hook_switches', 'SELECT,INSERT,UPDATE,DELETE')
      AND NOT has_table_privilege('authenticated', 'public.auth_hook_switches', 'SELECT,INSERT,UPDATE,DELETE'),
  'browsers cannot read or flip the kill switch');
SELECT is((SELECT count(*)::int FROM public.auth_hook_switches WHERE enabled), 2,
  'both switches ship on');

-- ------------------------------------------------------------
-- 2. Access-token hook: enforced domain
-- ------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM non_sso_methods
    WHERE public.auth_token_refusal('660e0000-0000-0000-0000-0000000000b1', m) IS DISTINCT FROM 'sso_required'),
  0, 'every non-SSO method is refused for a non-SSO user on an enforced domain');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000b1', 'password'), 'sso_required', 'password refused');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000b1', 'magiclink'), 'sso_required', 'magic link refused');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000b1', 'otp'), 'sso_required', 'email OTP refused');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000b1', 'oauth'), 'sso_required', 'Google / GitHub / Microsoft OAuth refused');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000b1', 'token_refresh'), 'sso_required',
  'an existing session stops refreshing');
-- Even a user that signed in with SAML once cannot keep a password session:
-- the decision is on the user row, and this row is not an SSO user.
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000b1', 'sso/saml'), 'sso_required',
  'a non-SSO row is refused whatever method it claims');

SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000b2', 'sso/saml'), NULL,
  'the SSO user of the enforced connection signs in');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000b2', 'token_refresh'), NULL,
  'the SSO user refreshes');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000b3', 'sso/saml'), 'sso_required',
  'an SSO user of another provider asserting the enforced domain is refused');

-- Break-glass.
SELECT is(
  (SELECT count(*)::int FROM non_sso_methods
    WHERE public.auth_token_refusal('660e0000-0000-0000-0000-0000000000a1', m) IS NOT NULL),
  0, 'the workspace owner keeps every method (break-glass)');

-- ------------------------------------------------------------
-- 3. Access-token hook: not enforced
-- ------------------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM non_sso_methods
    WHERE public.auth_token_refusal('660e0000-0000-0000-0000-0000000000c1', m) IS NOT NULL),
  0, 'every method is allowed on a domain whose connection is not enforced');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000c1', 'password'), NULL, 'password allowed, not enforced');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000c1', 'magiclink'), NULL, 'magic link allowed, not enforced');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000c1', 'oauth'), NULL, 'OAuth allowed, not enforced');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000d2', 'password'), NULL,
  'an unrelated domain is allowed');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-00000000ffff', 'password'), NULL,
  'an unknown user id is not refused');

-- An unverified domain on an enforced connection does not enforce.
UPDATE public.sso_domains SET verified_at = NULL WHERE domain = 'enforced-sso.example';
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000b1', 'password'), NULL,
  'an unverified domain does not enforce');
UPDATE public.sso_domains SET verified_at = now() WHERE domain = 'enforced-sso.example';

-- Turning enforcement off lets the same user back in.
UPDATE public.sso_connections SET enforced = false WHERE id = '660ec000-0000-0000-0000-0000000000a1';
SELECT is(
  (SELECT count(*)::int FROM non_sso_methods
    WHERE public.auth_token_refusal('660e0000-0000-0000-0000-0000000000b1', m) IS NOT NULL),
  0, 'every method is allowed again once the connection is not enforced');
UPDATE public.sso_connections SET enforced = true WHERE id = '660ec000-0000-0000-0000-0000000000a1';

-- A disabled connection cannot be enforced (T4 CHECK), and a deleted
-- workspace stops enforcing.
UPDATE public.workspaces SET deleted_at = now() WHERE id = '660eaaaa-0000-0000-0000-00000000000a';
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000b1', 'password'), NULL,
  'a deleted workspace does not enforce');
UPDATE public.workspaces SET deleted_at = NULL WHERE id = '660eaaaa-0000-0000-0000-00000000000a';

-- Kill switch.
UPDATE public.auth_hook_switches SET enabled = false WHERE name = 'sso_enforcement';
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000b1', 'password'), NULL,
  'the sso_enforcement kill switch turns enforcement off');
SELECT is(public.sso_sign_in_required('staff@enforced-sso.example'), false,
  'the route pre-check honours the kill switch');
UPDATE public.auth_hook_switches SET enabled = true WHERE name = 'sso_enforcement';
DELETE FROM public.auth_hook_switches WHERE name = 'sso_enforcement';
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000b1', 'password'), 'sso_required',
  'a missing switch row counts as on');
INSERT INTO public.auth_hook_switches (name, enabled) VALUES ('sso_enforcement', true);

-- ------------------------------------------------------------
-- 4. Access-token hook: Microsoft email guard
-- ------------------------------------------------------------
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000d1', 'oauth'), 'microsoft_email_unverified',
  'an azure sign-in without xms_edov is refused (the PR #144 gap)');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000d1', 'password'), NULL,
  'the same user signing in another way is not refused because of the azure identity');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000d1', 'magiclink'), NULL,
  'magic link is not refused because of the azure identity');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000d2', 'oauth'), NULL,
  'an azure sign-in with xms_edov true is allowed');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000d3', 'oauth'), NULL,
  'a Microsoft personal account is allowed');
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000d4', 'oauth'), NULL,
  'a newer Google sign-in is judged on the Google identity');

UPDATE auth.identities SET identity_data = jsonb_set(identity_data, '{custom_claims,xms_edov}', '"1"')
 WHERE provider_id = 'ms-d1';
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000d1', 'oauth'), NULL,
  'xms_edov "1" counts as verified');
UPDATE auth.identities SET identity_data = jsonb_set(identity_data, '{custom_claims,xms_edov}', 'false')
 WHERE provider_id = 'ms-d1';
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000d1', 'oauth'), 'microsoft_email_unverified',
  'xms_edov false is refused');

UPDATE public.auth_hook_switches SET enabled = false WHERE name = 'azure_email_guard';
SELECT is(public.auth_token_refusal('660e0000-0000-0000-0000-0000000000d1', 'oauth'), NULL,
  'the azure_email_guard kill switch turns the guard off');
UPDATE public.auth_hook_switches SET enabled = true WHERE name = 'azure_email_guard';

SELECT is(public.auth_azure_email_verified('{"custom_claims":{"xms_edov":true}}'), false,
  'xms_edov without an email is not verified');
SELECT is(public.auth_azure_email_verified('{"email":"a@b.example"}'), false,
  'a missing xms_edov is not verified (stricter than Supabase)');
SELECT is(public.auth_azure_email_verified('{"email":"a@b.example","xms_edov":"true"}'), true,
  'a top-level xms_edov "true" is verified');
SELECT is(public.auth_azure_email_verified(NULL), false, 'no data is not verified (never NULL)');

-- ------------------------------------------------------------
-- 5. Access-token hook: the wrapper
-- ------------------------------------------------------------
SELECT is(
  public.auth_hook_custom_access_token(jsonb_build_object(
    'user_id', '660e0000-0000-0000-0000-0000000000b1',
    'authentication_method', 'password',
    'claims', '{"sub":"660e0000-0000-0000-0000-0000000000b1","role":"authenticated"}'::jsonb)),
  '{"error":{"http_code":403,"message":"sso_required"}}'::jsonb,
  'a refusal is a 403 error object with the reason code');
SELECT is(
  public.auth_hook_custom_access_token(jsonb_build_object(
    'user_id', '660e0000-0000-0000-0000-0000000000d1',
    'authentication_method', 'oauth',
    'claims', '{}'::jsonb)),
  '{"error":{"http_code":403,"message":"microsoft_email_unverified"}}'::jsonb,
  'the Microsoft refusal uses its own reason code');
SELECT is(
  public.auth_hook_custom_access_token(jsonb_build_object(
    'user_id', '660e0000-0000-0000-0000-0000000000c1',
    'authentication_method', 'password',
    'claims', '{"sub":"660e0000-0000-0000-0000-0000000000c1","role":"authenticated","aal":"aal1"}'::jsonb)),
  '{"claims":{"sub":"660e0000-0000-0000-0000-0000000000c1","role":"authenticated","aal":"aal1"}}'::jsonb,
  'an allowed sign-in gets its claims back untouched');
SELECT is(
  public.auth_hook_custom_access_token('{"user_id":"not-a-uuid","authentication_method":"password","claims":{"x":1}}'),
  '{"claims":{"x":1}}'::jsonb,
  'an internal error fails open');
SELECT lives_ok(
  $$SELECT public.auth_hook_custom_access_token('{}'::jsonb)$$,
  'an empty event does not throw');

-- ------------------------------------------------------------
-- 6. Before User Created hook
-- ------------------------------------------------------------
SELECT is(public.auth_signup_refusal('{"email":"new@enforced-sso.example","app_metadata":{"provider":"email"}}'),
  'sso_required', 'a new password / magic-link account on an enforced domain is refused');
SELECT is(public.auth_signup_refusal('{"email":"new@enforced-sso.example","app_metadata":{"provider":"google"}}'),
  'sso_required', 'a new Google account on an enforced domain is refused');
SELECT is(public.auth_signup_refusal('{"email":"new@enforced-sso.example","app_metadata":{"provider":"github"}}'),
  'sso_required', 'a new GitHub account on an enforced domain is refused');
SELECT is(public.auth_signup_refusal('{"email":"new@enforced-sso.example","app_metadata":{"provider":"azure"},"user_metadata":{"email":"new@enforced-sso.example","custom_claims":{"xms_edov":true}}}'),
  'sso_required', 'a new verified Microsoft account on an enforced domain is refused');
SELECT is(public.auth_signup_refusal('{"email":"New@Enforced-SSO.example","app_metadata":{"provider":"email"}}'),
  'sso_required', 'the domain match ignores case');
SELECT is(public.auth_signup_refusal('{"email":"new@enforced-sso.example","app_metadata":{"provider":"sso:660ed000-0000-0000-0000-0000000000a1"}}'),
  NULL, 'a new SSO account of the enforced connection is allowed');
-- Any SSO signup passes this layer (the payload's provider format at signup is
-- unverified); the access-token hook refuses the wrong provider (section 2).
SELECT is(public.auth_signup_refusal('{"email":"new@enforced-sso.example","app_metadata":{"provider":"sso:660ed000-0000-0000-0000-0000000000c1"}}'),
  NULL, 'a new SSO account of another provider passes signup (refused at token time)');
SELECT is(public.auth_signup_refusal('{"email":"new@sub.enforced-sso.example","app_metadata":{"provider":"email"}}'),
  NULL, 'a subdomain is not the enforced domain');

SELECT is(public.auth_signup_refusal('{"email":"new@open-sso.example","app_metadata":{"provider":"email"}}'),
  NULL, 'a new password / magic-link account is allowed when not enforced');
SELECT is(public.auth_signup_refusal('{"email":"new@open-sso.example","app_metadata":{"provider":"google"}}'),
  NULL, 'a new Google account is allowed when not enforced');
SELECT is(public.auth_signup_refusal('{"email":"new@open-sso.example","app_metadata":{"provider":"github"}}'),
  NULL, 'a new GitHub account is allowed when not enforced');
SELECT is(public.auth_signup_refusal('{"email":"new@open-sso.example","app_metadata":{"provider":"azure"},"identities":[{"provider":"azure","identity_data":{"email":"new@open-sso.example","custom_claims":{"xms_edov":true}}}]}'),
  NULL, 'a new verified Microsoft account is allowed when not enforced');

SELECT is(public.auth_signup_refusal('{"email":"new@open-sso.example","app_metadata":{"provider":"azure"},"identities":[{"provider":"azure","identity_data":{"email":"new@open-sso.example"}}]}'),
  'microsoft_email_unverified', 'a new Microsoft account without xms_edov is refused');
SELECT is(public.auth_signup_refusal('{"email":"new@open-sso.example","app_metadata":{"provider":"azure"},"user_metadata":{"email":"new@open-sso.example","custom_claims":{"tid":"9188040d-6c67-4c5b-b112-36a304b66dad"}}}'),
  NULL, 'a new Microsoft personal account is allowed (from user_metadata)');

UPDATE public.auth_hook_switches SET enabled = false;
SELECT is(public.auth_signup_refusal('{"email":"new@enforced-sso.example","app_metadata":{"provider":"azure"},"user_metadata":{}}'),
  NULL, 'both kill switches off allows the signup');
UPDATE public.auth_hook_switches SET enabled = true;

SELECT is(public.auth_hook_before_user_created('{"user":{"email":"new@enforced-sso.example","app_metadata":{"provider":"email"}}}'),
  '{"error":{"http_code":403,"message":"sso_required"}}'::jsonb,
  'the signup refusal is a 403 error object');
SELECT is(public.auth_hook_before_user_created('{"user":{"email":"new@open-sso.example","app_metadata":{"provider":"email"}}}'),
  '{}'::jsonb, 'an allowed signup returns {}');
SELECT is(public.auth_hook_before_user_created('{"user":"not an object"}'),
  '{}'::jsonb, 'a malformed event fails open');

-- ------------------------------------------------------------
-- 7. Route pre-check
-- ------------------------------------------------------------
SELECT is(public.sso_sign_in_required('staff@enforced-sso.example'), true, 'pre-check: enforced');
SELECT is(public.sso_sign_in_required(' Staff@Enforced-SSO.example '), true, 'pre-check normalises the email');
SELECT is(public.sso_sign_in_required('boss@enforced-sso.example'), false, 'pre-check: the owner is not told to use SSO');
SELECT is(public.sso_sign_in_required('staff@open-sso.example'), false, 'pre-check: not enforced');
SELECT is(public.sso_sign_in_required('not an email'), false, 'pre-check: not an email');
SELECT is(public.sso_sign_in_required(NULL), false, 'pre-check: NULL');

-- ------------------------------------------------------------
-- 8. Roles
-- ------------------------------------------------------------
-- supabase_auth_admin's EXECUTE is checked in section 1 (the test role cannot
-- SET ROLE to it). A browser role is refused outright:
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public.auth_hook_custom_access_token('{}'::jsonb)$$,
  '42501', NULL, 'authenticated cannot call the access-token hook');
SELECT throws_ok(
  $$SELECT public.sso_sign_in_required('staff@enforced-sso.example')$$,
  '42501', NULL, 'authenticated cannot call the route pre-check');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
