-- ============================================================
-- RLS Test 03: Write isolation — no cross-tenant writes
-- ============================================================
-- Verifies that authenticated users cannot INSERT or UPDATE rows
-- that belong to another workspace, and cannot escalate privileges
-- by modifying the workspace_id or owner_id of their own rows.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(10);

-- ================================================================
-- 0. Seed (service-role context)
-- ================================================================

INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('c1000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'charlie@rls-write-test.invalid',
   'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('d2000000-0000-0000-0000-000000000002',
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'dave@rls-write-test.invalid',
   'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.users (id, email, display_name)
VALUES
  ('c1000000-0000-0000-0000-000000000001', 'charlie@rls-write-test.invalid', 'Charlie'),
  ('d2000000-0000-0000-0000-000000000002', 'dave@rls-write-test.invalid',    'Dave')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES
  ('cc000000-0000-0000-0000-000000000001', 'charlie-ws', 'Charlie WS',
   'c1000000-0000-0000-0000-000000000001', 'free'),
  ('dd000000-0000-0000-0000-000000000002', 'dave-ws',    'Dave WS',
   'd2000000-0000-0000-0000-000000000002', 'free')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES
  ('cc000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'owner'),
  ('dd000000-0000-0000-0000-000000000002', 'd2000000-0000-0000-0000-000000000002', 'owner')
ON CONFLICT DO NOTHING;

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status)
VALUES
  ('cc111111-0000-0000-0000-000000000001',
   'cc000000-0000-0000-0000-000000000001',
   'gmail', 'charlie@gmail-write-test.invalid', 'active'),
  ('dd111111-0000-0000-0000-000000000002',
   'dd000000-0000-0000-0000-000000000002',
   'gmail', 'dave@gmail-write-test.invalid', 'active')
ON CONFLICT DO NOTHING;

INSERT INTO public.api_keys
  (id, workspace_id, created_by, name, key_prefix, key_hash, scopes)
VALUES
  ('cc222222-0000-0000-0000-000000000001',
   'cc000000-0000-0000-0000-000000000001',
   'c1000000-0000-0000-0000-000000000001',
   'Charlie Key', 'mcpe_ch', 'fakehash_charlie_write_00000000001', ARRAY['read:email']),
  ('dd222222-0000-0000-0000-000000000002',
   'dd000000-0000-0000-0000-000000000002',
   'd2000000-0000-0000-0000-000000000002',
   'Dave Key', 'mcpe_dv', 'fakehash_dave_write_000000000002', ARRAY['read:email'])
ON CONFLICT DO NOTHING;

-- ================================================================
-- 1. Impersonate Charlie
-- ================================================================

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO
  '{"sub":"c1000000-0000-0000-0000-000000000001","role":"authenticated"}';

-- 1a. Charlie cannot insert an inbox into Dave's workspace
SELECT throws_ok(
  $$INSERT INTO public.inboxes
      (id, workspace_id, provider, email_address, status)
    VALUES
      ('ee333333-0000-0000-0000-000000000001',
       'dd000000-0000-0000-0000-000000000002',
       'gmail', 'charlie-evil@test.invalid', 'active')$$,
  '42501',
  NULL,
  '[inboxes] Charlie cannot INSERT into Dave''s workspace'
);

-- 1b. Charlie cannot insert an API key claiming Dave's workspace
SELECT throws_ok(
  $$INSERT INTO public.api_keys
      (id, workspace_id, created_by, name, key_prefix, key_hash, scopes)
    VALUES
      ('ee444444-0000-0000-0000-000000000001',
       'dd000000-0000-0000-0000-000000000002',
       'c1000000-0000-0000-0000-000000000001',
       'Evil Key', 'mcpe_ev', 'fakehash_evil_0000000000000000001', ARRAY['read:email'])$$,
  '42501',
  NULL,
  '[api_keys] Charlie cannot INSERT a key into Dave''s workspace'
);

-- 1c. Charlie cannot update Dave's inbox
-- (UPDATE on a row that doesn't match the USING predicate is silently skipped,
--  not an error — assert zero rows were changed)
SELECT is(
  (
    WITH update_result AS (
      UPDATE public.inboxes
      SET    display_name = 'hacked'
      WHERE  id = 'dd111111-0000-0000-0000-000000000002'
      RETURNING id
    )
    SELECT count(*)::int FROM update_result
  ),
  0,
  '[inboxes] Charlie cannot UPDATE Dave''s inbox (0 rows affected)'
);

-- 1d. Charlie cannot update Dave's API key
SELECT is(
  (
    WITH upd AS (
      UPDATE public.api_keys
      SET    name = 'hacked'
      WHERE  id = 'dd222222-0000-0000-0000-000000000002'
      RETURNING id
    )
    SELECT count(*)::int FROM upd
  ),
  0,
  '[api_keys] Charlie cannot UPDATE Dave''s key (0 rows affected)'
);

-- 1e. Charlie cannot update Dave's workspace
SELECT is(
  (
    WITH upd AS (
      UPDATE public.workspaces
      SET    display_name = 'hacked'
      WHERE  id = 'dd000000-0000-0000-0000-000000000002'
      RETURNING id
    )
    SELECT count(*)::int FROM upd
  ),
  0,
  '[workspaces] Charlie cannot UPDATE Dave''s workspace (0 rows affected)'
);

-- 1f. Charlie cannot create a workspace claiming a different owner
SELECT throws_ok(
  $$INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
    VALUES (
      'ee000000-0000-0000-0000-000000000099',
      'evil-ws', 'Evil Workspace',
      'd2000000-0000-0000-0000-000000000002',  -- Dave's user ID, not Charlie's
      'free'
    )$$,
  '42501',
  NULL,
  '[workspaces] Charlie cannot INSERT workspace with Dave''s owner_id'
);

-- 1g. Charlie cannot create an API key claiming someone else created it
SELECT throws_ok(
  $$INSERT INTO public.api_keys
      (workspace_id, created_by, name, key_prefix, key_hash, scopes)
    VALUES (
      'cc000000-0000-0000-0000-000000000001',  -- Charlie's own workspace
      'd2000000-0000-0000-0000-000000000002',  -- but claims Dave created it
      'Spoofed Key', 'mcpe_sp',
      'fakehash_spoofed_0000000000000001',
      ARRAY['read:email']
    )$$,
  '42501',
  NULL,
  '[api_keys] Charlie cannot INSERT key claiming Dave as creator'
);

-- ================================================================
-- 2. workspace_members: no INSERT/UPDATE/DELETE for authenticated
-- ================================================================

-- 2a. Charlie cannot grant himself membership in Dave's workspace
SELECT throws_ok(
  $$INSERT INTO public.workspace_members (workspace_id, user_id, role)
    VALUES (
      'dd000000-0000-0000-0000-000000000002',
      'c1000000-0000-0000-0000-000000000001',
      'owner'
    )$$,
  '42501',
  NULL,
  '[workspace_members] Charlie cannot INSERT membership into Dave''s workspace'
);

-- 2b. Charlie cannot remove Dave from his own workspace
SELECT is(
  (
    WITH del AS (
      DELETE FROM public.workspace_members
      WHERE  workspace_id = 'dd000000-0000-0000-0000-000000000002'
        AND  user_id      = 'd2000000-0000-0000-0000-000000000002'
      RETURNING workspace_id
    )
    SELECT count(*)::int FROM del
  ),
  0,
  '[workspace_members] Charlie cannot DELETE Dave''s membership (0 rows)'
);

-- ================================================================
-- 3. oauth_auth_codes: INSERT denied for authenticated users
-- ================================================================

SELECT throws_ok(
  $$INSERT INTO public.oauth_auth_codes
      (id, code_hash, client_id, workspace_id, user_id, client_name,
       redirect_uri, code_challenge, scopes)
    VALUES (
      'ff000000-0000-0000-0000-000000000001',
      'fakehash_auth_code_0000000000001',
      'claude-desktop',
      'cc000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      'Claude Desktop',
      'claude://oauth/callback',
      'fakechallenge',
      ARRAY['read:email']
    )$$,
  '42501',
  NULL,
  '[oauth_auth_codes] Authenticated user cannot INSERT auth codes'
);

SELECT * FROM finish();
ROLLBACK;
