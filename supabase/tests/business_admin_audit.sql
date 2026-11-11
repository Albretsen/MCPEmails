-- ============================================================
-- Business admin and audit (phase 2)
-- ============================================================
-- Covers 20261111130000_business_admin_audit.sql:
--   * activity_log.user_id: the column, the fill-in trigger on the parent and
--     on every partition (present and future), and what it fills;
--   * workspace_audit_events: owner/admin read, members and outsiders do not,
--     nobody writes through the API, the kind check, retention;
--   * workspaces.allowed_recipient_domains: the check, no user writes;
--   * send_approvals.hold_reason / requested_by.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(40);

-- ------------------------------------------------------------
-- 0. Fixtures (as the migration owner, which bypasses RLS)
-- ------------------------------------------------------------
-- O = owner, A = admin, M = member, X = outsider (owns workspace B).
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('c2a00000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'aud-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('c2a00000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'aud-admin@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('c2a00000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'aud-member@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('c2a00000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'aud-outsider@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.users (id, email, display_name) VALUES
  ('c2a00000-0000-0000-0000-0000000000a1', 'aud-owner@rls-test.invalid', 'Owner'),
  ('c2a00000-0000-0000-0000-0000000000a2', 'aud-admin@rls-test.invalid', 'Admin'),
  ('c2a00000-0000-0000-0000-0000000000a3', 'aud-member@rls-test.invalid', 'Member'),
  ('c2a00000-0000-0000-0000-0000000000a5', 'aud-outsider@rls-test.invalid', 'Outsider')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('c2aaaaaa-0000-0000-0000-00000000000a', 'aud-ws-team', 'Team', 'c2a00000-0000-0000-0000-0000000000a1', 'pro'),
  ('c2abbbbb-0000-0000-0000-00000000000b', 'aud-ws-free', 'Free', 'c2a00000-0000-0000-0000-0000000000a5', 'free')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('c2aaaaaa-0000-0000-0000-00000000000a', 'c2a00000-0000-0000-0000-0000000000a1', 'owner'),
  ('c2aaaaaa-0000-0000-0000-00000000000a', 'c2a00000-0000-0000-0000-0000000000a2', 'admin'),
  ('c2aaaaaa-0000-0000-0000-00000000000a', 'c2a00000-0000-0000-0000-0000000000a3', 'member'),
  ('c2abbbbb-0000-0000-0000-00000000000b', 'c2a00000-0000-0000-0000-0000000000a5', 'owner')
ON CONFLICT DO NOTHING;

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, owner_user_id, visibility) VALUES
  ('c2a11111-0000-0000-0000-000000000001', 'c2aaaaaa-0000-0000-0000-00000000000a', 'imap', 'team@aud.invalid', 'active',
   'c2a00000-0000-0000-0000-0000000000a1', 'company'),
  ('c2a11111-0000-0000-0000-000000000002', 'c2aaaaaa-0000-0000-0000-00000000000a', 'imap', 'm@aud.invalid', 'active',
   'c2a00000-0000-0000-0000-0000000000a3', 'private');

-- K1 minted by M; K2 with no creator (acts as the owner).
INSERT INTO public.api_keys (id, workspace_id, created_by, name, key_prefix, key_hash, scopes) VALUES
  ('c2a22222-0000-0000-0000-000000000001', 'c2aaaaaa-0000-0000-0000-00000000000a',
   'c2a00000-0000-0000-0000-0000000000a3', 'M key', 'mcpe_aum', 'c2a-m-hash', ARRAY['read:email']),
  ('c2a22222-0000-0000-0000-000000000002', 'c2aaaaaa-0000-0000-0000-00000000000a',
   NULL, 'Old key', 'mcpe_auo', 'c2a-o-hash', ARRAY['read:email']);

-- ------------------------------------------------------------
-- 1. activity_log.user_id
-- ------------------------------------------------------------
SELECT has_column('public', 'activity_log', 'user_id', 'activity_log.user_id exists');
SELECT is(
  (SELECT count(*)::int
     FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'activity_log'
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns col
                       WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'user_id')),
  0, 'every existing partition has user_id');
SELECT has_trigger('public', 'activity_log', 'activity_log_fill_user_id', 'the fill-in trigger is on the parent');
SELECT is(
  (SELECT count(*)::int
     FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'activity_log'
      AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'activity_log_fill_user_id')),
  0, 'every existing partition carries the trigger');

-- A partition created later (the monthly job) gets column, trigger and policy.
SELECT lives_ok($$SELECT public.ensure_activity_log_partitions(8)$$, 'the partition job runs');
SELECT is(
  (SELECT count(*)::int
     FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'activity_log'
      AND (NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'activity_log_fill_user_id')
           OR NOT EXISTS (SELECT 1 FROM information_schema.columns col
                           WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'user_id'))),
  0, 'new partitions get user_id and the trigger too');

