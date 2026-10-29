-- ============================================================
-- public.inboxes: what a browser session may read and write
-- ============================================================
-- Covers 20261016160200_inboxes_lock_user_writes_and_secret_columns.sql.
--
-- The holes it closes, each proven closed here for a viewer, a member and
-- the owner of the workspace (every write now goes through service-role
-- routes that check the role themselves):
--   - repointing imap_host / smtp_host (credential theft on the next login)
--   - switching off the owner/admin-only send review gate
--   - moving an inbox into another workspace via workspace_id
--   - inserting inbox rows directly (plan cap, host guard, role bypass)
--   - reading the encrypted credential columns
-- And what must keep working:
--   - members (viewers included) still SELECT every non-secret column the
--     dashboard, /authorize and the route authorization reads use
--   - the service role still reads and writes everything
--   - RLS still scopes reads to the caller's workspaces
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(45);

-- ------------------------------------------------------------
-- 0. Fixtures (as the migration owner, which bypasses RLS)
-- ------------------------------------------------------------
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('a0e00000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ibx-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('a0e00000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ibx-member@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('a0e00000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ibx-viewer@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.users (id, email, display_name) VALUES
  ('a0e00000-0000-0000-0000-0000000000a1', 'ibx-owner@rls-test.invalid', 'Owner'),
  ('a0e00000-0000-0000-0000-0000000000b2', 'ibx-member@rls-test.invalid', 'Member'),
  ('a0e00000-0000-0000-0000-0000000000c3', 'ibx-viewer@rls-test.invalid', 'Viewer')
ON CONFLICT DO NOTHING;

-- Workspace A belongs to the owner; the member and the viewer are invited.
-- Workspace B is the viewer's own (the target of a workspace_id move).
INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('a0e0aaaa-0000-0000-0000-00000000000a', 'ibx-company', 'Company', 'a0e00000-0000-0000-0000-0000000000a1', 'pro'),
  ('a0e0bbbb-0000-0000-0000-00000000000b', 'ibx-viewer-own', 'Viewer Own', 'a0e00000-0000-0000-0000-0000000000c3', 'free')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('a0e0aaaa-0000-0000-0000-00000000000a', 'a0e00000-0000-0000-0000-0000000000a1', 'owner'),
  ('a0e0aaaa-0000-0000-0000-00000000000a', 'a0e00000-0000-0000-0000-0000000000b2', 'member'),
  ('a0e0aaaa-0000-0000-0000-00000000000a', 'a0e00000-0000-0000-0000-0000000000c3', 'viewer'),
  ('a0e0bbbb-0000-0000-0000-00000000000b', 'a0e00000-0000-0000-0000-0000000000c3', 'owner')
ON CONFLICT DO NOTHING;

INSERT INTO public.inboxes (
  id, workspace_id, provider, email_address, display_name, status,
  imap_host, imap_port, smtp_host, smtp_port, imap_password,
  oauth_access_token, oauth_refresh_token, send_review_mode, send_approval_required
) VALUES (
  'a0e01111-0000-0000-0000-000000000001', 'a0e0aaaa-0000-0000-0000-00000000000a',
  'imap', 'ceo@company.invalid', 'CEO', 'active',
  'imap.company.invalid', 993, 'smtp.company.invalid', 465, 'ciphertext-imap',
  'ciphertext-access', 'ciphertext-refresh', 'dashboard', true
);

-- ------------------------------------------------------------
-- 1. Catalog: the grants are exactly what the migration says
-- ------------------------------------------------------------
SELECT is(
  (SELECT array_agg(a.attname::text ORDER BY a.attname)
     FROM pg_attribute a
    WHERE a.attrelid = 'public.inboxes'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND NOT has_column_privilege('authenticated', 'public.inboxes', a.attname, 'SELECT')),
  ARRAY['imap_password', 'oauth_access_token', 'oauth_refresh_token'],
  'authenticated can SELECT every inboxes column except the three credentials (a new column without its own GRANT fails here)');

SELECT ok(NOT has_any_column_privilege('authenticated', 'public.inboxes', 'UPDATE'),
  'authenticated has no UPDATE on any inboxes column');
SELECT ok(NOT has_any_column_privilege('authenticated', 'public.inboxes', 'INSERT'),
  'authenticated has no INSERT on any inboxes column');
SELECT ok(NOT has_table_privilege('authenticated', 'public.inboxes', 'DELETE'),
  'authenticated has no DELETE on inboxes');
SELECT ok(NOT has_table_privilege('authenticated', 'public.inboxes', 'TRUNCATE'),
  'authenticated has no TRUNCATE on inboxes');
SELECT ok(NOT has_any_column_privilege('anon', 'public.inboxes', 'SELECT,INSERT,UPDATE,REFERENCES'),
  'anon has no privilege at all on inboxes');
SELECT ok(NOT has_table_privilege('anon', 'public.inboxes', 'DELETE,TRUNCATE,TRIGGER'),
  'anon has no table-level privilege on inboxes');
SELECT ok(has_table_privilege('service_role', 'public.inboxes', 'SELECT,INSERT,UPDATE,DELETE'),
  'service_role keeps full access');
SELECT is(
  (SELECT count(*)::int FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'inboxes'
      AND policyname IN ('inboxes_insert_members', 'inboxes_update_members')),
  0,
  'the member INSERT / UPDATE policies are gone');
SELECT is(
  (SELECT count(*)::int FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'inboxes' AND policyname = 'inboxes_select_members'),
  1,
  'the member SELECT policy is kept');

-- ------------------------------------------------------------
-- 2. The viewer (the attacker in every finding)
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"a0e00000-0000-0000-0000-0000000000c3","role":"authenticated"}';

SELECT throws_ok(
  $$UPDATE public.inboxes SET imap_host = 'imap.attacker.invalid'
     WHERE id = 'a0e01111-0000-0000-0000-000000000001'$$,
  '42501', NULL, '[viewer] cannot repoint imap_host');
SELECT throws_ok(
  $$UPDATE public.inboxes SET smtp_host = 'smtp.attacker.invalid', smtp_port = 25
     WHERE id = 'a0e01111-0000-0000-0000-000000000001'$$,
  '42501', NULL, '[viewer] cannot repoint smtp_host');
SELECT throws_ok(
  $$UPDATE public.inboxes SET imap_password = 'ciphertext-from-elsewhere'
     WHERE id = 'a0e01111-0000-0000-0000-000000000001'$$,
  '42501', NULL, '[viewer] cannot overwrite the stored credential');
SELECT throws_ok(
  $$UPDATE public.inboxes SET send_review_mode = 'off', send_approval_required = false
     WHERE id = 'a0e01111-0000-0000-0000-000000000001'$$,
  '42501', NULL, '[viewer] cannot switch off the send review gate');
SELECT throws_ok(
  $$UPDATE public.inboxes SET workspace_id = 'a0e0bbbb-0000-0000-0000-00000000000b'
     WHERE id = 'a0e01111-0000-0000-0000-000000000001'$$,
  '42501', NULL, '[viewer] cannot move the inbox into their own workspace');
SELECT throws_ok(
  $$UPDATE public.inboxes SET display_name = 'renamed'
     WHERE id = 'a0e01111-0000-0000-0000-000000000001'$$,
  '42501', NULL, '[viewer] cannot change even a cosmetic column');
SELECT throws_ok(
  $$INSERT INTO public.inboxes (workspace_id, provider, email_address, status, imap_host, imap_password)
    VALUES ('a0e0aaaa-0000-0000-0000-00000000000a', 'imap', 'extra@company.invalid', 'active',
            'imap.company.invalid', 'ciphertext-imap')$$,
  '42501', NULL, '[viewer] cannot INSERT an inbox into the company workspace');
SELECT throws_ok(
  $$INSERT INTO public.inboxes (workspace_id, provider, email_address, status, imap_host, imap_password)
    VALUES ('a0e0bbbb-0000-0000-0000-00000000000b', 'imap', 'ceo@company.invalid', 'active',
            'imap.company.invalid', 'ciphertext-imap')$$,
  '42501', NULL, '[viewer] cannot copy the inbox into their own workspace, where they are owner');
SELECT throws_ok(
  $$DELETE FROM public.inboxes WHERE id = 'a0e01111-0000-0000-0000-000000000001'$$,
  '42501', NULL, '[viewer] cannot DELETE an inbox');
SELECT throws_ok(
  $$SELECT imap_password FROM public.inboxes WHERE id = 'a0e01111-0000-0000-0000-000000000001'$$,
  '42501', NULL, '[viewer] cannot read imap_password');
SELECT throws_ok(
  $$SELECT oauth_access_token FROM public.inboxes$$,
  '42501', NULL, '[viewer] cannot read oauth_access_token');
SELECT throws_ok(
  $$SELECT oauth_refresh_token FROM public.inboxes$$,
  '42501', NULL, '[viewer] cannot read oauth_refresh_token');
SELECT throws_ok(
  $$SELECT * FROM public.inboxes$$,
  '42501', NULL, '[viewer] SELECT * is refused (it would include the credentials)');

-- Reads the dashboard makes still work for a viewer.
SELECT is(
  (SELECT count(*)::int FROM public.inboxes
    WHERE workspace_id = 'a0e0aaaa-0000-0000-0000-00000000000a' AND deleted_at IS NULL),
  1, '[viewer] still sees the workspace inbox');
SELECT is(
  (SELECT imap_host || '|' || send_review_mode || '|' || email_address
     FROM public.inboxes WHERE id = 'a0e01111-0000-0000-0000-000000000001'),
  'imap.company.invalid|dashboard|ceo@company.invalid',
  '[viewer] still reads connection details and review mode');

-- ------------------------------------------------------------
-- 3. The member (an operator: writes go through the routes)
-- ------------------------------------------------------------
SET LOCAL "request.jwt.claims" TO '{"sub":"a0e00000-0000-0000-0000-0000000000b2","role":"authenticated"}';

SELECT throws_ok(
  $$UPDATE public.inboxes SET imap_host = 'imap.attacker.invalid'
     WHERE id = 'a0e01111-0000-0000-0000-000000000001'$$,
  '42501', NULL, '[member] cannot repoint imap_host directly');
SELECT throws_ok(
  $$UPDATE public.inboxes SET send_review_mode = 'off'
     WHERE id = 'a0e01111-0000-0000-0000-000000000001'$$,
  '42501', NULL, '[member] cannot switch off the review gate directly');
SELECT throws_ok(
  $$INSERT INTO public.inboxes (workspace_id, provider, email_address, status)
    VALUES ('a0e0aaaa-0000-0000-0000-00000000000a', 'imap', 'm2@company.invalid', 'active')$$,
  '42501', NULL, '[member] cannot INSERT directly (connect goes through /api/inboxes/*)');
SELECT throws_ok(
  $$SELECT imap_password FROM public.inboxes$$,
  '42501', NULL, '[member] cannot read imap_password');

-- The exact column list the dashboard Inboxes page selects
-- (app/dashboard/[[...section]]/page.js fetchInboxes).
SELECT lives_ok(
  $$SELECT id, display_name, email_address, provider, service, status, last_error,
           imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security,
           imap_username, created_at, signature_text, signature_html, signature_enabled,
           signature_reply_mode, signature_source, send_approval_required, send_review_mode,
           draft_editor_hidden, signature_embed_images
      FROM public.inboxes
     WHERE workspace_id = 'a0e0aaaa-0000-0000-0000-00000000000a' AND deleted_at IS NULL
     ORDER BY created_at$$,
  '[member] the dashboard inbox list select still works');
-- Usage breakdown (fetchUsageData), /authorize, and the route authorization reads.
SELECT lives_ok(
  $$SELECT id, display_name, email_address, deleted_at FROM public.inboxes
     WHERE workspace_id = 'a0e0aaaa-0000-0000-0000-00000000000a'$$,
  '[member] the usage breakdown select still works');
SELECT lives_ok(
  $$SELECT id, email_address, display_name, provider, status FROM public.inboxes
     WHERE workspace_id = 'a0e0aaaa-0000-0000-0000-00000000000a' AND deleted_at IS NULL$$,
  '[member] the /authorize inbox picker select still works');
SELECT lives_ok(
  $$SELECT id, workspace_id, provider, imap_host FROM public.inboxes
     WHERE id = 'a0e01111-0000-0000-0000-000000000001' AND deleted_at IS NULL$$,
  '[member] the disconnect / check / settings authorization reads still work');
SELECT is(
  (SELECT count(*)::int FROM public.inboxes),
  1, '[member] sees exactly the one workspace inbox');

-- ------------------------------------------------------------
-- 4. The owner: also no direct writes (the routes are the only path)
-- ------------------------------------------------------------
SET LOCAL "request.jwt.claims" TO '{"sub":"a0e00000-0000-0000-0000-0000000000a1","role":"authenticated"}';

SELECT throws_ok(
  $$UPDATE public.inboxes SET send_review_mode = 'off'
     WHERE id = 'a0e01111-0000-0000-0000-000000000001'$$,
  '42501', NULL, '[owner] direct UPDATE is refused too (PATCH /api/inboxes/[id] is the path)');
SELECT throws_ok(
  $$SELECT oauth_refresh_token FROM public.inboxes$$,
  '42501', NULL, '[owner] cannot read the refresh token through the user client either');
SELECT is(
  (SELECT send_review_mode FROM public.inboxes WHERE id = 'a0e01111-0000-0000-0000-000000000001'),
  'dashboard', '[owner] reads the review mode');

-- ------------------------------------------------------------
-- 5. anon
-- ------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok(
  $$SELECT id FROM public.inboxes$$,
  '42501', NULL, '[anon] cannot read inboxes at all');

-- ------------------------------------------------------------
-- 6. Nothing above changed the row
-- ------------------------------------------------------------
RESET ROLE;
SELECT is(
  (SELECT row(workspace_id, imap_host, smtp_host, imap_password, send_review_mode, send_approval_required, display_name)::text
     FROM public.inboxes WHERE id = 'a0e01111-0000-0000-0000-000000000001'),
  row('a0e0aaaa-0000-0000-0000-00000000000a'::uuid, 'imap.company.invalid'::text, 'smtp.company.invalid'::text,
      'ciphertext-imap'::text, 'dashboard'::text, true, 'CEO'::text)::text,
  'the inbox row is untouched');
SELECT is(
  (SELECT count(*)::int FROM public.inboxes WHERE email_address IN ('extra@company.invalid', 'm2@company.invalid')
      OR workspace_id = 'a0e0bbbb-0000-0000-0000-00000000000b'),
  0, 'no inbox was inserted by a browser session');

-- ------------------------------------------------------------
-- 7. The service role (what the routes use) still does everything
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;
SELECT is(
  (SELECT imap_password || '|' || oauth_refresh_token FROM public.inboxes
    WHERE id = 'a0e01111-0000-0000-0000-000000000001'),
  'ciphertext-imap|ciphertext-refresh', '[service_role] reads the credentials (check / disconnect)');
SELECT lives_ok(
  $$UPDATE public.inboxes SET status = 'active', last_error = NULL, last_sync_at = now()
     WHERE id = 'a0e01111-0000-0000-0000-000000000001'
       AND workspace_id = 'a0e0aaaa-0000-0000-0000-00000000000a'$$,
  '[service_role] writes the check status');
SELECT lives_ok(
  $$UPDATE public.inboxes SET send_review_mode = 'off', signature_text = 'Regards'
     WHERE id = 'a0e01111-0000-0000-0000-000000000001'$$,
  '[service_role] writes settings (PATCH /api/inboxes/[id])');
SELECT lives_ok(
  $$INSERT INTO public.inboxes (workspace_id, provider, email_address, status, imap_host, imap_password)
    VALUES ('a0e0aaaa-0000-0000-0000-00000000000a', 'imap', 'second@company.invalid', 'active',
            'imap.company.invalid', 'ciphertext-2')
    ON CONFLICT (workspace_id, email_address) DO UPDATE SET imap_password = EXCLUDED.imap_password$$,
  '[service_role] upserts a connected inbox (connect routes)');
SELECT lives_ok(
  $$UPDATE public.inboxes SET deleted_at = now(), status = 'revoked', imap_password = NULL,
         oauth_access_token = NULL, oauth_refresh_token = NULL
     WHERE id = 'a0e01111-0000-0000-0000-000000000001'$$,
  '[service_role] soft-deletes and clears credentials (disconnect)');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
