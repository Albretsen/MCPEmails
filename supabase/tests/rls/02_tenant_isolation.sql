-- ============================================================
-- RLS Test 02: Cross-tenant data isolation
-- ============================================================
-- Verifies that authenticated users can only see data belonging
-- to their own workspace(s), never another tenant's data.
--
-- Strategy:
--   1. Insert two isolated tenants (Alice and Bob) as service_role.
--   2. Impersonate Alice via SET LOCAL ROLE + JWT claims.
--   3. Assert Alice sees her own data and zero of Bob's data.
--   4. Repeat key assertions from Bob's perspective.
--   5. ROLLBACK so no test data persists.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(27);

-- ================================================================
-- 0. Seed test users directly into auth.users (service-role context)
-- ================================================================

-- Alice
INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES (
  'a1000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated',
  'alice@rls-test.invalid',
  'x', now(), now(), now(), '{"provider":"email"}', '{}'
) ON CONFLICT DO NOTHING;

-- Bob
INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES (
  'b2000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated',
  'bob@rls-test.invalid',
  'x', now(), now(), now(), '{"provider":"email"}', '{}'
) ON CONFLICT DO NOTHING;

-- Mirror rows in public.users (normally done by auth trigger)
INSERT INTO public.users (id, email, display_name)
VALUES
  ('a1000000-0000-0000-0000-000000000001', 'alice@rls-test.invalid', 'Alice Test'),
  ('b2000000-0000-0000-0000-000000000002', 'bob@rls-test.invalid',   'Bob Test')
ON CONFLICT DO NOTHING;

-- ================================================================
-- 1. Seed workspaces
-- ================================================================

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES
  ('aa000000-0000-0000-0000-000000000001', 'alice-ws', 'Alice Workspace',
   'a1000000-0000-0000-0000-000000000001', 'free'),
  ('bb000000-0000-0000-0000-000000000002', 'bob-ws',   'Bob Workspace',
   'b2000000-0000-0000-0000-000000000002', 'pro')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES
  ('aa000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'owner'),
  ('bb000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000002', 'owner')
ON CONFLICT DO NOTHING;

-- ================================================================
-- 2. Seed inboxes (one active per tenant, one soft-deleted for Alice)
-- ================================================================

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status)
VALUES
  -- Alice's active inbox
  ('a1111111-0000-0000-0000-000000000001',
   'aa000000-0000-0000-0000-000000000001',
   'gmail', 'alice@gmail-test.invalid', 'active'),
  -- Alice's soft-deleted inbox
  ('a1111111-0000-0000-0000-000000000002',
   'aa000000-0000-0000-0000-000000000001',
   'outlook', 'alice-old@outlook-test.invalid', 'active'),
  -- Bob's active inbox
  ('b2222222-0000-0000-0000-000000000001',
   'bb000000-0000-0000-0000-000000000002',
   'gmail', 'bob@gmail-test.invalid', 'active')
ON CONFLICT DO NOTHING;

-- Soft-delete Alice's second inbox
UPDATE public.inboxes
SET    deleted_at = now()
WHERE  id = 'a1111111-0000-0000-0000-000000000002';

-- ================================================================
-- 3. Seed API keys
-- ================================================================

INSERT INTO public.api_keys
  (id, workspace_id, created_by, name, key_prefix, key_hash, scopes)
VALUES
  -- Alice's active key
  ('a3333333-0000-0000-0000-000000000001',
   'aa000000-0000-0000-0000-000000000001',
   'a1000000-0000-0000-0000-000000000001',
   'Alice Key', 'mcpe_al',
   'fakehash_alice_active_000000000001',
   ARRAY['read:email']),
  -- Alice's revoked key
  ('a3333333-0000-0000-0000-000000000002',
   'aa000000-0000-0000-0000-000000000001',
   'a1000000-0000-0000-0000-000000000001',
   'Alice Old Key', 'mcpe_ao',
   'fakehash_alice_revoked_00000000002',
   ARRAY['read:email']),
  -- Bob's active key
  ('b4444444-0000-0000-0000-000000000001',
   'bb000000-0000-0000-0000-000000000002',
   'b2000000-0000-0000-0000-000000000002',
   'Bob Key', 'mcpe_bo',
   'fakehash_bob_active_0000000000001',
   ARRAY['read:email','send:email'])
ON CONFLICT DO NOTHING;

