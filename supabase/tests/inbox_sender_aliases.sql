-- ============================================================
-- public.inbox_sender_aliases: who may read and write Send As addresses
-- ============================================================
-- Covers 20261018120000_inbox_sender_aliases.sql.
--
-- A verified row lets an inbox put another address in From, so a write by a
-- browser session would skip the verification code entirely. Proven here:
--   - no member (viewer, member, owner) can insert, update or delete a row
--     through PostgREST, so verified_at cannot be self-granted
--   - members read their own workspace's rows, never another workspace's
--   - code_hash and code_attempts are unreadable to authenticated
--   - workspace_id always follows the inbox, whatever the writer sent
--   - one address per inbox, case-insensitively
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(17);

-- ------------------------------------------------------------
-- 0. Fixtures (as the migration owner, which bypasses RLS)
-- ------------------------------------------------------------
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('a5a00000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'alias-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('a5a00000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'alias-outsider@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.users (id, email, display_name) VALUES
  ('a5a00000-0000-0000-0000-0000000000a1', 'alias-owner@rls-test.invalid', 'Owner'),
  ('a5a00000-0000-0000-0000-0000000000c3', 'alias-outsider@rls-test.invalid', 'Outsider')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('a5a0aaaa-0000-0000-0000-00000000000a', 'alias-ws-a', 'Owner WS', 'a5a00000-0000-0000-0000-0000000000a1', 'pro'),
  ('a5a0bbbb-0000-0000-0000-00000000000b', 'alias-ws-b', 'Outsider WS', 'a5a00000-0000-0000-0000-0000000000c3', 'free')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('a5a0aaaa-0000-0000-0000-00000000000a', 'a5a00000-0000-0000-0000-0000000000a1', 'owner'),
  ('a5a0bbbb-0000-0000-0000-00000000000b', 'a5a00000-0000-0000-0000-0000000000c3', 'owner')
ON CONFLICT DO NOTHING;

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host, smtp_host) VALUES
  ('a5a01111-0000-0000-0000-000000000001', 'a5a0aaaa-0000-0000-0000-00000000000a',
   'imap', 'primary@alias-test.invalid', 'active', 'imap.alias-test.invalid', 'smtp.alias-test.invalid');

-- The writer claims the OTHER workspace; the trigger must overrule it.
INSERT INTO public.inbox_sender_aliases (id, inbox_id, workspace_id, email_address, verified_at, code_hash)
VALUES ('a5a02222-0000-0000-0000-000000000001', 'a5a01111-0000-0000-0000-000000000001',
        'a5a0bbbb-0000-0000-0000-00000000000b', 'alias@alias-test.invalid', now(), 'secret-hash');

-- ------------------------------------------------------------
-- 1. Catalog
-- ------------------------------------------------------------
SELECT ok(
  (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.inbox_sender_aliases'::regclass),
  'RLS is enabled on inbox_sender_aliases');
SELECT ok(NOT has_any_column_privilege('authenticated', 'public.inbox_sender_aliases', 'INSERT,UPDATE'),
  'authenticated has no INSERT or UPDATE on any column');
SELECT ok(NOT has_table_privilege('authenticated', 'public.inbox_sender_aliases', 'DELETE,TRUNCATE'),
  'authenticated has no DELETE or TRUNCATE');
SELECT ok(NOT has_column_privilege('authenticated', 'public.inbox_sender_aliases', 'code_hash', 'SELECT'),
  'authenticated cannot read code_hash');
SELECT ok(NOT has_column_privilege('authenticated', 'public.inbox_sender_aliases', 'code_attempts', 'SELECT'),
  'authenticated cannot read code_attempts');
SELECT ok(NOT has_any_column_privilege('anon', 'public.inbox_sender_aliases', 'SELECT,INSERT,UPDATE'),
  'anon has no privilege at all');
SELECT ok(has_table_privilege('service_role', 'public.inbox_sender_aliases', 'SELECT,INSERT,UPDATE,DELETE'),
  'service_role keeps full access');

-- ------------------------------------------------------------
-- 2. Trigger and constraints (as the owner role)
-- ------------------------------------------------------------
SELECT is(
  (SELECT workspace_id FROM public.inbox_sender_aliases WHERE id = 'a5a02222-0000-0000-0000-000000000001'),
  'a5a0aaaa-0000-0000-0000-00000000000a'::uuid,
  'workspace_id follows the inbox, not the writer');

SELECT throws_ok(
  $$INSERT INTO public.inbox_sender_aliases (inbox_id, workspace_id, email_address)
    VALUES ('a5a01111-0000-0000-0000-000000000001', 'a5a0aaaa-0000-0000-0000-00000000000a', 'ALIAS@Alias-Test.invalid')$$,
  '23505', NULL, 'the same address twice on one inbox is refused, whatever its case');

SELECT throws_ok(
  $$INSERT INTO public.inbox_sender_aliases (inbox_id, workspace_id, email_address)
    VALUES ('a5a01111-0000-0000-0000-000000000001', 'a5a0aaaa-0000-0000-0000-00000000000a', E'evil@x.invalid\r\nBcc: v@x.invalid')$$,
  '23514', NULL, 'an address carrying a header break is refused');

SELECT throws_ok(
  $$INSERT INTO public.inbox_sender_aliases (inbox_id, workspace_id, email_address, display_name)
    VALUES ('a5a01111-0000-0000-0000-000000000001', 'a5a0aaaa-0000-0000-0000-00000000000a', 'n@alias-test.invalid', 'Me <x@y.invalid>')$$,
  '23514', NULL, 'a display name with angle brackets is refused');

-- ------------------------------------------------------------
-- 3. The workspace owner (a browser session)
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"a5a00000-0000-0000-0000-0000000000a1","role":"authenticated"}';

SELECT is(
  (SELECT email_address FROM public.inbox_sender_aliases WHERE id = 'a5a02222-0000-0000-0000-000000000001'),
  'alias@alias-test.invalid',
  '[owner] reads its own workspace''s alias');

SELECT throws_ok(
  $$SELECT code_hash FROM public.inbox_sender_aliases$$,
  '42501', NULL, '[owner] cannot read code_hash');

SELECT throws_ok(
  $$INSERT INTO public.inbox_sender_aliases (inbox_id, workspace_id, email_address, verified_at)
    VALUES ('a5a01111-0000-0000-0000-000000000001', 'a5a0aaaa-0000-0000-0000-00000000000a', 'self@alias-test.invalid', now())$$,
  '42501', NULL, '[owner] cannot insert a pre-verified alias');

SELECT throws_ok(
  $$UPDATE public.inbox_sender_aliases SET email_address = 'other@alias-test.invalid'
     WHERE id = 'a5a02222-0000-0000-0000-000000000001'$$,
  '42501', NULL, '[owner] cannot repoint a verified alias');

-- ------------------------------------------------------------
-- 4. A member of another workspace
-- ------------------------------------------------------------
SET LOCAL "request.jwt.claims" TO '{"sub":"a5a00000-0000-0000-0000-0000000000c3","role":"authenticated"}';

SELECT is(
  (SELECT count(*)::int FROM public.inbox_sender_aliases),
  0,
  '[outsider] sees no alias of another workspace');

RESET ROLE;

SELECT is(
  (SELECT count(*)::int FROM public.inbox_sender_aliases WHERE id = 'a5a02222-0000-0000-0000-000000000001'),
  1,
  'the row is untouched after every refused write');

SELECT * FROM finish();
ROLLBACK;
