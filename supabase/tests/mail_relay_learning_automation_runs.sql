-- ============================================================
-- Mail relay learning gate: automation runs are direct successes
-- ============================================================
-- Covers migration 20261026140000_mail_relay_learning_automation_runs:
--   - a host whose automations connect directly many times is never learned,
--     even with only a couple of tool calls (the rambler / potsofjoy case)
--   - only runs that got past the provider search count ('failed' does not)
--   - runs the relay carried (fallback or learned route) are subtracted
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(6);

SELECT public.ensure_activity_log_partitions(1);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('e2000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'relay-auto@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('e2f00000-0000-0000-0000-00000000000f', 'relay-auto-ws', 'Relay Auto', 'e2000000-0000-0000-0000-0000000000f1', 'solo');

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host, smtp_host)
VALUES
  ('e2000000-0000-0000-0000-0000000000a1', 'e2f00000-0000-0000-0000-00000000000f', 'imap',
   'auto@relay-test.invalid', 'active', 'imap.automated-test.invalid', NULL),
  ('e2000000-0000-0000-0000-0000000000a2', 'e2f00000-0000-0000-0000-00000000000f', 'imap',
   'failing@relay-test.invalid', 'active', 'imap.failing-test.invalid', NULL),
  ('e2000000-0000-0000-0000-0000000000a3', 'e2f00000-0000-0000-0000-00000000000f', 'imap',
   'relayed@relay-test.invalid', 'active', 'imap.relayed-test.invalid', NULL);

INSERT INTO public.api_keys (id, workspace_id, name, key_hash, key_prefix, scopes)
VALUES ('e2000000-0000-0000-0000-0000000000c1', 'e2f00000-0000-0000-0000-00000000000f',
        'relay auto key', 'relay-auto-test-hash', 'mcpe_ra', ARRAY['read:email']);

INSERT INTO public.triage_rules (id, workspace_id, inbox_id, api_key_id, name, enabled, filter, action, interval_minutes)
VALUES
  ('e2000000-0000-0000-0000-0000000000d1', 'e2f00000-0000-0000-0000-00000000000f',
   'e2000000-0000-0000-0000-0000000000a1', 'e2000000-0000-0000-0000-0000000000c1',
   'auto rule', true, '{}'::jsonb, '{"type":"mark_read"}'::jsonb, 15),
  ('e2000000-0000-0000-0000-0000000000d2', 'e2f00000-0000-0000-0000-00000000000f',
   'e2000000-0000-0000-0000-0000000000a2', 'e2000000-0000-0000-0000-0000000000c1',
   'failing rule', true, '{}'::jsonb, '{"type":"mark_read"}'::jsonb, 15),
  ('e2000000-0000-0000-0000-0000000000d3', 'e2f00000-0000-0000-0000-00000000000f',
   'e2000000-0000-0000-0000-0000000000a3', 'e2000000-0000-0000-0000-0000000000c1',
   'relayed rule', true, '{}'::jsonb, '{"type":"mark_read"}'::jsonb, 15);

-- The rambler shape: 2 tool calls, hundreds of automation runs that connected
-- directly, almost all of them 'skipped' (nothing new to act on).
INSERT INTO public.activity_log (workspace_id, inbox_id, tool_name, status)
SELECT 'e2f00000-0000-0000-0000-00000000000f', 'e2000000-0000-0000-0000-0000000000a1', 'email_read', 'success'
FROM generate_series(1, 2);
INSERT INTO public.triage_runs (rule_id, workspace_id, status, started_at, completed_at)
SELECT 'e2000000-0000-0000-0000-0000000000d1', 'e2f00000-0000-0000-0000-00000000000f',
       CASE WHEN g % 50 = 0 THEN 'completed' ELSE 'skipped' END,
       now() - g * interval '5 minutes', now() - g * interval '5 minutes' + interval '2 seconds'
FROM generate_series(1, 280) g;

SELECT is(
  public.learn_mail_relay_host('imap.automated-test.invalid', 'imap', 'Connection timed out (os error 110)', 'edge'),
  false,
  'a host its automations reach directly is NOT learned');
SELECT ok(
  (SELECT refused AND direct_successes = 282 FROM public.mail_relay_candidates WHERE host = 'imap.automated-test.invalid'),
  'it is refused on tool calls plus automation runs');

-- Failed runs never got an answer from the host, so they are not evidence.
INSERT INTO public.triage_runs (rule_id, workspace_id, status, started_at, completed_at, error_code)
SELECT 'e2000000-0000-0000-0000-0000000000d2', 'e2f00000-0000-0000-0000-00000000000f',
       'failed', now() - g * interval '5 minutes', now() - g * interval '5 minutes' + interval '30 seconds', 'search_failed'
FROM generate_series(1, 50) g;
INSERT INTO public.triage_runs (rule_id, workspace_id, status, started_at, completed_at)
SELECT 'e2000000-0000-0000-0000-0000000000d2', 'e2f00000-0000-0000-0000-00000000000f',
       'completed_with_errors', now() - g * interval '1 hour', now() - g * interval '1 hour' + interval '3 seconds'
FROM generate_series(1, 2) g;
SELECT is(
  public.learn_mail_relay_host('imap.failing-test.invalid', 'imap', 'Connection timed out (os error 110)', 'edge'),
  false,
  'a first rescue makes a candidate');
SELECT ok(
  (SELECT NOT refused AND direct_successes = 2 FROM public.mail_relay_candidates WHERE host = 'imap.failing-test.invalid'),
  'failed runs are not counted, completed_with_errors runs are');

-- Runs the relay carried (fallback rescues, and the learned route after a
-- learned row was deleted by hand) are subtracted.
INSERT INTO public.triage_runs (rule_id, workspace_id, status, started_at, completed_at)
SELECT 'e2000000-0000-0000-0000-0000000000d3', 'e2f00000-0000-0000-0000-00000000000f',
       'skipped', now() - g * interval '5 minutes', now() - g * interval '5 minutes' + interval '2 seconds'
FROM generate_series(1, 40) g;
INSERT INTO public.mail_relay_stats (hour, runtime, protocol, host, route, outcome, count, total_ms, last_at)
VALUES
  (date_trunc('hour', now()), 'edge', 'imap', 'imap.relayed-test.invalid', 'fallback', 'ok', 10, 10000, now()),
  (date_trunc('hour', now()), 'edge', 'imap', 'imap.relayed-test.invalid', 'learned', 'ok', 30, 30000, now());
SELECT is(
  public.learn_mail_relay_host('imap.relayed-test.invalid', 'imap', 'Connection timed out (os error 110)', 'edge'),
  false,
  'a first rescue makes a candidate');
SELECT ok(
  (SELECT NOT refused AND direct_successes = 0 FROM public.mail_relay_candidates WHERE host = 'imap.relayed-test.invalid'),
  'relay-carried runs are not direct successes');

SELECT * FROM finish();
ROLLBACK;