INSERT INTO public.activity_log (id, workspace_id, api_key_id, inbox_id, tool_name, status) VALUES
  ('c2a33333-0000-0000-0000-000000000001', 'c2aaaaaa-0000-0000-0000-00000000000a',
   'c2a22222-0000-0000-0000-000000000001', 'c2a11111-0000-0000-0000-000000000001', 'email_send', 'success'),
  ('c2a33333-0000-0000-0000-000000000002', 'c2aaaaaa-0000-0000-0000-00000000000a',
   'c2a22222-0000-0000-0000-000000000002', 'c2a11111-0000-0000-0000-000000000001', 'email_read', 'success'),
  ('c2a33333-0000-0000-0000-000000000003', 'c2aaaaaa-0000-0000-0000-00000000000a',
   NULL, NULL, 'automation_run', 'success'),
  ('c2a33333-0000-0000-0000-000000000005', 'c2aaaaaa-0000-0000-0000-00000000000a',
   'c2a22222-0000-0000-0000-000000000001', 'c2a11111-0000-0000-0000-000000000002', 'email_read', 'success');
INSERT INTO public.activity_log (id, workspace_id, api_key_id, user_id, tool_name, status) VALUES
  ('c2a33333-0000-0000-0000-000000000004', 'c2aaaaaa-0000-0000-0000-00000000000a',
   'c2a22222-0000-0000-0000-000000000002', 'c2a00000-0000-0000-0000-0000000000a2', 'email_read', 'success'),
  -- M's own cross-inbox call (no inbox named).
  ('c2a33333-0000-0000-0000-000000000006', 'c2aaaaaa-0000-0000-0000-00000000000a',
   'c2a22222-0000-0000-0000-000000000001', 'c2a00000-0000-0000-0000-0000000000a3', 'email_search', 'success');

SELECT is((SELECT user_id FROM public.activity_log WHERE id = 'c2a33333-0000-0000-0000-000000000001'),
  'c2a00000-0000-0000-0000-0000000000a3'::uuid, 'a key''s call is filled with its creator');
SELECT is((SELECT user_id FROM public.activity_log WHERE id = 'c2a33333-0000-0000-0000-000000000002'),
  'c2a00000-0000-0000-0000-0000000000a1'::uuid, 'a key with no creator acts as the workspace owner');
SELECT is((SELECT user_id FROM public.activity_log WHERE id = 'c2a33333-0000-0000-0000-000000000003'),
  'c2a00000-0000-0000-0000-0000000000a1'::uuid, 'a row with no key is the workspace owner''s');
SELECT is((SELECT user_id FROM public.activity_log WHERE id = 'c2a33333-0000-0000-0000-000000000004'),
  'c2a00000-0000-0000-0000-0000000000a2'::uuid, 'a user_id the writer passed is kept');
SELECT ok(has_column_privilege('authenticated', 'public.activity_log', 'user_id', 'SELECT'),
  'members can read user_id (row access stays with the RLS policies)');
SELECT ok(NOT has_function_privilege('authenticated', 'public.activity_log_fill_user_id()', 'EXECUTE'),
  'the trigger function is not callable by API roles');

-- ------------------------------------------------------------
-- 2. workspace_audit_events: schema
-- ------------------------------------------------------------
SELECT has_table('public', 'workspace_audit_events', 'workspace_audit_events exists');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.workspace_audit_events'::regclass), 'RLS is on');