-- Revoke Alice's second key
UPDATE public.api_keys
SET    deleted_at = now()
WHERE  id = 'a3333333-0000-0000-0000-000000000002';

-- ================================================================
-- 4. Seed activity_log entries
-- ================================================================

INSERT INTO public.activity_log
  (id, workspace_id, api_key_id, inbox_id, tool_name, status, created_at)
VALUES
  ('a5555555-0000-0000-0000-000000000001',
   'aa000000-0000-0000-0000-000000000001',
   'a3333333-0000-0000-0000-000000000001',
   'a1111111-0000-0000-0000-000000000001',
   'list_inbox', 'success', now()),
  ('b6666666-0000-0000-0000-000000000001',
   'bb000000-0000-0000-0000-000000000002',
   'b4444444-0000-0000-0000-000000000001',
   'b2222222-0000-0000-0000-000000000001',
   'email_read', 'success', now())
ON CONFLICT DO NOTHING;

-- ================================================================
-- 5. Seed auth_logs
-- ================================================================

INSERT INTO public.auth_logs
  (id, workspace_id, user_id, event_type)
VALUES
  ('a7777777-0000-0000-0000-000000000001',
   'aa000000-0000-0000-0000-000000000001',
   'a1000000-0000-0000-0000-000000000001',
   'login_success'),
  ('b8888888-0000-0000-0000-000000000001',
   'bb000000-0000-0000-0000-000000000002',
   'b2000000-0000-0000-0000-000000000002',
   'login_success')
ON CONFLICT DO NOTHING;

-- ================================================================
-- 6. Test as Alice
-- ================================================================

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO
  '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';

-- 6a. Alice sees her own user row
SELECT is(
  (SELECT count(*)::int FROM public.users
   WHERE id = 'a1000000-0000-0000-0000-000000000001'),
  1,
  '[users] Alice sees her own row'
);

-- 6b. Alice cannot see Bob's user row
SELECT is(
  (SELECT count(*)::int FROM public.users
   WHERE id = 'b2000000-0000-0000-0000-000000000002'),
  0,
  '[users] Alice cannot see Bob''s row'
);

-- 6c. Alice sees her own workspace
SELECT is(
  (SELECT count(*)::int FROM public.workspaces
   WHERE id = 'aa000000-0000-0000-0000-000000000001'),
  1,
  '[workspaces] Alice sees her own workspace'
);

-- 6d. Alice cannot see Bob's workspace
SELECT is(
  (SELECT count(*)::int FROM public.workspaces
   WHERE id = 'bb000000-0000-0000-0000-000000000002'),
  0,
  '[workspaces] Alice cannot see Bob''s workspace'
);

-- 6e. Alice sees her own workspace membership
SELECT is(
  (SELECT count(*)::int FROM public.workspace_members
   WHERE workspace_id = 'aa000000-0000-0000-0000-000000000001'),
  1,
  '[workspace_members] Alice sees her own membership'
);

-- 6f. Alice cannot see Bob's workspace membership
SELECT is(
  (SELECT count(*)::int FROM public.workspace_members
   WHERE workspace_id = 'bb000000-0000-0000-0000-000000000002'),
  0,
  '[workspace_members] Alice cannot see Bob''s membership'
);

