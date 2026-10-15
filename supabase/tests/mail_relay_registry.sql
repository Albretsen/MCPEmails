-- ============================================================
-- Mail relay registry
-- ============================================================
-- Covers migration 20261015180000_mail_relay_registry:
--   - service-role only: a browser session can neither read nor call it
--   - learn_mail_relay_host: learns a host that is not working directly,
--     REFUSES one that is (the gate that keeps a big provider off the relay
--     after one lucky retry), and refreshes a known host without the gate
--   - record_mail_relay_use: one counter row per hour and key, incremented
--   - the two /admin/growth readers
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(17);

SELECT public.ensure_activity_log_partitions(1);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('e1000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'relay-alice@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('ef000000-0000-0000-0000-00000000000f', 'relay-a', 'Relay A', 'e1000000-0000-0000-0000-0000000000f1', 'solo');

-- A busy host that works directly (Yahoo-like), and a host nobody can send through.
INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host, smtp_host)
VALUES
  ('e0000000-0000-0000-0000-0000000000f1', 'ef000000-0000-0000-0000-00000000000f', 'imap',
   'busy@relay-test.invalid', 'active', 'imap.busy-test.invalid', 'smtp.busy-test.invalid'),
  ('e0000000-0000-0000-0000-0000000000f2', 'ef000000-0000-0000-0000-00000000000f', 'imap',
   'blocked@relay-test.invalid', 'active', 'imap.blocked-test.invalid', NULL);

INSERT INTO public.activity_log (workspace_id, inbox_id, tool_name, status)
SELECT 'ef000000-0000-0000-0000-00000000000f', 'e0000000-0000-0000-0000-0000000000f1', 'email_read', 'success'
FROM generate_series(1, 30);
INSERT INTO public.activity_log (workspace_id, inbox_id, tool_name, status, error_code)
SELECT 'ef000000-0000-0000-0000-00000000000f', 'e0000000-0000-0000-0000-0000000000f1', 'email_read', 'error', 'provider_error'
FROM generate_series(1, 2);

-- ------------------------------------------------------------
-- 1. Service role only
-- ------------------------------------------------------------
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.mail_relay_hosts'::regclass), 'mail_relay_hosts has RLS');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.mail_relay_stats'::regclass), 'mail_relay_stats has RLS');
SELECT ok(NOT has_table_privilege('authenticated', 'public.mail_relay_hosts', 'SELECT'), 'a browser session cannot read learned hosts');
SELECT ok(NOT has_table_privilege('anon', 'public.mail_relay_stats', 'SELECT'), 'nor the relay counters');
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.learn_mail_relay_host(text, text, text, text)', 'EXECUTE'),
  'a browser session cannot teach the relay a host');
SELECT ok(
  NOT has_function_privilege('anon', 'public.growth_mail_relay_hosts(integer)', 'EXECUTE'),
  'nor read the board rows');

-- ------------------------------------------------------------
-- 2. The learning gate
-- ------------------------------------------------------------
SELECT is(
  public.learn_mail_relay_host('imap.busy-test.invalid', 'imap', 'one network blip', 'edge'),
  false,
  'a host with 30 direct successes and 2 failures this week is NOT learned');
SELECT is(
  (SELECT count(*)::int FROM public.mail_relay_hosts WHERE host = 'imap.busy-test.invalid'),
  0,
  'and nothing was written for it');

SELECT is(
  public.learn_mail_relay_host('SMTP.Telstra-Test.invalid', 'smtp', 'SMTP connect timeout', 'web'),
  true,
  'a host with no direct successes is learned');
SELECT is(
  (SELECT host || ' ' || protocol || ' ' || source || ' ' || learned_by FROM public.mail_relay_hosts),
  'smtp.telstra-test.invalid smtp auto web',
  'lower-cased, per protocol, auto, with who learned it');

SELECT is(
  public.learn_mail_relay_host('imap.blocked-test.invalid', 'imap', 'NO [ALERT] Authentication failed.', 'edge'),
  true,
  'a host whose inboxes never got through is learned');

-- A known host is refreshed without the gate: its successes went through the relay.
INSERT INTO public.activity_log (workspace_id, inbox_id, tool_name, status)
SELECT 'ef000000-0000-0000-0000-00000000000f', 'e0000000-0000-0000-0000-0000000000f2', 'email_read', 'success'
FROM generate_series(1, 40);
UPDATE public.mail_relay_hosts SET last_learned_at = now() - interval '40 days' WHERE host = 'imap.blocked-test.invalid';
SELECT is(
  public.learn_mail_relay_host('imap.blocked-test.invalid', 'imap', 'still refused', 'edge'),
  true,
  'an expired host is re-learned despite its relayed successes');
SELECT ok(
  (SELECT times_learned = 2 AND last_learned_at > now() - interval '1 minute'
     FROM public.mail_relay_hosts WHERE host = 'imap.blocked-test.invalid'),
  're-learning bumps the count and the clock');

-- ------------------------------------------------------------
-- 3. Counters and readers
-- ------------------------------------------------------------
SELECT public.record_mail_relay_use('edge', 'smtp', 'smtp.telstra-test.invalid', 'learned', 'ok', 120, NULL);
SELECT public.record_mail_relay_use('edge', 'smtp', 'smtp.telstra-test.invalid', 'learned', 'ok', 80, NULL);
SELECT public.record_mail_relay_use('web', 'smtp', 'smtp.telstra-test.invalid', 'fallback', 'relay_down', 5000, 'Relay connection failed: ECONNREFUSED');

SELECT is(
  (SELECT count::int || ' ' || total_ms FROM public.mail_relay_stats
    WHERE runtime = 'edge' AND outcome = 'ok'),
  '2 200',
  'one row per hour and key, counted and timed');

SELECT is(
  (SELECT connections::int || ' ' || ok || ' ' || relay_down || ' ' || routes || ' ' || learned || ' ' || last_failure
     FROM public.growth_mail_relay_hosts(7) WHERE host = 'smtp.telstra-test.invalid'),
  '3 2 1 fallback,learned true Relay connection failed: ECONNREFUSED',
  'the host row adds up, with the last failure');

SELECT is(
  (SELECT count(*)::int FROM public.growth_mail_relay_hosts(7) WHERE host = 'imap.blocked-test.invalid' AND connections = 0),
  1,
  'a learned host with no traffic yet is still listed');

SELECT is(
  (SELECT count(*)::int || ' ' || sum(ok) || ' ' || sum(relay_down) FROM public.growth_mail_relay_daily(7)),
  '7 2 1',
  'the daily series is zero-filled and adds up');

SELECT * FROM finish();
ROLLBACK;
