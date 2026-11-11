-- ============================================================
-- Inbox ownership and visibility (the Business privacy model)
-- ============================================================
-- Covers 20261111120000_inbox_owner_visibility.sql:
--   * a member sees company-wide inboxes and their own private ones, never
--     another member's private inbox, on inboxes and on every table that
--     exposes an inbox's content or settings;
--   * owner/admin see METADATA of every inbox through
--     workspace_inbox_directory(), never the row (signature etc.);
--   * a non-member sees nothing;
--   * credential_inbox_scope() narrows a key to its creator's view;
--   * the owner trigger: default on insert, immutable on a live row, reset to
--     private when a soft-deleted row is revived by someone else;
--   * the backfill rule and the business_seat_pricing switch row.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(48);

-- ------------------------------------------------------------
-- 0. Fixtures (as the migration owner, which bypasses RLS)
-- ------------------------------------------------------------
-- O = workspace owner, A = admin, M = member who owns a private inbox,
-- N = another member, X = outsider (owns workspace B).
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('b1500000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'vis-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('b1500000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'vis-admin@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('b1500000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'vis-member@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('b1500000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'vis-other@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('b1500000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'vis-outsider@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.users (id, email, display_name) VALUES
  ('b1500000-0000-0000-0000-0000000000a1', 'vis-owner@rls-test.invalid', 'Owner'),
  ('b1500000-0000-0000-0000-0000000000a2', 'vis-admin@rls-test.invalid', 'Admin'),
  ('b1500000-0000-0000-0000-0000000000a3', 'vis-member@rls-test.invalid', 'Member'),
  ('b1500000-0000-0000-0000-0000000000a4', 'vis-other@rls-test.invalid', 'Other'),
  ('b1500000-0000-0000-0000-0000000000a5', 'vis-outsider@rls-test.invalid', 'Outsider')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('b150aaaa-0000-0000-0000-00000000000a', 'vis-ws-company', 'Company', 'b1500000-0000-0000-0000-0000000000a1', 'pro'),
  ('b150bbbb-0000-0000-0000-00000000000b', 'vis-ws-outsider', 'Outsider', 'b1500000-0000-0000-0000-0000000000a5', 'free')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('b150aaaa-0000-0000-0000-00000000000a', 'b1500000-0000-0000-0000-0000000000a1', 'owner'),
  ('b150aaaa-0000-0000-0000-00000000000a', 'b1500000-0000-0000-0000-0000000000a2', 'admin'),
  ('b150aaaa-0000-0000-0000-00000000000a', 'b1500000-0000-0000-0000-0000000000a3', 'member'),
  ('b150aaaa-0000-0000-0000-00000000000a', 'b1500000-0000-0000-0000-0000000000a4', 'member'),
  ('b150bbbb-0000-0000-0000-00000000000b', 'b1500000-0000-0000-0000-0000000000a5', 'owner')
ON CONFLICT DO NOTHING;

-- I1 = M's private inbox, I2 = company-wide (owned by O), I3 = O's private inbox.
INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, owner_user_id, visibility, signature_text) VALUES
  ('b1501111-0000-0000-0000-000000000001', 'b150aaaa-0000-0000-0000-00000000000a', 'imap', 'm@vis.invalid', 'active',
   'b1500000-0000-0000-0000-0000000000a3', 'private', 'M private signature'),
  ('b1501111-0000-0000-0000-000000000002', 'b150aaaa-0000-0000-0000-00000000000a', 'imap', 'team@vis.invalid', 'active',
   'b1500000-0000-0000-0000-0000000000a1', 'company', 'Team signature'),
  ('b1501111-0000-0000-0000-000000000003', 'b150aaaa-0000-0000-0000-00000000000a', 'imap', 'o@vis.invalid', 'active',
   'b1500000-0000-0000-0000-0000000000a1', 'private', 'O private signature');

-- Content rows on each inbox.
INSERT INTO public.reminders (workspace_id, inbox_id, kind, status, condition, due_at, next_check_at, message_digest, message_ref, folder)
SELECT 'b150aaaa-0000-0000-0000-00000000000a', i, 'snooze', 'pending', 'always', now() + interval '1 day', now() + interval '1 day',
       md5(i::text), '{"v":1,"data":"x"}'::jsonb, 'Snoozed'
  FROM unnest(ARRAY['b1501111-0000-0000-0000-000000000001'::uuid, 'b1501111-0000-0000-0000-000000000002'::uuid]) AS i;

INSERT INTO public.scheduled_sends (workspace_id, inbox_id, payload, payload_encrypted, send_at, status)
SELECT 'b150aaaa-0000-0000-0000-00000000000a', i, '{"v":1,"data":"x"}'::jsonb, true, now() + interval '1 day', 'pending'
  FROM unnest(ARRAY['b1501111-0000-0000-0000-000000000001'::uuid, 'b1501111-0000-0000-0000-000000000002'::uuid]) AS i;

INSERT INTO public.activity_log (workspace_id, inbox_id, tool_name, status)
SELECT 'b150aaaa-0000-0000-0000-00000000000a', i, 'email_read', 'success'
  FROM unnest(ARRAY['b1501111-0000-0000-0000-000000000001'::uuid, 'b1501111-0000-0000-0000-000000000002'::uuid, NULL::uuid]) AS i;

-- ------------------------------------------------------------
-- 1. Schema
-- ------------------------------------------------------------
SELECT has_column('public', 'inboxes', 'owner_user_id', 'inboxes.owner_user_id exists');
SELECT has_column('public', 'inboxes', 'visibility', 'inboxes.visibility exists');
SELECT col_not_null('public', 'inboxes', 'visibility', 'visibility is NOT NULL');
SELECT col_default_is('public', 'inboxes', 'visibility', 'private', 'new inboxes default to private');
SELECT throws_ok(
  $$UPDATE public.inboxes SET visibility = 'everyone' WHERE id = 'b1501111-0000-0000-0000-000000000002'$$,
  '23514', NULL, 'visibility only takes private or company');
SELECT has_column('public', 'scheduled_sends', 'created_by', 'scheduled_sends.created_by exists');
SELECT is(
  (SELECT enabled FROM public.pricing_switches WHERE key = 'business_seat_pricing'),
  false, 'business_seat_pricing is seeded off');
SELECT ok(has_column_privilege('authenticated', 'public.inboxes', 'visibility', 'SELECT')
          AND has_column_privilege('authenticated', 'public.inboxes', 'owner_user_id', 'SELECT'),
  'members can read the two new columns');
SELECT ok(NOT has_function_privilege('authenticated', 'public.credential_inbox_scope(uuid, uuid, uuid[])', 'EXECUTE'),
  'credential_inbox_scope is service-role only');
SELECT ok(NOT has_function_privilege('authenticated', 'public.visible_inbox_ids(uuid, uuid)', 'EXECUTE'),
  'visible_inbox_ids is service-role only');
SELECT ok(NOT has_function_privilege('anon', 'public.workspace_inbox_directory(uuid)', 'EXECUTE'),
  'anon cannot call workspace_inbox_directory');

-- ------------------------------------------------------------
-- 2. Owner trigger
-- ------------------------------------------------------------
INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status) VALUES
  ('b1501111-0000-0000-0000-000000000009', 'b150aaaa-0000-0000-0000-00000000000a', 'imap', 'noowner@vis.invalid', 'active');
SELECT is(
  (SELECT owner_user_id::text || '|' || visibility FROM public.inboxes WHERE id = 'b1501111-0000-0000-0000-000000000009'),
  'b1500000-0000-0000-0000-0000000000a1|private',
  'an insert without an owner falls back to the workspace owner, private');

UPDATE public.inboxes SET owner_user_id = 'b1500000-0000-0000-0000-0000000000a4'
 WHERE id = 'b1501111-0000-0000-0000-000000000001';
SELECT is(
  (SELECT owner_user_id FROM public.inboxes WHERE id = 'b1501111-0000-0000-0000-000000000001'),
  'b1500000-0000-0000-0000-0000000000a3'::uuid,
  'the owner of a live inbox cannot be changed (a reconnect upsert by someone else keeps it)');

-- Revival by a different person starts private.
UPDATE public.inboxes SET visibility = 'company', deleted_at = now() WHERE id = 'b1501111-0000-0000-0000-000000000009';
UPDATE public.inboxes SET deleted_at = NULL, owner_user_id = 'b1500000-0000-0000-0000-0000000000a4'
 WHERE id = 'b1501111-0000-0000-0000-000000000009';
SELECT is(
  (SELECT owner_user_id::text || '|' || visibility FROM public.inboxes WHERE id = 'b1501111-0000-0000-0000-000000000009'),
  'b1500000-0000-0000-0000-0000000000a4|private',
  'a soft-deleted inbox revived by someone else is theirs and private');
UPDATE public.inboxes SET deleted_at = now() WHERE id = 'b1501111-0000-0000-0000-000000000009';

-- ------------------------------------------------------------
-- 3. Helpers
-- ------------------------------------------------------------
SELECT ok(public.inbox_visible_to('b1501111-0000-0000-0000-000000000001', 'b1500000-0000-0000-0000-0000000000a3'),
  'inbox_visible_to: owner sees their private inbox');
SELECT ok(NOT public.inbox_visible_to('b1501111-0000-0000-0000-000000000001', 'b1500000-0000-0000-0000-0000000000a4'),
  'inbox_visible_to: another member does not');
SELECT ok(NOT public.inbox_visible_to('b1501111-0000-0000-0000-000000000001', 'b1500000-0000-0000-0000-0000000000a1'),
  'inbox_visible_to: not even the workspace owner');
SELECT ok(public.inbox_visible_to('b1501111-0000-0000-0000-000000000002', 'b1500000-0000-0000-0000-0000000000a4'),
  'inbox_visible_to: company inbox for every member');
SELECT ok(NOT public.inbox_visible_to('b1501111-0000-0000-0000-000000000002', 'b1500000-0000-0000-0000-0000000000a5'),
  'inbox_visible_to: never for a non-member');

SELECT is(
  public.credential_inbox_scope('b150aaaa-0000-0000-0000-00000000000a', 'b1500000-0000-0000-0000-0000000000a4', NULL),
  jsonb_build_object('restricted', true, 'inbox_ids', jsonb_build_array(
    'b1501111-0000-0000-0000-000000000002', 'b1501111-0000-0000-0000-000000000009')),
  'credential scope: N''s all-inboxes key reaches the company inbox and N''s own (soft-deleted) one, never M''s or O''s private ones');
SELECT is(
  public.credential_inbox_scope('b150aaaa-0000-0000-0000-00000000000a', 'b1500000-0000-0000-0000-0000000000a4',
    ARRAY['b1501111-0000-0000-0000-000000000001'::uuid]),
  jsonb_build_object('restricted', true, 'inbox_ids', '[]'::jsonb),
  'credential scope: a key allow-listed to M''s private inbox reaches nothing when it acts as N');
SELECT is(
  public.credential_inbox_scope('b150aaaa-0000-0000-0000-00000000000a', 'b1500000-0000-0000-0000-0000000000a5', NULL)->>'inbox_ids',
  '[]', 'credential scope: a non-member (e.g. a removed member) reaches nothing');
SELECT is(
  (public.credential_inbox_scope('b150aaaa-0000-0000-0000-00000000000a', NULL, NULL)->'inbox_ids') @> jsonb_build_array('b1501111-0000-0000-0000-000000000003'),
  true, 'credential scope: a key with no creator acts as the workspace owner');
SELECT is(
  public.credential_inbox_scope('b150bbbb-0000-0000-0000-00000000000b', 'b1500000-0000-0000-0000-0000000000a5', NULL),
  jsonb_build_object('restricted', false, 'inbox_ids', NULL),
  'credential scope: nothing hidden (single-member workspace) leaves the key unrestricted');

-- ------------------------------------------------------------
-- 4. Member N: company only
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"b1500000-0000-0000-0000-0000000000a4","role":"authenticated"}';

SELECT is((SELECT array_agg(email_address ORDER BY email_address) FROM public.inboxes),
  ARRAY['team@vis.invalid'], '[N] sees only the company inbox');
SELECT is((SELECT count(*)::int FROM public.inboxes WHERE id = 'b1501111-0000-0000-0000-000000000001'),
  0, '[N] cannot select M''s private inbox by id (signature included)');
SELECT is((SELECT count(*)::int FROM public.reminders), 1, '[N] sees reminders of the company inbox only');
SELECT is((SELECT count(*)::int FROM public.scheduled_sends), 1, '[N] sees scheduled sends of the company inbox only');
SELECT is((SELECT count(*)::int FROM public.activity_log WHERE workspace_id = 'b150aaaa-0000-0000-0000-00000000000a'),
  2, '[N] sees activity of the company inbox and inbox-less rows only');
SELECT is((SELECT count(*)::int FROM public.workspace_inbox_directory('b150aaaa-0000-0000-0000-00000000000a')),
  1, '[N] the directory lists only what N can see');
UPDATE public.scheduled_sends SET status = 'cancelled' WHERE inbox_id = 'b1501111-0000-0000-0000-000000000001';
SELECT is(
  (SELECT count(*)::int FROM public.my_visible_inbox_ids() AS x(ids), unnest(x.ids) AS u WHERE u = 'b1501111-0000-0000-0000-000000000001'),
  0, '[N] my_visible_inbox_ids excludes M''s private inbox');

-- ------------------------------------------------------------
-- 5. Member M: company + own private
-- ------------------------------------------------------------
SET LOCAL "request.jwt.claims" TO '{"sub":"b1500000-0000-0000-0000-0000000000a3","role":"authenticated"}';

SELECT is((SELECT array_agg(email_address ORDER BY email_address) FROM public.inboxes),
  ARRAY['m@vis.invalid', 'team@vis.invalid'], '[M] sees the company inbox and their own private one');
SELECT is((SELECT signature_text FROM public.inboxes WHERE id = 'b1501111-0000-0000-0000-000000000001'),
  'M private signature', '[M] reads their own signature');
SELECT is((SELECT count(*)::int FROM public.reminders), 2, '[M] sees reminders of both');
SELECT is((SELECT count(*)::int FROM public.scheduled_sends WHERE status = 'pending'), 2,
  '[M] sees both scheduled sends, and N''s cancel attempt on M''s private one changed nothing');
SELECT is((SELECT count(*)::int FROM public.inboxes WHERE id = 'b1501111-0000-0000-0000-000000000003'),
  0, '[M] cannot see the workspace owner''s private inbox');

-- ------------------------------------------------------------
-- 6. Admin A and owner O: metadata of everything, rows only of what they can see
-- ------------------------------------------------------------
SET LOCAL "request.jwt.claims" TO '{"sub":"b1500000-0000-0000-0000-0000000000a2","role":"authenticated"}';

SELECT is((SELECT array_agg(email_address ORDER BY email_address) FROM public.inboxes),
  ARRAY['team@vis.invalid'], '[admin] the inboxes rows are still only the company inbox');
SELECT is(
  (SELECT array_agg(email_address || ':' || visibility || ':' || can_access::text ORDER BY email_address)
     FROM public.workspace_inbox_directory('b150aaaa-0000-0000-0000-00000000000a')),
  ARRAY['m@vis.invalid:private:false', 'o@vis.invalid:private:false', 'team@vis.invalid:company:true'],
  '[admin] the directory lists every live inbox with visibility and access');
SELECT is(
  (SELECT owner_email FROM public.workspace_inbox_directory('b150aaaa-0000-0000-0000-00000000000a')
    WHERE email_address = 'm@vis.invalid'),
  'vis-member@rls-test.invalid', '[admin] the directory names the owner person');
SELECT is((SELECT count(*)::int FROM public.reminders), 1, '[admin] no reminders of a private inbox they cannot see');

SET LOCAL "request.jwt.claims" TO '{"sub":"b1500000-0000-0000-0000-0000000000a1","role":"authenticated"}';
SELECT is((SELECT array_agg(email_address ORDER BY email_address) FROM public.inboxes),
  ARRAY['o@vis.invalid', 'team@vis.invalid'], '[owner] sees the company inbox and their own private one');
SELECT is((SELECT count(*)::int FROM public.inboxes WHERE id = 'b1501111-0000-0000-0000-000000000001'),
  0, '[owner] cannot read the member''s private inbox row (signature)');
SELECT is((SELECT count(*)::int FROM public.workspace_inbox_directory('b150aaaa-0000-0000-0000-00000000000a')),
  3, '[owner] the directory lists all three');

-- ------------------------------------------------------------
-- 7. Outsider X: nothing
-- ------------------------------------------------------------
SET LOCAL "request.jwt.claims" TO '{"sub":"b1500000-0000-0000-0000-0000000000a5","role":"authenticated"}';
SELECT is((SELECT count(*)::int FROM public.inboxes WHERE workspace_id = 'b150aaaa-0000-0000-0000-00000000000a'),
  0, '[outsider] sees no inbox of the workspace');
SELECT is((SELECT count(*)::int FROM public.workspace_inbox_directory('b150aaaa-0000-0000-0000-00000000000a')),
  0, '[outsider] the directory is empty');
SELECT is((SELECT count(*)::int FROM public.reminders WHERE workspace_id = 'b150aaaa-0000-0000-0000-00000000000a'),
  0, '[outsider] no reminders');

-- ------------------------------------------------------------
-- 8. Future activity_log partitions carry the visibility policy
-- ------------------------------------------------------------
RESET ROLE;
SELECT ok(
  (SELECT bool_and(qual LIKE '%my_visible_inbox_ids%') FROM pg_policies
    WHERE schemaname = 'public' AND tablename LIKE 'activity_log%' AND policyname LIKE '%_select_members'),
  'every activity_log policy checks inbox visibility');
SELECT ok(
  pg_get_functiondef('public.ensure_activity_log_partitions(int)'::regprocedure) LIKE '%my_visible_inbox_ids%',
  'new activity_log partitions get the visibility policy');

SELECT * FROM finish();
ROLLBACK;
