-- ============================================================
-- public.inboxes.folder_overrides: what may be stored, and who may write it
-- ============================================================
-- Covers 20261020230000_inbox_folder_overrides.sql.
--
-- The column decides where mail goes (Sent copies, drafts, trash, archive),
-- so the CHECK restates the route's guardrails for every writer:
--   - NULL and an empty object are fine (automatic detection)
--   - only the keys sent, drafts, trash, spam, archive
--   - string values of 1 to 512 characters
--   - never INBOX, in any case
--   - never one folder for two roles
-- and a member still cannot write the column through PostgREST.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(14);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('f0a00000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'folders-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.users (id, email, display_name) VALUES
  ('f0a00000-0000-0000-0000-0000000000a1', 'folders-owner@rls-test.invalid', 'Owner')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('f0a0aaaa-0000-0000-0000-00000000000a', 'folders-ws-a', 'Owner WS', 'f0a00000-0000-0000-0000-0000000000a1', 'pro')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('f0a0aaaa-0000-0000-0000-00000000000a', 'f0a00000-0000-0000-0000-0000000000a1', 'owner')
ON CONFLICT DO NOTHING;

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host, smtp_host) VALUES
  ('f0a01111-0000-0000-0000-000000000001', 'f0a0aaaa-0000-0000-0000-00000000000a',
   'imap', 'primary@folders-test.invalid', 'active', 'imap.folders-test.invalid', 'smtp.folders-test.invalid');

SELECT has_column('public', 'inboxes', 'folder_overrides', 'inboxes.folder_overrides exists');
SELECT is(
  (SELECT folder_overrides FROM public.inboxes WHERE id = 'f0a01111-0000-0000-0000-000000000001'),
  NULL::jsonb,
  'a new row has no overrides (automatic detection)');

-- Accepted values (as the owner of the table, which is what service_role writes as).
SELECT lives_ok(
  $$UPDATE public.inboxes SET folder_overrides = '{}'::jsonb WHERE id = 'f0a01111-0000-0000-0000-000000000001'$$,
  'an empty object is accepted');
SELECT lives_ok(
  $$UPDATE public.inboxes
       SET folder_overrides = '{"sent": "INBOX.Éléments envoyés", "drafts": "INBOX.Brouillons", "trash": "INBOX.Corbeille", "spam": "INBOX.Spam", "archive": "INBOX.Archives"}'::jsonb
     WHERE id = 'f0a01111-0000-0000-0000-000000000001'$$,
  'all five roles, each its own folder, are accepted');
SELECT lives_ok(
  $$UPDATE public.inboxes SET folder_overrides = '{"archive": "INBOX.Archive"}'::jsonb WHERE id = 'f0a01111-0000-0000-0000-000000000001'$$,
  'a folder under INBOX is not INBOX');

-- Refused values.
SELECT throws_ok(
  $$UPDATE public.inboxes SET folder_overrides = '{"inbox": "Somewhere"}'::jsonb WHERE id = 'f0a01111-0000-0000-0000-000000000001'$$,
  '23514', NULL, 'an unknown key is refused');
SELECT throws_ok(
  $$UPDATE public.inboxes SET folder_overrides = '{"sent": "INBOX"}'::jsonb WHERE id = 'f0a01111-0000-0000-0000-000000000001'$$,
  '23514', NULL, 'INBOX is refused');
SELECT throws_ok(
  $$UPDATE public.inboxes SET folder_overrides = '{"trash": "inbox"}'::jsonb WHERE id = 'f0a01111-0000-0000-0000-000000000001'$$,
  '23514', NULL, 'inbox in lower case is refused');
SELECT throws_ok(
  $$UPDATE public.inboxes SET folder_overrides = '{"sent": "Mail", "trash": "Mail"}'::jsonb WHERE id = 'f0a01111-0000-0000-0000-000000000001'$$,
  '23514', NULL, 'one folder for two roles is refused');
SELECT throws_ok(
  $$UPDATE public.inboxes SET folder_overrides = '{"sent": ""}'::jsonb WHERE id = 'f0a01111-0000-0000-0000-000000000001'$$,
  '23514', NULL, 'an empty name is refused');
SELECT throws_ok(
  $$UPDATE public.inboxes SET folder_overrides = jsonb_build_object('sent', repeat('x', 513)) WHERE id = 'f0a01111-0000-0000-0000-000000000001'$$,
  '23514', NULL, 'a name over 512 characters is refused');
SELECT throws_ok(
  $$UPDATE public.inboxes SET folder_overrides = '{"sent": 7}'::jsonb WHERE id = 'f0a01111-0000-0000-0000-000000000001'$$,
  '23514', NULL, 'a non-string value is refused');
SELECT throws_ok(
  $$UPDATE public.inboxes SET folder_overrides = '["Sent"]'::jsonb WHERE id = 'f0a01111-0000-0000-0000-000000000001'$$,
  '23514', NULL, 'a non-object is refused');

-- A member cannot write the column (no user write grant on inboxes).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub": "f0a00000-0000-0000-0000-0000000000a1", "role": "authenticated"}', true);
SELECT throws_ok(
  $$UPDATE public.inboxes SET folder_overrides = '{"sent": "Sent"}'::jsonb WHERE id = 'f0a01111-0000-0000-0000-000000000001'$$,
  '42501', NULL, '[owner] cannot write folder_overrides through PostgREST');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
