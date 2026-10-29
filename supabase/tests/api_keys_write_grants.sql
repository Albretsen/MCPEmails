-- ============================================================
-- api_keys: browser sessions may read, never write (20261016160300)
-- ============================================================
-- The MCP server authenticates by key_hash and trusts the row's scopes, so a
-- row a browser session can write is a credential it can mint. Proves:
--   - anon/authenticated hold no INSERT/UPDATE/DELETE/TRUNCATE on api_keys,
--     while SELECT stays and service_role keeps full write access;
--   - the three abuses from the finding all fail for a real session: a viewer
--     minting a send-capable key, a member rewriting the owner's key_hash, a
--     member re-assigning created_by on their own key to the owner;
--   - legitimate access still works: members still list their workspace's
--     keys, and the service role (what every route uses) can create, edit and
--     revoke them.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(25);

-- ------------------------------------------------------------
-- 0. Seed: one team workspace with an owner, a member and a viewer
-- ------------------------------------------------------------
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('a0300000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'u03-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('a0300000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'u03-member@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('a0300000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'u03-viewer@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('a03a0000-0000-0000-0000-00000000000a', 'u03-team', 'U03 Team',
        'a0300000-0000-0000-0000-000000000001', 'pro')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES
  ('a03a0000-0000-0000-0000-00000000000a', 'a0300000-0000-0000-0000-000000000001', 'owner'),
  ('a03a0000-0000-0000-0000-00000000000a', 'a0300000-0000-0000-0000-000000000002', 'member'),
  ('a03a0000-0000-0000-0000-00000000000a', 'a0300000-0000-0000-0000-000000000003', 'viewer')
ON CONFLICT DO NOTHING;

INSERT INTO public.api_keys (id, workspace_id, created_by, name, key_prefix, key_hash, scopes)
VALUES
  ('a03b0000-0000-0000-0000-0000000000a1', 'a03a0000-0000-0000-0000-00000000000a',
   'a0300000-0000-0000-0000-000000000001', 'Owner key', 'mcpe_own', 'u03-owner-hash',
   ARRAY['read:email','send:email']),
  ('a03b0000-0000-0000-0000-0000000000a2', 'a03a0000-0000-0000-0000-00000000000a',
   'a0300000-0000-0000-0000-000000000002', 'Member key', 'mcpe_mem', 'u03-member-hash',
   ARRAY['read:email']);

-- ------------------------------------------------------------
-- 1. The grants themselves
-- ------------------------------------------------------------
SELECT ok(NOT has_table_privilege('authenticated', 'public.api_keys', 'INSERT'),   'authenticated has no INSERT on api_keys');
SELECT ok(NOT has_table_privilege('authenticated', 'public.api_keys', 'UPDATE'),   'authenticated has no UPDATE on api_keys');
SELECT ok(NOT has_table_privilege('authenticated', 'public.api_keys', 'DELETE'),   'authenticated has no DELETE on api_keys');
SELECT ok(NOT has_table_privilege('authenticated', 'public.api_keys', 'TRUNCATE'), 'authenticated has no TRUNCATE on api_keys');
SELECT ok(NOT has_any_column_privilege('authenticated', 'public.api_keys', 'UPDATE'), 'authenticated has no column-level UPDATE on api_keys');
SELECT ok(NOT has_any_column_privilege('authenticated', 'public.api_keys', 'INSERT'), 'authenticated has no column-level INSERT on api_keys');
SELECT ok(NOT has_table_privilege('anon', 'public.api_keys', 'INSERT'),   'anon has no INSERT on api_keys');
SELECT ok(NOT has_table_privilege('anon', 'public.api_keys', 'UPDATE'),   'anon has no UPDATE on api_keys');
SELECT ok(NOT has_table_privilege('anon', 'public.api_keys', 'DELETE'),   'anon has no DELETE on api_keys');
SELECT ok(NOT has_table_privilege('anon', 'public.api_keys', 'TRUNCATE'), 'anon has no TRUNCATE on api_keys');
SELECT ok(has_table_privilege('authenticated', 'public.api_keys', 'SELECT'), 'authenticated keeps SELECT (the dashboard lists keys under RLS)');
SELECT ok(
  has_table_privilege('service_role', 'public.api_keys', 'INSERT')
  AND has_table_privilege('service_role', 'public.api_keys', 'UPDATE'),
  'service_role keeps INSERT and UPDATE (every route writes through it)');

-- ------------------------------------------------------------
-- 2. The abuses, as a real browser session
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;

-- 2a. A viewer mints a send-capable key with a hash they chose.
SET LOCAL "request.jwt.claims" TO '{"sub":"a0300000-0000-0000-0000-000000000003","role":"authenticated"}';
SELECT throws_ok(
  $$INSERT INTO public.api_keys (workspace_id, created_by, name, key_prefix, key_hash, scopes)
    VALUES ('a03a0000-0000-0000-0000-00000000000a', 'a0300000-0000-0000-0000-000000000003',
            'x', 'x', 'u03-viewer-chosen-hash', ARRAY['send:email','delete:email'])$$,
  '42501', NULL,
  'a viewer cannot INSERT a key (send scopes, chosen key_hash)');
SELECT throws_ok(
  $$UPDATE public.api_keys SET scopes = ARRAY['send:email'] WHERE id = 'a03b0000-0000-0000-0000-0000000000a2'$$,
  '42501', NULL,
  'a viewer cannot widen another member''s key');
SELECT throws_ok(
  $$UPDATE public.api_keys SET deleted_at = now() WHERE id = 'a03b0000-0000-0000-0000-0000000000a1'$$,
  '42501', NULL,
  'a viewer cannot revoke the owner''s key directly');

-- 2b. A member takes over the owner's key by rewriting its hash.
SET LOCAL "request.jwt.claims" TO '{"sub":"a0300000-0000-0000-0000-000000000002","role":"authenticated"}';
SELECT throws_ok(
  $$UPDATE public.api_keys SET key_hash = 'u03-member-known-hash' WHERE id = 'a03b0000-0000-0000-0000-0000000000a1'$$,
  '42501', NULL,
  'a member cannot rewrite the owner''s key_hash');
-- 2c. A member re-assigns their own key to the owner so it survives removal.
SELECT throws_ok(
  $$UPDATE public.api_keys SET created_by = 'a0300000-0000-0000-0000-000000000001' WHERE id = 'a03b0000-0000-0000-0000-0000000000a2'$$,
  '42501', NULL,
  'a member cannot set created_by on their own key');
SELECT throws_ok(
  $$UPDATE public.api_keys SET inbox_ids = NULL WHERE id = 'a03b0000-0000-0000-0000-0000000000a1'$$,
  '42501', NULL,
  'a member cannot lift an inbox restriction on the owner''s key');
SELECT throws_ok(
  $$DELETE FROM public.api_keys WHERE id = 'a03b0000-0000-0000-0000-0000000000a1'$$,
  '42501', NULL,
  'a member cannot DELETE a key');

-- 2d. Even the owner's browser session cannot write: the routes do it.
SET LOCAL "request.jwt.claims" TO '{"sub":"a0300000-0000-0000-0000-000000000001","role":"authenticated"}';
SELECT throws_ok(
  $$INSERT INTO public.api_keys (workspace_id, created_by, name, key_prefix, key_hash, scopes)
    VALUES ('a03a0000-0000-0000-0000-00000000000a', 'a0300000-0000-0000-0000-000000000001',
            'direct', 'x', 'u03-owner-direct', ARRAY['read:email'])$$,
  '42501', NULL,
  'an owner session cannot INSERT directly either');

-- ------------------------------------------------------------
-- 3. Legitimate access still works
-- ------------------------------------------------------------
-- 3a. Members still list the workspace's keys (SELECT under RLS unchanged).
SET LOCAL "request.jwt.claims" TO '{"sub":"a0300000-0000-0000-0000-000000000003","role":"authenticated"}';
SELECT is(
  (SELECT count(*) FROM public.api_keys WHERE workspace_id = 'a03a0000-0000-0000-0000-00000000000a'),
  2::bigint,
  'a viewer still lists the workspace''s keys');
RESET ROLE;

SELECT is(
  (SELECT key_hash || '|' || created_by::text || '|' || array_to_string(scopes, ',')
     FROM public.api_keys WHERE id = 'a03b0000-0000-0000-0000-0000000000a2'),
  'u03-member-hash|a0300000-0000-0000-0000-000000000002|read:email',
  'none of the refused writes changed the member key');

-- 3b. The service role (what POST/PATCH /api/api-keys and revoke use) writes.
SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$INSERT INTO public.api_keys (id, workspace_id, created_by, name, key_prefix, key_hash, scopes)
    VALUES ('a03b0000-0000-0000-0000-0000000000a3', 'a03a0000-0000-0000-0000-00000000000a',
            'a0300000-0000-0000-0000-000000000003', 'Viewer key', 'mcpe_vw', 'u03-viewer-hash', ARRAY['read:email'])$$,
  'the service role can create a key');
SELECT lives_ok(
  $$UPDATE public.api_keys SET scopes = ARRAY['read:email','search:email'] WHERE id = 'a03b0000-0000-0000-0000-0000000000a3'$$,
  'the service role can edit a key');
SELECT lives_ok(
  $$UPDATE public.api_keys SET deleted_at = now() WHERE id = 'a03b0000-0000-0000-0000-0000000000a3'$$,
  'the service role can revoke a key');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
