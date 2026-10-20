-- ============================================================
-- Mail relay registry
-- ============================================================
-- Covers migration 20261015180000_mail_relay_registry:
--   - service-role only: a browser session can neither read nor call it
--   - learn_mail_relay_host (as replaced by 20261015200000): never learns a
--     host with 5+ direct successes in 7 days, however many failures it has;
--     learns only at a second rescue 5+ minutes after the first; re-learning
--     after expiry ignores the calls made through the relay
--   - record_mail_relay_use: one counter row per hour and key, incremented
--   - the two /admin/growth readers
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(25);

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
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.mail_relay_candidates'::regclass), 'mail_relay_candidates has RLS');
SELECT ok(NOT has_table_privilege('authenticated', 'public.mail_relay_hosts', 'SELECT'), 'a browser session cannot read learned hosts');
SELECT ok(NOT has_table_privilege('anon', 'public.mail_relay_stats', 'SELECT'), 'nor the relay counters');
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.learn_mail_relay_host(text, text, text, text)', 'EXECUTE'),
  'a browser session cannot teach the relay a host');
SELECT ok(
  NOT has_function_privilege('anon', 'public.growth_mail_relay_hosts(integer)', 'EXECUTE'),
  'nor read the board rows');

-- ------------------------------------------------------------
-- 2. The learning rule (20261015200000_mail_relay_learning_gate)
-- ------------------------------------------------------------
-- Rule 1: 5+ direct successes in 7 days is never learned, whatever the
-- failures. The busy host has 30 successes and 2 failures; the IONOS case
-- (82 successes, 172 failures from wrong passwords) is the same verdict.
SELECT is(
  public.learn_mail_relay_host('imap.busy-test.invalid', 'imap', 'unexpected end of file', 'edge'),
  false,
  'a host that works directly is NOT learned');
SELECT ok(
  (SELECT refused AND direct_successes = 30 FROM public.mail_relay_candidates WHERE host = 'imap.busy-test.invalid'),
  'it is recorded as refused, with the successes that refused it');
INSERT INTO public.activity_log (workspace_id, inbox_id, tool_name, status, error_code)
SELECT 'ef000000-0000-0000-0000-00000000000f', 'e0000000-0000-0000-0000-0000000000f1', 'email_read', 'error', 'auth_failed'
FROM generate_series(1, 200);
SELECT is(
  public.learn_mail_relay_host('imap.busy-test.invalid', 'imap', 'unexpected end of file', 'edge'),
  false,
  'failures never outweigh successes: 200 wrong-password failures change nothing');

-- Rule 2: two rescues, 5+ minutes apart.
SELECT is(
  public.learn_mail_relay_host('SMTP.Telstra-Test.invalid', 'smtp', 'SMTP connect timeout', 'web'),
  false,
  'one rescue makes a candidate, not a learned host');
SELECT is(
  public.learn_mail_relay_host('smtp.telstra-test.invalid', 'smtp', 'SMTP connect timeout', 'edge'),
  false,
  'a second rescue moments later is the same moment, not more evidence');
UPDATE public.mail_relay_candidates SET first_rescue_at = now() - interval '6 minutes'
 WHERE host = 'smtp.telstra-test.invalid';
SELECT is(
  public.learn_mail_relay_host('smtp.telstra-test.invalid', 'smtp', 'SMTP connect timeout', 'edge'),
  true,
  'a rescue 5+ minutes after the first learns the host');
SELECT is(
  (SELECT host || ' ' || protocol || ' ' || source || ' ' || learned_by FROM public.mail_relay_hosts),
  'smtp.telstra-test.invalid smtp auto edge',
  'lower-cased, per protocol, auto, with who learned it');
SELECT is(
  (SELECT count(*)::int FROM public.mail_relay_candidates WHERE host = 'smtp.telstra-test.invalid'),
  0,
  'and the candidate row is gone');

-- Re-learning after expiry counts only successes since it expired: the calls
-- made through the relay meanwhile are not direct successes.
INSERT INTO public.mail_relay_hosts (host, protocol, source, learned_by, first_learned_at, last_learned_at)
VALUES ('imap.blocked-test.invalid', 'imap', 'auto', 'edge', now() - interval '40 days', now() - interval '31 days');
INSERT INTO public.activity_log (workspace_id, inbox_id, tool_name, status, created_at)
SELECT 'ef000000-0000-0000-0000-00000000000f', 'e0000000-0000-0000-0000-0000000000f2', 'email_read', 'success', now() - interval '2 days'
FROM generate_series(1, 40);
SELECT is(
  public.learn_mail_relay_host('imap.blocked-test.invalid', 'imap', 'NO [ALERT] Authentication failed.', 'edge'),
  false,
  'an expired host starts again as a candidate');
SELECT ok(
  (SELECT NOT refused AND direct_successes = 0 FROM public.mail_relay_candidates WHERE host = 'imap.blocked-test.invalid'),
  'its relayed successes before expiry are not held against it');

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

-- ------------------------------------------------------------
-- 4. Rescued calls are not direct successes (20261016100000)
-- ------------------------------------------------------------
-- A host that refuses our address, used by one active person: every one of
-- its 12 successful reads went through the relay fallback, and 10 signature
-- reads never opened IMAP at all. None of that says the host works directly.
INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host, smtp_host)
VALUES ('e0000000-0000-0000-0000-0000000000f3', 'ef000000-0000-0000-0000-00000000000f', 'imap',
        'rescued@relay-test.invalid', 'active', 'imap.rescued-test.invalid', NULL);
INSERT INTO public.activity_log (workspace_id, inbox_id, tool_name, status)
SELECT 'ef000000-0000-0000-0000-00000000000f', 'e0000000-0000-0000-0000-0000000000f3', 'email_read', 'success'
FROM generate_series(1, 12);
INSERT INTO public.activity_log (workspace_id, inbox_id, tool_name, status)
SELECT 'ef000000-0000-0000-0000-00000000000f', 'e0000000-0000-0000-0000-0000000000f3', 'signature_get', 'success'
FROM generate_series(1, 10);
INSERT INTO public.mail_relay_stats (hour, runtime, protocol, host, route, outcome, count, total_ms, last_at)
VALUES (date_trunc('hour', now()), 'edge', 'imap', 'imap.rescued-test.invalid', 'fallback', 'ok', 12, 12000, now());

SELECT is(
  public.learn_mail_relay_host('imap.rescued-test.invalid', 'imap', 'Connection timed out (os error 110)', 'edge'),
  false,
  'a first rescue still only makes a candidate');
SELECT ok(
  (SELECT NOT refused AND direct_successes = 0 FROM public.mail_relay_candidates WHERE host = 'imap.rescued-test.invalid'),
  'relayed successes and non-IMAP tools are not counted as direct successes');
UPDATE public.mail_relay_candidates SET first_rescue_at = now() - interval '6 minutes'
 WHERE host = 'imap.rescued-test.invalid';
SELECT is(
  public.learn_mail_relay_host('imap.rescued-test.invalid', 'imap', 'Connection timed out (os error 110)', 'edge'),
  true,
  'so the second rescue learns it');

-- A refused host keeps counting its rescues (the busy host was rescued twice above).
SELECT is(
  (SELECT rescues FROM public.mail_relay_candidates WHERE host = 'imap.busy-test.invalid'),
  2,
  'a refused candidate counts every rescue');

SELECT * FROM finish();
ROLLBACK;