-- 6g. Alice sees only her active inbox (not soft-deleted, not Bob's)
SELECT is(
  (SELECT count(*)::int FROM public.inboxes),
  1,
  '[inboxes] Alice sees exactly 1 inbox (active, hers)'
);

SELECT is(
  (SELECT count(*)::int FROM public.inboxes
   WHERE id = 'a1111111-0000-0000-0000-000000000001'),
  1,
  '[inboxes] Alice sees her active inbox'
);

-- 6h. Alice cannot see her soft-deleted inbox
SELECT is(
  (SELECT count(*)::int FROM public.inboxes
   WHERE id = 'a1111111-0000-0000-0000-000000000002'),
  0,
  '[inboxes] Alice cannot see her soft-deleted inbox'
);

-- 6i. Alice cannot see Bob's inbox
SELECT is(
  (SELECT count(*)::int FROM public.inboxes
   WHERE id = 'b2222222-0000-0000-0000-000000000001'),
  0,
  '[inboxes] Alice cannot see Bob''s inbox'
);

-- 6j. Alice sees only her active key (not revoked, not Bob's)
SELECT is(
  (SELECT count(*)::int FROM public.api_keys),
  1,
  '[api_keys] Alice sees exactly 1 key (active, hers)'
);

-- 6k. Alice cannot see her revoked key
SELECT is(
  (SELECT count(*)::int FROM public.api_keys
   WHERE id = 'a3333333-0000-0000-0000-000000000002'),
  0,
  '[api_keys] Alice cannot see her revoked key'
);

-- 6l. Alice cannot see Bob's key
SELECT is(
  (SELECT count(*)::int FROM public.api_keys
   WHERE id = 'b4444444-0000-0000-0000-000000000001'),
  0,
  '[api_keys] Alice cannot see Bob''s key'
);

-- 6m. Alice sees only her activity_log entries
SELECT is(
  (SELECT count(*)::int FROM public.activity_log),
  1,
  '[activity_log] Alice sees exactly her 1 log entry'
);

SELECT is(
  (SELECT count(*)::int FROM public.activity_log
   WHERE id = 'b6666666-0000-0000-0000-000000000001'),
  0,
  '[activity_log] Alice cannot see Bob''s activity'
);

-- 6n. Alice sees her auth_logs entry
SELECT is(
  (SELECT count(*)::int FROM public.auth_logs
   WHERE id = 'a7777777-0000-0000-0000-000000000001'),
  1,
  '[auth_logs] Alice sees her own auth log'
);

-- 6o. Alice cannot see Bob's auth_logs entry
SELECT is(
  (SELECT count(*)::int FROM public.auth_logs
   WHERE id = 'b8888888-0000-0000-0000-000000000001'),
  0,
  '[auth_logs] Alice cannot see Bob''s auth log'
);

-- 6p. oauth_clients are publicly readable
SELECT ok(
  (SELECT count(*) FROM public.oauth_clients) > 0,
  '[oauth_clients] Alice (authenticated) can read oauth_clients'
);

-- ================================================================
-- 7. Test as Bob (switch JWT)
-- ================================================================

SET LOCAL "request.jwt.claims" TO
  '{"sub":"b2000000-0000-0000-0000-000000000002","role":"authenticated"}';

-- 7a. Bob sees his own workspace
SELECT is(
  (SELECT count(*)::int FROM public.workspaces
   WHERE id = 'bb000000-0000-0000-0000-000000000002'),
  1,
  '[workspaces] Bob sees his own workspace'
);

-- 7b. Bob cannot see Alice's workspace
SELECT is(
  (SELECT count(*)::int FROM public.workspaces
   WHERE id = 'aa000000-0000-0000-0000-000000000001'),
  0,
  '[workspaces] Bob cannot see Alice''s workspace'
);

-- 7c. Bob sees only his inbox
SELECT is(
  (SELECT count(*)::int FROM public.inboxes),
  1,
  '[inboxes] Bob sees exactly 1 inbox (his)'
);

-- 7d. Bob cannot see Alice's inbox (including the soft-deleted one)
SELECT is(
  (SELECT count(*)::int FROM public.inboxes
   WHERE workspace_id = 'aa000000-0000-0000-0000-000000000001'),
  0,
  '[inboxes] Bob cannot see any of Alice''s inboxes'
);

-- 7e. Bob sees only his active API key
SELECT is(
  (SELECT count(*)::int FROM public.api_keys),
  1,
  '[api_keys] Bob sees exactly 1 key (his active one)'
);

-- 7f. Bob cannot see Alice's key
SELECT is(
  (SELECT count(*)::int FROM public.api_keys
   WHERE id = 'a3333333-0000-0000-0000-000000000001'),
  0,
  '[api_keys] Bob cannot see Alice''s key'
);

-- 7g. Bob sees only his activity
SELECT is(
  (SELECT count(*)::int FROM public.activity_log),
  1,
  '[activity_log] Bob sees exactly his 1 log entry'
);

-- 7h. Bob cannot see Alice's activity
SELECT is(
  (SELECT count(*)::int FROM public.activity_log
   WHERE workspace_id = 'aa000000-0000-0000-0000-000000000001'),
  0,
  '[activity_log] Bob cannot see Alice''s activity'
);

-- ================================================================
-- 8. oauth_auth_codes: no authenticated user can read them
-- ================================================================

-- Switch back to Alice
SET LOCAL "request.jwt.claims" TO
  '{"sub":"a1000000-0000-0000-0000-000000000001","role":"authenticated"}';

SELECT is(
  (SELECT count(*)::int FROM public.oauth_auth_codes),
  0,
  '[oauth_auth_codes] No authenticated user can read auth codes'
);

SELECT * FROM finish();
ROLLBACK;