INSERT INTO public.workspace_audit_events (id, workspace_id, actor_user_id, kind, target, details, created_at) VALUES
  ('c2a44444-0000-0000-0000-000000000001', 'c2aaaaaa-0000-0000-0000-00000000000a',
   'c2a00000-0000-0000-0000-0000000000a1', 'role_changed', 'c2a00000-0000-0000-0000-0000000000a2',
   '{"from":"member","to":"admin"}', now()),
  ('c2a44444-0000-0000-0000-000000000002', 'c2aaaaaa-0000-0000-0000-00000000000a',
   'c2a00000-0000-0000-0000-0000000000a2', 'recipient_rule_changed', NULL,
   '{"from":null,"to":["aud.invalid"]}', now()),
  ('c2a44444-0000-0000-0000-000000000003', 'c2abbbbb-0000-0000-0000-00000000000b',
   'c2a00000-0000-0000-0000-0000000000a5', 'invite_sent', 'friend@aud.invalid', '{}', now());

SELECT throws_ok(
  $$INSERT INTO public.workspace_audit_events (workspace_id, kind) VALUES ('c2aaaaaa-0000-0000-0000-00000000000a', 'mail_read')$$,
  '23514', NULL, 'kind is a closed list');
SELECT throws_ok(
  $$INSERT INTO public.workspace_audit_events (workspace_id, kind, details) VALUES ('c2aaaaaa-0000-0000-0000-00000000000a', 'member_left', '[]')$$,
  '23514', NULL, 'details is an object');

-- ------------------------------------------------------------
-- 3. Recipient rule and send_approvals columns
-- ------------------------------------------------------------
SELECT has_column('public', 'workspaces', 'allowed_recipient_domains', 'workspaces.allowed_recipient_domains exists');
SELECT is((SELECT allowed_recipient_domains FROM public.workspaces WHERE id = 'c2aaaaaa-0000-0000-0000-00000000000a'),
  NULL, 'no rule by default (any recipient)');
SELECT lives_ok(
  $$UPDATE public.workspaces SET allowed_recipient_domains = ARRAY['aud.invalid'] WHERE id = 'c2aaaaaa-0000-0000-0000-00000000000a'$$,
  'the server can set a list');
SELECT throws_ok(
  $$UPDATE public.workspaces SET allowed_recipient_domains = '{}' WHERE id = 'c2aaaaaa-0000-0000-0000-00000000000a'$$,
  '23514', NULL, 'an empty list is refused (NULL means any)');
SELECT throws_ok(
  $$UPDATE public.workspaces SET allowed_recipient_domains = ARRAY['a.invalid', NULL] WHERE id = 'c2aaaaaa-0000-0000-0000-00000000000a'$$,
  '23514', NULL, 'a NULL entry is refused');
SELECT ok(NOT has_column_privilege('authenticated', 'public.workspaces', 'allowed_recipient_domains', 'UPDATE'),
  'members cannot write the rule directly');

SELECT has_column('public', 'send_approvals', 'hold_reason', 'send_approvals.hold_reason exists');
SELECT has_column('public', 'send_approvals', 'requested_by', 'send_approvals.requested_by exists');
SELECT lives_ok(
  $$INSERT INTO public.send_approvals (workspace_id, inbox_id, operation, payload, status, hold_reason, requested_by)
    VALUES ('c2aaaaaa-0000-0000-0000-00000000000a', 'c2a11111-0000-0000-0000-000000000002', 'schedule_create',
            '{"v":1,"data":"x"}', 'pending', 'recipient_rule', 'c2a00000-0000-0000-0000-0000000000a3')$$,
  'a keyless recipient-rule hold can be written');
SELECT throws_ok(
  $$INSERT INTO public.send_approvals (workspace_id, inbox_id, operation, payload, status, hold_reason)
    VALUES ('c2aaaaaa-0000-0000-0000-00000000000a', 'c2a11111-0000-0000-0000-000000000002', 'email_send',
            '{"v":1,"data":"x"}', 'pending', 'because')$$,
  '23514', NULL, 'hold_reason is a closed list');

-- ------------------------------------------------------------
-- 4. RLS as each person
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;

SET LOCAL "request.jwt.claims" TO '{"sub":"c2a00000-0000-0000-0000-0000000000a1","role":"authenticated"}';
SELECT is((SELECT count(*)::int FROM public.workspace_audit_events), 2, '[owner] reads their workspace''s team changes only');

SET LOCAL "request.jwt.claims" TO '{"sub":"c2a00000-0000-0000-0000-0000000000a2","role":"authenticated"}';
SELECT is((SELECT count(*)::int FROM public.workspace_audit_events), 2, '[admin] reads them too');
SELECT is((SELECT count(*)::int FROM public.activity_log
            WHERE workspace_id = 'c2aaaaaa-0000-0000-0000-00000000000a' AND inbox_id IS NULL),
  3, '[admin] sees every no-inbox call in the workspace');

