-- ============================================================
-- SSO audit trail and the "has an admin tested SSO sign-in" gate
-- ============================================================
-- Covers 20261019152000_sso_audit_events.sql.
--
-- Turning enforcement on refuses every non-SSO sign-in on the company's
-- domains, so the gate in front of it must mean "an owner/admin really got
-- in through SAML". Proven here:
--   - browsers cannot write the table, and cannot call the gate
--   - the action list takes configuration changes and the sign-in rows
--     /auth/callback writes, nothing else
--   - the gate is false for an SSO users row alone (Supabase creates it even
--     for a sign-in our callback refused), for a refused sign-in, for a
--     join row, and for a non-admin; true only for a successful sign-in of
--     an owner/admin through this connection
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(14);

-- ------------------------------------------------------------
-- 0. Fixtures (as the migration owner, which bypasses RLS)
-- ------------------------------------------------------------
-- 770e...a1 owner (email account)          770e...a2 the owner's SSO account
-- 770e...b1 member (email account)         770e...b2 the member's SSO account
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, is_sso_user, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('770e0000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'boss@audit-sso.example', 'x', now(), now(), now(), false, '{"provider":"email"}', '{}'),
  ('770e0000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'boss@audit-sso.example', NULL, now(), now(), now(), true,
   '{"provider":"sso:770ed000-0000-0000-0000-0000000000a1","providers":["sso:770ed000-0000-0000-0000-0000000000a1"]}', '{}'),
  ('770e0000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'staff@audit-sso.example', 'x', now(), now(), now(), false, '{"provider":"email"}', '{}'),
  ('770e0000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'staff@audit-sso.example', NULL, now(), now(), now(), true,
   '{"provider":"sso:770ed000-0000-0000-0000-0000000000a1","providers":["sso:770ed000-0000-0000-0000-0000000000a1"]}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('770eaaaa-0000-0000-0000-00000000000a', 'audit-sso-ws', 'Audit WS', '770e0000-0000-0000-0000-0000000000a1', 'enterprise')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('770eaaaa-0000-0000-0000-00000000000a', '770e0000-0000-0000-0000-0000000000a1', 'owner'),
  ('770eaaaa-0000-0000-0000-00000000000a', '770e0000-0000-0000-0000-0000000000b1', 'member')
ON CONFLICT DO NOTHING;

INSERT INTO public.sso_connections (id, workspace_id, supabase_sso_provider_id, display_name, status) VALUES
  ('770ec000-0000-0000-0000-0000000000a1', '770eaaaa-0000-0000-0000-00000000000a',
   '770ed000-0000-0000-0000-0000000000a1', 'Entra', 'active');

-- ------------------------------------------------------------
-- 1. Grants
-- ------------------------------------------------------------
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sso_audit_events'::regclass),
  'RLS is enabled');
SELECT ok(NOT has_table_privilege('authenticated', 'public.sso_audit_events', 'INSERT,UPDATE,DELETE')
      AND NOT has_table_privilege('anon', 'public.sso_audit_events', 'SELECT,INSERT,UPDATE,DELETE'),
  'browsers cannot write the audit trail; anon cannot read it');
SELECT ok(NOT has_function_privilege('authenticated', 'public.sso_admin_test_sign_in_seen(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.sso_admin_test_sign_in_seen(uuid)', 'EXECUTE'),
  'browsers cannot call the enforce gate');

-- ------------------------------------------------------------
-- 2. What the table accepts
-- ------------------------------------------------------------
SELECT lives_ok($$
  INSERT INTO public.sso_audit_events (workspace_id, connection_id, actor_user_id, action, details, ip_address, user_agent)
  VALUES ('770eaaaa-0000-0000-0000-00000000000a', '770ec000-0000-0000-0000-0000000000a1',
          '770e0000-0000-0000-0000-0000000000a1', 'domain.added', '{"domain":"audit-sso.example"}', NULL, NULL)
$$, 'a configuration change is accepted');
SELECT throws_ok($$
  INSERT INTO public.sso_audit_events (workspace_id, action) VALUES ('770eaaaa-0000-0000-0000-00000000000a', 'sso.sign_in')
$$, '23514', NULL, 'an unknown action is refused');
SELECT throws_ok($$
  INSERT INTO public.sso_audit_events (workspace_id, action, user_agent)
  VALUES ('770eaaaa-0000-0000-0000-00000000000a', 'user.sign_in', repeat('x', 513))
$$, '23514', NULL, 'an over-long user agent is refused');

-- ------------------------------------------------------------
-- 3. The enforce gate
-- ------------------------------------------------------------
SELECT ok((SELECT sso_provider_id FROM public.users WHERE id = '770e0000-0000-0000-0000-0000000000a2')
          = '770ed000-0000-0000-0000-0000000000a1',
  'fixture: the owner''s SSO account has its public.users row');
SELECT is(public.sso_admin_test_sign_in_seen('770ec000-0000-0000-0000-0000000000a1'), false,
  'an SSO users row alone does not count (Supabase creates it even for a refused sign-in)');

INSERT INTO public.sso_audit_events (workspace_id, connection_id, actor_user_id, action, details) VALUES
  ('770eaaaa-0000-0000-0000-00000000000a', '770ec000-0000-0000-0000-0000000000a1',
   '770e0000-0000-0000-0000-0000000000a2', 'user.sign_in', '{"outcome":"error","error_code":"contract_missing"}');
SELECT is(public.sso_admin_test_sign_in_seen('770ec000-0000-0000-0000-0000000000a1'), false,
  'a refused sign-in does not count');

INSERT INTO public.sso_audit_events (workspace_id, connection_id, actor_user_id, action, details) VALUES
  ('770eaaaa-0000-0000-0000-00000000000a', '770ec000-0000-0000-0000-0000000000a1',
   '770e0000-0000-0000-0000-0000000000a2', 'user.jit_join', '{"outcome":"success","error_code":null}');
SELECT is(public.sso_admin_test_sign_in_seen('770ec000-0000-0000-0000-0000000000a1'), false,
  'a join row is not a sign-in');

INSERT INTO public.sso_audit_events (workspace_id, connection_id, actor_user_id, action, details) VALUES
  ('770eaaaa-0000-0000-0000-00000000000a', '770ec000-0000-0000-0000-0000000000a1',
   '770e0000-0000-0000-0000-0000000000b2', 'user.sign_in', '{"outcome":"success","error_code":null}');
SELECT is(public.sso_admin_test_sign_in_seen('770ec000-0000-0000-0000-0000000000a1'), false,
  'a member''s successful sign-in does not count');

INSERT INTO public.sso_audit_events (workspace_id, connection_id, actor_user_id, action, details) VALUES
  ('770eaaaa-0000-0000-0000-00000000000a', '770ec000-0000-0000-0000-0000000000a1',
   '770e0000-0000-0000-0000-0000000000a2', 'user.sign_in', '{"outcome":"success","error_code":null}');
SELECT is(public.sso_admin_test_sign_in_seen('770ec000-0000-0000-0000-0000000000a1'), true,
  'the owner''s successful SSO sign-in (matched by email) counts');

-- The SSO account itself made an admin also counts.
DELETE FROM public.sso_audit_events WHERE actor_user_id = '770e0000-0000-0000-0000-0000000000a2';
UPDATE public.workspace_members SET role = 'admin'
 WHERE workspace_id = '770eaaaa-0000-0000-0000-00000000000a' AND user_id = '770e0000-0000-0000-0000-0000000000b1';
SELECT is(public.sso_admin_test_sign_in_seen('770ec000-0000-0000-0000-0000000000a1'), true,
  'a successful sign-in of an admin (matched by email) counts');

SELECT is(public.sso_admin_test_sign_in_seen('770ec000-0000-0000-0000-00000000ffff'), false,
  'an unknown connection is false');

SELECT * FROM finish();
ROLLBACK;
