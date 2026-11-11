-- ============================================================
-- Broken-inbox alert (20261111140000_inbox_broken_alert.sql)
-- ============================================================
--   - inbox_alert_sends: RLS on, no anon/authenticated access, one row per
--     (inbox, break start, phase)
--   - inbox_alert_candidates(): only broken inboxes (status error, or the
--     login-refused marker) on paid, active, external workspaces; not deleted,
--     not parked; break dated from the first auth_failed after the last
--     success, and after the last break the ledger closed
--   - the experiment row, the funnel vocabulary, the read-out, the cron job
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(17);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('ab100000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'alert-paid@inbox-alert-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('ab100000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'alert-free@inbox-alert-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('ab100000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'alert-cancelled@inbox-alert-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('ab100000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'alert-internal@mcpemails.com', 'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.users (id, email, display_name) VALUES
  ('ab100000-0000-0000-0000-0000000000a1', 'alert-paid@inbox-alert-test.invalid', 'Paid'),
  ('ab100000-0000-0000-0000-0000000000b1', 'alert-free@inbox-alert-test.invalid', 'Free'),
  ('ab100000-0000-0000-0000-0000000000c1', 'alert-cancelled@inbox-alert-test.invalid', 'Cancelled'),
  ('ab100000-0000-0000-0000-0000000000d1', 'alert-internal@mcpemails.com', 'Internal')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('ab10aaaa-0000-0000-0000-00000000000a', 'alert-ws-a', 'Paid', 'ab100000-0000-0000-0000-0000000000a1', 'personal'),
  ('ab10aaaa-0000-0000-0000-00000000000b', 'alert-ws-b', 'Free', 'ab100000-0000-0000-0000-0000000000b1', 'free'),
  ('ab10aaaa-0000-0000-0000-00000000000c', 'alert-ws-c', 'Cancelled', 'ab100000-0000-0000-0000-0000000000c1', 'personal'),
  ('ab10aaaa-0000-0000-0000-00000000000d', 'alert-ws-d', 'Internal', 'ab100000-0000-0000-0000-0000000000d1', 'pro')
ON CONFLICT DO NOTHING;
-- A plan trigger may have rewritten the plan on insert; pin what the test means.
UPDATE public.workspaces SET plan = 'personal' WHERE id IN ('ab10aaaa-0000-0000-0000-00000000000a', 'ab10aaaa-0000-0000-0000-00000000000c');
UPDATE public.workspaces SET plan = 'pro' WHERE id = 'ab10aaaa-0000-0000-0000-00000000000d';

INSERT INTO public.user_billing (user_id, plan, subscription_status) VALUES
  ('ab100000-0000-0000-0000-0000000000a1', 'personal', 'active'),
  ('ab100000-0000-0000-0000-0000000000b1', 'free', NULL),
  ('ab100000-0000-0000-0000-0000000000c1', 'personal', 'canceled'),
  ('ab100000-0000-0000-0000-0000000000d1', 'pro', 'active')
ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan, subscription_status = EXCLUDED.subscription_status;

CREATE TEMP TABLE t_marker AS
SELECT 'The mail server refused this mailbox''s password. Reconnect this inbox to restore access. (Checked '
       || to_char((now() - interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || ')' AS v;

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, last_error, imap_host, smtp_host) VALUES
  -- A1: refused password, a candidate
  ('ab101111-0000-0000-0000-000000000001', 'ab10aaaa-0000-0000-0000-00000000000a', 'imap', 'a1@inbox-alert-test.invalid', 'active',
   (SELECT v FROM t_marker), 'imap.inbox-alert-test.invalid', 'smtp.inbox-alert-test.invalid'),
  -- A2: healthy
  ('ab101111-0000-0000-0000-000000000002', 'ab10aaaa-0000-0000-0000-00000000000a', 'imap', 'a2@inbox-alert-test.invalid', 'active',
   NULL, 'imap.inbox-alert-test.invalid', 'smtp.inbox-alert-test.invalid'),
  -- A3: token refused, a candidate
  ('ab101111-0000-0000-0000-000000000003', 'ab10aaaa-0000-0000-0000-00000000000a', 'gmail', 'a3@inbox-alert-test.invalid', 'error',
   'Google rejected the saved access.', NULL, NULL),
  -- A4: refused but deleted
  ('ab101111-0000-0000-0000-000000000004', 'ab10aaaa-0000-0000-0000-00000000000a', 'imap', 'a4@inbox-alert-test.invalid', 'active',
   (SELECT v FROM t_marker), 'imap.inbox-alert-test.invalid', 'smtp.inbox-alert-test.invalid'),
  -- A5: refused but parked
  ('ab101111-0000-0000-0000-000000000005', 'ab10aaaa-0000-0000-0000-00000000000a', 'imap', 'a5@inbox-alert-test.invalid', 'active',
   (SELECT v FROM t_marker), 'imap.inbox-alert-test.invalid', 'smtp.inbox-alert-test.invalid'),
  -- B, C, D: refused, but free / cancelled / internal
  ('ab101111-0000-0000-0000-00000000000b', 'ab10aaaa-0000-0000-0000-00000000000b', 'imap', 'b@inbox-alert-test.invalid', 'active',
   (SELECT v FROM t_marker), 'imap.inbox-alert-test.invalid', 'smtp.inbox-alert-test.invalid'),
  ('ab101111-0000-0000-0000-00000000000c', 'ab10aaaa-0000-0000-0000-00000000000c', 'imap', 'c@inbox-alert-test.invalid', 'active',
   (SELECT v FROM t_marker), 'imap.inbox-alert-test.invalid', 'smtp.inbox-alert-test.invalid'),
  ('ab101111-0000-0000-0000-00000000000d', 'ab10aaaa-0000-0000-0000-00000000000d', 'imap', 'd@inbox-alert-test.invalid', 'active',
   (SELECT v FROM t_marker), 'imap.inbox-alert-test.invalid', 'smtp.inbox-alert-test.invalid');

UPDATE public.inboxes SET deleted_at = now() WHERE id = 'ab101111-0000-0000-0000-000000000004';
UPDATE public.inboxes SET parked_at = now(), parked_reason = 'plan_limit' WHERE id = 'ab101111-0000-0000-0000-000000000005';

-- A1: refused 4 days ago, success 3 days ago, refused again 2 days and 1 day ago.
INSERT INTO public.activity_log (workspace_id, inbox_id, tool_name, status, error_code, created_at) VALUES
  ('ab10aaaa-0000-0000-0000-00000000000a', 'ab101111-0000-0000-0000-000000000001', 'email_search', 'error', 'auth_failed', now() - interval '4 days'),
  ('ab10aaaa-0000-0000-0000-00000000000a', 'ab101111-0000-0000-0000-000000000001', 'email_search', 'success', NULL, now() - interval '3 days'),
  ('ab10aaaa-0000-0000-0000-00000000000a', 'ab101111-0000-0000-0000-000000000001', 'email_search', 'error', 'auth_failed', now() - interval '2 days'),
  ('ab10aaaa-0000-0000-0000-00000000000a', 'ab101111-0000-0000-0000-000000000001', 'email_read', 'error', 'auth_failed', now() - interval '1 day'),
  ('ab10aaaa-0000-0000-0000-00000000000a', 'ab101111-0000-0000-0000-000000000001', 'email_read', 'error', 'search_timeout', now() - interval '12 hours');

-- 1-3: the ledger is service-role only
SELECT has_table('public', 'inbox_alert_sends', 'inbox_alert_sends exists');
SELECT ok(
  (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'inbox_alert_sends'),
  'inbox_alert_sends has RLS enabled');
SELECT ok(NOT has_table_privilege('authenticated', 'public.inbox_alert_sends', 'SELECT'), 'authenticated cannot read the ledger');

-- 4-6: who is a candidate
SELECT results_eq(
  $$SELECT inbox_id FROM public.inbox_alert_candidates(90)
     WHERE workspace_id::text LIKE 'ab10aaaa-%' ORDER BY inbox_id$$,
  $$VALUES ('ab101111-0000-0000-0000-000000000001'::uuid), ('ab101111-0000-0000-0000-000000000003'::uuid)$$,
  'only the refused, live, unparked inboxes of the paid external workspace');
SELECT is(
  (SELECT first_auth_failed_at FROM public.inbox_alert_candidates(90) WHERE inbox_id = 'ab101111-0000-0000-0000-000000000001'),
  now() - interval '2 days',
  'the break starts at the first auth_failed after the last success');
SELECT is(
  (SELECT last_success_at FROM public.inbox_alert_candidates(90) WHERE inbox_id = 'ab101111-0000-0000-0000-000000000001'),
  now() - interval '3 days',
  'the last success is reported');
SELECT ok(
  (SELECT error_row_at IS NOT NULL AND first_auth_failed_at IS NULL
     FROM public.inbox_alert_candidates(90) WHERE inbox_id = 'ab101111-0000-0000-0000-000000000003'),
  'an error row with no auth_failed call is dated by the row');
SELECT ok(NOT has_function_privilege('authenticated', 'public.inbox_alert_candidates(integer)', 'EXECUTE'),
  'authenticated cannot call the candidate list');

-- 8-10: one row per (inbox, break, phase); a closed break moves the next break start
INSERT INTO public.inbox_alert_sends (inbox_id, workspace_id, user_id, break_started_at, phase, arm, status, provider)
VALUES ('ab101111-0000-0000-0000-000000000001', 'ab10aaaa-0000-0000-0000-00000000000a', 'ab100000-0000-0000-0000-0000000000a1',
        now() - interval '2 days', 1, 'holdout', 'holdout', 'imap');
SELECT throws_ok(
  $$INSERT INTO public.inbox_alert_sends (inbox_id, workspace_id, break_started_at, phase, arm, status, provider)
    VALUES ('ab101111-0000-0000-0000-000000000001', 'ab10aaaa-0000-0000-0000-00000000000a', now() - interval '2 days', 1, 'alert', 'claimed', 'imap')$$,
  '23505', NULL, 'the same break and phase cannot be recorded twice');
SELECT throws_ok(
  $$INSERT INTO public.inbox_alert_sends (inbox_id, workspace_id, break_started_at, phase, arm, status, provider)
    VALUES ('ab101111-0000-0000-0000-000000000001', 'ab10aaaa-0000-0000-0000-00000000000a', now(), 3, 'alert', 'claimed', 'imap')$$,
  '23514', NULL, 'only phases 1 and 2');
UPDATE public.inbox_alert_sends SET closed_at = now() - interval '36 hours', close_reason = 'reconnected'
 WHERE inbox_id = 'ab101111-0000-0000-0000-000000000001';
SELECT is(
  (SELECT first_auth_failed_at FROM public.inbox_alert_candidates(90) WHERE inbox_id = 'ab101111-0000-0000-0000-000000000001'),
  now() - interval '1 day',
  'after a closed break, the next break starts at the first auth_failed after it');

-- 11: the read-out counts the closed holdout break as reconnected within 7 days
SELECT ok(
  (SELECT reconnected_7d >= 1 FROM public.inbox_alert_readout() WHERE arm = 'holdout'),
  'the read-out counts a reconnect within 7 days');

-- 12-13: experiment and funnel vocabulary
SELECT results_eq(
  $$SELECT status, variants->0->>'id' FROM public.experiments WHERE key = 'inbox_broken_alert'$$,
  $$VALUES ('running'::text, 'holdout'::text)$$,
  'the experiment is running with the holdout as variants[0]');
SELECT lives_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category) VALUES
      ('ab10aaaa-0000-0000-0000-00000000000a', 'inbox_alert_sent', 'success', 'alert_1'),
      ('ab10aaaa-0000-0000-0000-00000000000a', 'inbox_alert_holdout', 'success', 'alert_2'),
      ('ab10aaaa-0000-0000-0000-00000000000a', 'inbox_reconnected', 'success', 'holdout')$$,
  'the funnel accepts the new stages and categories');
SELECT lives_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category) VALUES
      ('ab10aaaa-0000-0000-0000-00000000000a', 'inbox_connection', 'success', 'gmail')$$,
  'existing funnel values still pass');

-- 15-16: dispatcher
SELECT is(
  (SELECT schedule FROM cron.job WHERE jobname = 'dispatch-inbox-alert'),
  '41 * * * *',
  'the dispatcher runs hourly at minute 41');
SELECT ok(NOT has_function_privilege('authenticated', 'public.dispatch_inbox_alert()', 'EXECUTE'),
  'authenticated cannot call the dispatcher');

SELECT * FROM finish();
ROLLBACK;