SET LOCAL "request.jwt.claims" TO '{"sub":"c2a00000-0000-0000-0000-0000000000a3","role":"authenticated"}';
SELECT is((SELECT count(*)::int FROM public.workspace_audit_events), 0, '[member] reads none');
SELECT is(
  (SELECT array_agg(user_id::text ORDER BY id) FROM public.activity_log WHERE workspace_id = 'c2aaaaaa-0000-0000-0000-00000000000a'),
  ARRAY['c2a00000-0000-0000-0000-0000000000a3', 'c2a00000-0000-0000-0000-0000000000a1',
        'c2a00000-0000-0000-0000-0000000000a3', 'c2a00000-0000-0000-0000-0000000000a3'],
  '[member] reads the company inbox''s calls, their own private inbox''s, and only THEIR OWN no-inbox calls');
SELECT is((SELECT count(*)::int FROM public.activity_log
            WHERE workspace_id = 'c2aaaaaa-0000-0000-0000-00000000000a' AND inbox_id IS NULL
              AND user_id IS DISTINCT FROM 'c2a00000-0000-0000-0000-0000000000a3'),
  0, '[member] never sees someone else''s call that named no inbox');
SELECT throws_ok(
  $$INSERT INTO public.workspace_audit_events (workspace_id, kind) VALUES ('c2aaaaaa-0000-0000-0000-00000000000a', 'member_left')$$,
  '42501', NULL, '[member] cannot write a team change');
SELECT throws_ok(
  $$UPDATE public.workspaces SET allowed_recipient_domains = NULL WHERE id = 'c2aaaaaa-0000-0000-0000-00000000000a'$$,
  '42501', NULL, '[member] cannot clear the recipient rule directly');

SET LOCAL "request.jwt.claims" TO '{"sub":"c2a00000-0000-0000-0000-0000000000a1","role":"authenticated"}';
SELECT throws_ok(
  $$INSERT INTO public.workspace_audit_events (workspace_id, kind) VALUES ('c2aaaaaa-0000-0000-0000-00000000000a', 'member_left')$$,
  '42501', NULL, '[owner] cannot forge a team change either');
SELECT throws_ok(
  $$DELETE FROM public.workspace_audit_events$$,
  '42501', NULL, '[owner] cannot delete team changes');

SET LOCAL "request.jwt.claims" TO '{"sub":"c2a00000-0000-0000-0000-0000000000a5","role":"authenticated"}';
SELECT is((SELECT count(*)::int FROM public.workspace_audit_events), 1, '[outsider] reads only their own workspace''s');

RESET ROLE;

-- ------------------------------------------------------------
-- 5. Retention: the plan window with a 90-day floor
-- ------------------------------------------------------------
INSERT INTO public.workspace_audit_events (id, workspace_id, kind, created_at) VALUES
  ('c2a55555-0000-0000-0000-000000000001', 'c2abbbbb-0000-0000-0000-00000000000b', 'member_left', now() - interval '60 days'),
  ('c2a55555-0000-0000-0000-000000000002', 'c2abbbbb-0000-0000-0000-00000000000b', 'member_left', now() - interval '120 days'),
  ('c2a55555-0000-0000-0000-000000000003', 'c2aaaaaa-0000-0000-0000-00000000000a', 'member_left', now() - interval '400 days'),
  ('c2a55555-0000-0000-0000-000000000004', 'c2aaaaaa-0000-0000-0000-00000000000a', 'member_left', now() - interval '800 days');

SELECT ok(public.purge_workspace_audit_events_batch() >= 2, 'the purge deletes what is past its window');
SELECT is(
  (SELECT array_agg(id::text ORDER BY id) FROM public.workspace_audit_events WHERE id::text LIKE 'c2a55555%'),
  ARRAY['c2a55555-0000-0000-0000-000000000001', 'c2a55555-0000-0000-0000-000000000003'],
  'Free keeps 90 days (its 30-day window is floored), Business keeps two years');
SELECT ok(NOT has_function_privilege('authenticated', 'public.purge_workspace_audit_events_batch(integer, integer)', 'EXECUTE'),
  'the purge is not callable by API roles');

SELECT * FROM finish();
ROLLBACK;
