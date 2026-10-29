-- ============================================================
-- public.inboxes: independent verifier's bypass attempts
-- ============================================================
-- Covers 20261016160200_inboxes_lock_user_writes_and_secret_columns.sql from
-- angles the fixer's own test (inboxes_user_access.sql) does not:
--   - filter/sort oracles on secret columns (PostgREST ?imap_password=like.x*)
--   - whole-row references (to_jsonb(row), row::text) that would serialise
--     the credentials
--   - INSERT ... ON CONFLICT DO UPDATE (PostgREST upsert) by the OWNER
--   - anon reading anything at all
--   - an outsider (no membership) still sees no rows
--   - the embedded projection other tables use (activity_log -> inboxes)
-- Each of these would pass (i.e. succeed) on origin/main.
-- ============================================================

BEGIN;
SELECT plan(14);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('a0f00000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'vfy-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('a0f00000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'vfy-outsider@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.users (id, email, display_name) VALUES
  ('a0f00000-0000-0000-0000-0000000000a1', 'vfy-owner@rls-test.invalid', 'Owner'),
  ('a0f00000-0000-0000-0000-0000000000d4', 'vfy-outsider@rls-test.invalid', 'Outsider')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('a0f0aaaa-0000-0000-0000-00000000000a', 'vfy-company', 'Company', 'a0f00000-0000-0000-0000-0000000000a1', 'pro')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('a0f0aaaa-0000-0000-0000-00000000000a', 'a0f00000-0000-0000-0000-0000000000a1', 'owner')
ON CONFLICT DO NOTHING;

INSERT INTO public.inboxes (
  id, workspace_id, provider, email_address, display_name, status,
  imap_host, imap_port, smtp_host, smtp_port, imap_password,
  oauth_access_token, oauth_refresh_token
) VALUES (
  'a0f01111-0000-0000-0000-000000000001', 'a0f0aaaa-0000-0000-0000-00000000000a',
  'imap', 'vfy@company.invalid', 'VFY', 'active',
  'imap.company.invalid', 993, 'smtp.company.invalid', 465, 'ciphertext-imap',
  'ciphertext-access', 'ciphertext-refresh'
);

INSERT INTO public.activity_log (workspace_id, inbox_id, tool_name, status)
VALUES ('a0f0aaaa-0000-0000-0000-00000000000a', 'a0f01111-0000-0000-0000-000000000001', 'list_emails', 'success');

-- ------------------------------------------------------------
-- Owner: even the owner has no direct write or secret read
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"a0f00000-0000-0000-0000-0000000000a1","role":"authenticated"}';

SELECT throws_ok(
  $$SELECT id FROM public.inboxes WHERE imap_password LIKE 'cipher%'$$,
  '42501', NULL, '[owner] cannot filter on imap_password (no byte-by-byte oracle)');
SELECT throws_ok(
  $$SELECT id FROM public.inboxes ORDER BY oauth_refresh_token$$,
  '42501', NULL, '[owner] cannot sort on oauth_refresh_token');
SELECT throws_ok(
  $$SELECT to_jsonb(i) FROM public.inboxes i$$,
  '42501', NULL, '[owner] cannot serialise the whole row with to_jsonb');
SELECT throws_ok(
  $$SELECT i::text FROM public.inboxes i$$,
  '42501', NULL, '[owner] cannot cast the whole row to text');
SELECT throws_ok(
  $$SELECT count(*) FROM public.inboxes WHERE oauth_access_token IS NOT NULL$$,
  '42501', NULL, '[owner] cannot probe whether an OAuth token is stored');
SELECT throws_ok(
  $$INSERT INTO public.inboxes (id, workspace_id, provider, email_address)
    VALUES ('a0f01111-0000-0000-0000-000000000001', 'a0f0aaaa-0000-0000-0000-00000000000a', 'imap', 'vfy@company.invalid')
    ON CONFLICT (id) DO UPDATE SET imap_host = 'imap.attacker.invalid'$$,
  '42501', NULL, '[owner] cannot upsert (INSERT .. ON CONFLICT DO UPDATE)');
SELECT throws_ok(
  $$TRUNCATE public.inboxes$$,
  '42501', NULL, '[owner] cannot TRUNCATE');

-- Legit reads still work: count, health columns, embedded projection.
SELECT is(
  (SELECT count(*)::int FROM public.inboxes WHERE workspace_id = 'a0f0aaaa-0000-0000-0000-00000000000a'),
  1, '[owner] count(*) on inboxes still works');
SELECT is(
  (SELECT i.email_address || '|' || coalesce(i.display_name, '')
     FROM public.activity_log a JOIN public.inboxes i ON i.id = a.inbox_id
    WHERE a.workspace_id = 'a0f0aaaa-0000-0000-0000-00000000000a' LIMIT 1),
  'vfy@company.invalid|VFY',
  '[owner] the activity_log -> inboxes(email_address, display_name) embed still resolves');
SELECT is(
  (SELECT status || '|' || coalesce(last_error, '-') || '|' || provider FROM public.inboxes
    WHERE id = 'a0f01111-0000-0000-0000-000000000001'),
  'active|-|imap', '[owner] health columns still readable');

-- ------------------------------------------------------------
-- Outsider: RLS still isolates
-- ------------------------------------------------------------
SET LOCAL "request.jwt.claims" TO '{"sub":"a0f00000-0000-0000-0000-0000000000d4","role":"authenticated"}';
SELECT is(
  (SELECT count(*)::int FROM public.inboxes WHERE id = 'a0f01111-0000-0000-0000-000000000001'),
  0, '[outsider] sees no rows of a workspace they are not in');

-- ------------------------------------------------------------
-- anon: nothing at all
-- ------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE anon;
SET LOCAL "request.jwt.claims" TO '{"role":"anon"}';
SELECT throws_ok(
  $$SELECT id FROM public.inboxes$$,
  '42501', NULL, '[anon] cannot even SELECT id');
SELECT throws_ok(
  $$UPDATE public.inboxes SET imap_host = 'x'$$,
  '42501', NULL, '[anon] cannot UPDATE');

-- ------------------------------------------------------------
-- service_role: whole-row reads used by the routes still work
-- ------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT is(
  (SELECT (to_jsonb(i) ->> 'imap_password') FROM public.inboxes i
    WHERE id = 'a0f01111-0000-0000-0000-000000000001'),
  'ciphertext-imap', '[service_role] select * incl. credentials still works (check route)');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
