-- ============================================================
-- SAML SSO data model: sso_connections, sso_domains, signup triggers
-- ============================================================
-- Covers 20261019140000_sso_connections.sql.
--
-- A verified domain routes every sign-in for that domain to one company's
-- identity provider, so a self-granted verification is an account takeover
-- of every user on the domain. Proven here:
--   - browser sessions cannot write the provider id, status, enforced,
--     verified_at or the verification token
--   - only owner/admin of the workspace read or write its rows
--   - consumer and malformed domains are refused, input is normalised
--   - a domain is verified on at most one connection
--   - the lookup returns a provider only for a verified domain on an active
--     connection of a live workspace, and only the service role may call it
--   - an SSO user gets a public.users row and no personal workspace, even
--     when an account with the same email already exists
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(49);

-- ------------------------------------------------------------
-- 0. Fixtures (as the migration owner, which bypasses RLS)
-- ------------------------------------------------------------
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('550e0000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'sso-owner@sso-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('550e0000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'sso-admin@sso-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('550e0000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'sso-member@sso-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('550e0000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'sso-outsider@sso-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('550eaaaa-0000-0000-0000-00000000000a', 'sso-ws-a', 'Company WS', '550e0000-0000-0000-0000-0000000000a1', 'pro'),
  ('550ebbbb-0000-0000-0000-00000000000b', 'sso-ws-b', 'Outsider WS', '550e0000-0000-0000-0000-0000000000c1', 'pro')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('550eaaaa-0000-0000-0000-00000000000a', '550e0000-0000-0000-0000-0000000000a1', 'owner'),
  ('550eaaaa-0000-0000-0000-00000000000a', '550e0000-0000-0000-0000-0000000000a2', 'admin'),
  ('550eaaaa-0000-0000-0000-00000000000a', '550e0000-0000-0000-0000-0000000000b1', 'member'),
  ('550ebbbb-0000-0000-0000-00000000000b', '550e0000-0000-0000-0000-0000000000c1', 'owner')
ON CONFLICT DO NOTHING;

INSERT INTO public.sso_connections (id, workspace_id, supabase_sso_provider_id, display_name, status) VALUES
  ('550ec000-0000-0000-0000-0000000000a1', '550eaaaa-0000-0000-0000-00000000000a',
   '550ed000-0000-0000-0000-0000000000a1', 'Entra', 'active'),
  ('550ec000-0000-0000-0000-0000000000c1', '550ebbbb-0000-0000-0000-00000000000b',
   '550ed000-0000-0000-0000-0000000000c1', 'Outsider Entra', 'active');

-- The writer claims the OTHER workspace; the trigger must overrule it.
INSERT INTO public.sso_domains (id, connection_id, workspace_id, domain, verified_at) VALUES
  ('550ee000-0000-0000-0000-000000000001', '550ec000-0000-0000-0000-0000000000a1',
   '550ebbbb-0000-0000-0000-00000000000b', '  Company-SSO.Example. ', now());
INSERT INTO public.sso_domains (id, connection_id, domain) VALUES
  ('550ee000-0000-0000-0000-000000000002', '550ec000-0000-0000-0000-0000000000a1', 'pending-sso.example');

-- ------------------------------------------------------------
-- 1. Catalog
-- ------------------------------------------------------------
SELECT ok(
  (SELECT bool_and(c.relrowsecurity) FROM pg_class c
    WHERE c.oid IN ('public.sso_connections'::regclass, 'public.sso_domains'::regclass)),
  'RLS is enabled on both tables');

SELECT ok(NOT has_column_privilege('authenticated', 'public.sso_connections', 'supabase_sso_provider_id', 'INSERT')
      AND NOT has_column_privilege('authenticated', 'public.sso_connections', 'supabase_sso_provider_id', 'UPDATE'),
  'authenticated cannot write the Supabase provider id');
SELECT ok(NOT has_column_privilege('authenticated', 'public.sso_connections', 'status', 'INSERT')
      AND NOT has_column_privilege('authenticated', 'public.sso_connections', 'status', 'UPDATE'),
  'authenticated cannot write status');
SELECT ok(NOT has_column_privilege('authenticated', 'public.sso_connections', 'enforced', 'INSERT')
      AND NOT has_column_privilege('authenticated', 'public.sso_connections', 'enforced', 'UPDATE'),
  'authenticated cannot write enforced');
SELECT ok(NOT has_column_privilege('authenticated', 'public.sso_domains', 'verified_at', 'INSERT')
      AND NOT has_column_privilege('authenticated', 'public.sso_domains', 'verified_at', 'UPDATE'),
  'authenticated cannot write verified_at');
SELECT ok(NOT has_column_privilege('authenticated', 'public.sso_domains', 'verification_token', 'INSERT')
      AND NOT has_column_privilege('authenticated', 'public.sso_domains', 'verification_token', 'UPDATE'),
  'authenticated cannot choose the verification token');
SELECT ok(NOT has_any_column_privilege('anon', 'public.sso_connections', 'SELECT,INSERT,UPDATE')
      AND NOT has_any_column_privilege('anon', 'public.sso_domains', 'SELECT,INSERT,UPDATE')
      AND NOT has_table_privilege('anon', 'public.sso_connections', 'DELETE')
      AND NOT has_table_privilege('anon', 'public.sso_domains', 'DELETE'),
  'anon has no privilege on either table');
SELECT ok(NOT has_table_privilege('authenticated', 'public.sso_connections', 'TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_table_privilege('authenticated', 'public.sso_domains', 'TRUNCATE,REFERENCES,TRIGGER'),
  'authenticated has no TRUNCATE, REFERENCES or TRIGGER');
SELECT ok(NOT has_function_privilege('anon', 'public.sso_provider_for_domain(text)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.sso_provider_for_domain(text)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.sso_provider_for_domain(text)', 'EXECUTE'),
  'only the service role may call the sign-in lookup');

-- ------------------------------------------------------------
-- 2. Triggers and constraints (as the owner role)
-- ------------------------------------------------------------
SELECT is(
  (SELECT workspace_id FROM public.sso_domains WHERE id = '550ee000-0000-0000-0000-000000000001'),
  '550eaaaa-0000-0000-0000-00000000000a'::uuid,
  'workspace_id follows the connection, not the writer');
SELECT is(
  (SELECT domain FROM public.sso_domains WHERE id = '550ee000-0000-0000-0000-000000000001'),
  'company-sso.example',
  'the domain is trimmed, lower-cased and loses its trailing dot');
SELECT ok(
  (SELECT verification_token ~ '^[a-z0-9]{32}$' FROM public.sso_domains WHERE id = '550ee000-0000-0000-0000-000000000002'),
  'a verification token is generated');

SELECT throws_ok(
  $$INSERT INTO public.sso_domains (connection_id, domain) VALUES ('550ec000-0000-0000-0000-0000000000a1', 'gmail.com')$$,
  '23514', NULL, 'gmail.com is refused');
SELECT throws_ok(
  $$INSERT INTO public.sso_domains (connection_id, domain) VALUES ('550ec000-0000-0000-0000-0000000000a1', 'Yahoo.co.jp')$$,
  '23514', NULL, 'a Yahoo ccTLD is refused, whatever its case');
SELECT throws_ok(
  $$INSERT INTO public.sso_domains (connection_id, domain) VALUES ('550ec000-0000-0000-0000-0000000000a1', 'outlook.com')$$,
  '23514', NULL, 'outlook.com is refused');
SELECT throws_ok(
  $$INSERT INTO public.sso_domains (connection_id, domain) VALUES ('550ec000-0000-0000-0000-0000000000a1', 'eu.icloud.com')$$,
  '23514', NULL, 'a subdomain of a consumer domain is refused');
SELECT throws_ok(
  $$INSERT INTO public.sso_domains (connection_id, domain) VALUES ('550ec000-0000-0000-0000-0000000000a1', '10.0.0.1')$$,
  '23514', NULL, 'an IP address is refused');
SELECT throws_ok(
  $$INSERT INTO public.sso_domains (connection_id, domain) VALUES ('550ec000-0000-0000-0000-0000000000a1', 'localhost')$$,
  '23514', NULL, 'a single-label host is refused');
SELECT lives_ok(
  $$INSERT INTO public.sso_domains (connection_id, domain) VALUES ('550ec000-0000-0000-0000-0000000000a1', 'yahoo.sso-test.example')$$,
  'a brand word as somebody''s subdomain is a company domain');

SELECT throws_ok(
  $$INSERT INTO public.sso_connections (workspace_id, display_name, status) VALUES ('550eaaaa-0000-0000-0000-00000000000a', 'x', 'active')$$,
  '23514', NULL, 'an active connection needs a provider id');
SELECT throws_ok(
  $$INSERT INTO public.sso_connections (workspace_id, display_name, enforced) VALUES ('550eaaaa-0000-0000-0000-00000000000a', 'x', true)$$,
  '23514', NULL, 'a draft connection cannot be enforced');
SELECT throws_ok(
  $$INSERT INTO public.sso_connections (workspace_id, display_name, default_role) VALUES ('550eaaaa-0000-0000-0000-00000000000a', 'x', 'admin')$$,
  '23514', NULL, 'SSO never hands out admin by default');

-- One verified owner per domain; pending duplicates are allowed.
SELECT lives_ok(
  $$INSERT INTO public.sso_domains (connection_id, domain) VALUES ('550ec000-0000-0000-0000-0000000000c1', 'company-sso.example')$$,
  'another workspace may claim a domain while it is unverified there');
SELECT throws_ok(
  $$UPDATE public.sso_domains SET verified_at = now()
     WHERE connection_id = '550ec000-0000-0000-0000-0000000000c1' AND domain = 'company-sso.example'$$,
  '23505', NULL, 'but cannot verify a domain already verified elsewhere');

SELECT throws_ok(
  $$UPDATE public.sso_domains SET domain = 'other-sso.example' WHERE id = '550ee000-0000-0000-0000-000000000001'$$,
  '23514', NULL, 'a verified domain cannot be repointed');

-- ------------------------------------------------------------
-- 3. Sign-in lookup
-- ------------------------------------------------------------
SELECT is(public.sso_provider_for_domain('company-sso.example'),
  '550ed000-0000-0000-0000-0000000000a1'::uuid, 'a verified domain on an active connection routes');
SELECT is(public.sso_provider_for_domain(' Company-SSO.EXAMPLE. '),
  '550ed000-0000-0000-0000-0000000000a1'::uuid, 'the lookup normalises its input');
SELECT is(public.sso_provider_for_domain('pending-sso.example'), NULL::uuid,
  'an unverified domain does not route');
SELECT is(public.sso_provider_for_domain('unknown-sso.example'), NULL::uuid,
  'an unknown domain does not route');

UPDATE public.sso_connections SET status = 'disabled' WHERE id = '550ec000-0000-0000-0000-0000000000a1';
SELECT is(public.sso_provider_for_domain('company-sso.example'), NULL::uuid,
  'a disabled connection does not route');
UPDATE public.sso_connections SET status = 'active' WHERE id = '550ec000-0000-0000-0000-0000000000a1';

UPDATE public.workspaces SET deleted_at = now() WHERE id = '550eaaaa-0000-0000-0000-00000000000a';
SELECT is(public.sso_provider_for_domain('company-sso.example'), NULL::uuid,
  'a deleted workspace does not route');
UPDATE public.workspaces SET deleted_at = NULL WHERE id = '550eaaaa-0000-0000-0000-00000000000a';

UPDATE public.sso_domains SET verification_token = replace(gen_random_uuid()::text, '-', '')
 WHERE id = '550ee000-0000-0000-0000-000000000001';
SELECT is(public.sso_provider_for_domain('company-sso.example'), NULL::uuid,
  'rotating the token drops verification');
UPDATE public.sso_domains SET verified_at = now() WHERE id = '550ee000-0000-0000-0000-000000000001';

-- ------------------------------------------------------------
-- 4. Signup triggers
-- ------------------------------------------------------------
-- An SSO sign-in by somebody who already has an account with this email.
-- Supabase Auth sets is_sso_user, which exempts the row from its own
-- auth.users email uniqueness.
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, is_sso_user, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('550e0000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'sso-member@sso-test.invalid', '', now(), now(), now(), true,
   '{"provider":"sso:550ed000-0000-0000-0000-0000000000a1","providers":["sso:550ed000-0000-0000-0000-0000000000a1"]}',
   '{"name":"Member Via SSO"}');

SELECT is(
  (SELECT sso_provider_id FROM public.users WHERE id = '550e0000-0000-0000-0000-0000000000d1'),
  '550ed000-0000-0000-0000-0000000000a1'::uuid,
  'an SSO user gets a public.users row tagged with its provider, beside the same-email account');
SELECT is(
  (SELECT display_name FROM public.users WHERE id = '550e0000-0000-0000-0000-0000000000d1'),
  'Member Via SSO',
  'the SSO user''s display name comes from the SAML name attribute');
SELECT is(
  (SELECT count(*)::int FROM public.workspaces WHERE owner_id = '550e0000-0000-0000-0000-0000000000d1'),
  0,
  'an SSO user gets no personal workspace');
SELECT is(
  (SELECT count(*)::int FROM public.workspace_members WHERE user_id = '550e0000-0000-0000-0000-0000000000d1'),
  0,
  'an SSO user is a member of nothing until the sign-in code adds them');
SELECT is(
  (SELECT count(*)::int FROM public.workspaces WHERE owner_id = '550e0000-0000-0000-0000-0000000000b1'),
  1,
  'a non-SSO user still gets a personal workspace');
SELECT throws_ok(
  $$UPDATE public.users SET email = 'sso-member@sso-test.invalid' WHERE id = '550e0000-0000-0000-0000-0000000000a2'$$,
  '23505', NULL, 'two non-SSO users still cannot share an email');

-- ------------------------------------------------------------
-- 5. The workspace owner (a browser session)
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"550e0000-0000-0000-0000-0000000000a1","role":"authenticated"}';

SELECT is(
  (SELECT count(*)::int FROM public.sso_connections),
  1,
  '[owner] reads its own workspace''s connection only');
SELECT lives_ok(
  $$INSERT INTO public.sso_connections (workspace_id, display_name, default_role)
    VALUES ('550eaaaa-0000-0000-0000-00000000000a', 'Second', 'viewer')$$,
  '[owner] creates a draft connection');
SELECT is(
  (SELECT created_by FROM public.sso_connections WHERE display_name = 'Second'),
  '550e0000-0000-0000-0000-0000000000a1'::uuid,
  '[owner] created_by is the caller');
SELECT throws_ok(
  $$UPDATE public.sso_connections SET status = 'active' WHERE display_name = 'Second'$$,
  '42501', NULL, '[owner] cannot activate a connection');
SELECT throws_ok(
  $$UPDATE public.sso_domains SET verified_at = now() WHERE id = '550ee000-0000-0000-0000-000000000002'$$,
  '42501', NULL, '[owner] cannot mark a domain verified');
SELECT throws_ok(
  $$INSERT INTO public.sso_connections (workspace_id, display_name) VALUES ('550ebbbb-0000-0000-0000-00000000000b', 'Hijack')$$,
  '42501', NULL, '[owner] cannot create a connection in another workspace');
SELECT throws_ok(
  $$INSERT INTO public.sso_domains (connection_id, domain) VALUES ('550ec000-0000-0000-0000-0000000000c1', 'hijack-sso.example')$$,
  '42501', NULL, '[owner] cannot add a domain to another workspace''s connection');

-- Deleting an active connection with a provider is a no-op; a fresh draft goes.
DELETE FROM public.sso_connections WHERE workspace_id = '550eaaaa-0000-0000-0000-00000000000a';

-- ------------------------------------------------------------
-- 6. An admin, a member, and an outsider
-- ------------------------------------------------------------
SET LOCAL "request.jwt.claims" TO '{"sub":"550e0000-0000-0000-0000-0000000000a2","role":"authenticated"}';
SELECT is(
  (SELECT count(*)::int FROM public.sso_domains),
  3,
  '[admin] reads the workspace''s domains');

SET LOCAL "request.jwt.claims" TO '{"sub":"550e0000-0000-0000-0000-0000000000b1","role":"authenticated"}';
SELECT is(
  (SELECT count(*)::int FROM public.sso_connections) + (SELECT count(*)::int FROM public.sso_domains),
  0,
  '[member] sees no SSO configuration');

SET LOCAL "request.jwt.claims" TO '{"sub":"550e0000-0000-0000-0000-0000000000c1","role":"authenticated"}';
SELECT is(
  (SELECT count(*)::int FROM public.sso_domains WHERE workspace_id = '550eaaaa-0000-0000-0000-00000000000a'),
  0,
  '[outsider] sees no domain of another workspace');

RESET ROLE;

SELECT is(
  (SELECT array_agg(id ORDER BY id) FROM public.sso_connections WHERE workspace_id = '550eaaaa-0000-0000-0000-00000000000a'),
  ARRAY['550ec000-0000-0000-0000-0000000000a1']::uuid[],
  '[owner] deleted the draft but not the active connection');

SELECT * FROM finish();
ROLLBACK;
