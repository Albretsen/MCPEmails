-- ============================================================
-- Web push: subscriptions, preferences, the watch set and its lease
-- ============================================================
-- Covers migrations 20261005100000 .. 20261005100200:
--   - which mailboxes are watched (sync_inbox_watch_state): only live, active
--     inboxes of a web-client-enabled workspace with an active subscription
--     of a current member who has not switched the mailbox off
--   - lease_inbox_watches: bounded, exclusive, honours next_check_at, backoff
--     and a live lease; an expired lease is claimable again
--   - push_recipients: defaults, per-person settings, and who is left out
--   - record_push_results: sent / gone / failed, disable after 10 failures
--   - RLS: a person sees and deletes only their own subscriptions, writes
--     nothing directly, and never sees watch state; the functions are not
--     callable from a browser session
--   - the column constraints that keep content out
--   - dispatch_inbox_watch(): no HTTP request when nothing is due, no error
--     without the Vault secret, one request per 20 due and at most 4
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(51);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('d1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'push-alice@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('d2000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'push-bob@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('d3000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'push-carol@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

-- Workspace A has the web client on (Alice owns it, Bob is a member).
-- Workspace C has it off (Carol).
INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan, web_client_enabled)
VALUES
  ('da000000-0000-0000-0000-00000000000a', 'push-a', 'Push A', 'd1000000-0000-0000-0000-000000000001', 'solo', true),
  ('dc000000-0000-0000-0000-00000000000c', 'push-c', 'Push C', 'd3000000-0000-0000-0000-000000000003', 'solo', false);

INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES
  ('da000000-0000-0000-0000-00000000000a', 'd1000000-0000-0000-0000-000000000001', 'owner'),
  ('da000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-000000000002', 'member'),
  ('dc000000-0000-0000-0000-00000000000c', 'd3000000-0000-0000-0000-000000000003', 'owner');

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host, deleted_at)
VALUES
  ('d0000000-0000-0000-0000-0000000000a1', 'da000000-0000-0000-0000-00000000000a', 'imap',  'a1@push-test.invalid', 'active', 'imap.push-test.invalid', NULL),
  ('d0000000-0000-0000-0000-0000000000a2', 'da000000-0000-0000-0000-00000000000a', 'gmail', 'a2@push-test.invalid', 'active', NULL, NULL),
  ('d0000000-0000-0000-0000-0000000000a3', 'da000000-0000-0000-0000-00000000000a', 'imap',  'a3@push-test.invalid', 'error',  'imap.push-test.invalid', NULL),
  ('d0000000-0000-0000-0000-0000000000a4', 'da000000-0000-0000-0000-00000000000a', 'imap',  'a4@push-test.invalid', 'active', 'imap.push-test.invalid', now()),
  ('d0000000-0000-0000-0000-0000000000c1', 'dc000000-0000-0000-0000-00000000000c', 'imap',  'c1@push-test.invalid', 'active', 'imap.push-test.invalid', NULL);

-- Only this test's rows are counted below.
CREATE TEMP VIEW push_test_watch AS
  SELECT s.* FROM public.inbox_watch_state s WHERE s.inbox_id::text LIKE 'd0000000-%';
GRANT SELECT ON push_test_watch TO authenticated;

-- ------------------------------------------------------------
-- 1. The watch set
-- ------------------------------------------------------------
SELECT public.sync_inbox_watch_state();
SELECT is((SELECT count(*) FROM push_test_watch), 0::bigint,
  'nobody has subscribed: no mailbox is watched');

INSERT INTO public.push_subscriptions (id, user_id, workspace_id, endpoint, p256dh, auth)
VALUES
  ('d5000000-0000-0000-0000-0000000000a1', 'd1000000-0000-0000-0000-000000000001', 'da000000-0000-0000-0000-00000000000a',
   'https://fcm.googleapis.com/fcm/send/push-test-alice', repeat('A', 87), repeat('a', 22)),
  ('d5000000-0000-0000-0000-0000000000c1', 'd3000000-0000-0000-0000-000000000003', 'dc000000-0000-0000-0000-00000000000c',
   'https://fcm.googleapis.com/fcm/send/push-test-carol', repeat('C', 87), repeat('c', 22));

SELECT public.sync_inbox_watch_state();
SELECT is(
  (SELECT array_agg(inbox_id::text ORDER BY inbox_id) FROM push_test_watch),
  ARRAY['d0000000-0000-0000-0000-0000000000a1', 'd0000000-0000-0000-0000-0000000000a2'],
  'watched: the active, undeleted inboxes of the enabled workspace; not the errored one, the deleted one, or the workspace with the web client off');
SELECT is(
  (SELECT count(*) FROM push_test_watch WHERE folders = '{}'::jsonb AND last_checked_at IS NULL),
  2::bigint,
  'a newly watched mailbox starts with an empty cursor');

SELECT public.sync_inbox_watch_state();
SELECT is((SELECT count(*) FROM push_test_watch), 2::bigint, 'sync is idempotent');

-- ------------------------------------------------------------
-- 2. The lease
-- ------------------------------------------------------------
CREATE TEMP TABLE push_test_lease AS
  SELECT * FROM public.lease_inbox_watches(1, 120) WHERE inbox_id::text LIKE 'd0000000-%';
SELECT is((SELECT count(*) FROM push_test_lease), 1::bigint, 'p_limit bounds the batch');
SELECT ok(
  (SELECT l.lease_id IS NOT NULL AND l.workspace_id = 'da000000-0000-0000-0000-00000000000a' AND l.failure_count = 0
     FROM push_test_lease l),
  'a leased row carries its lease id, workspace and failure count');
SELECT ok(
  (SELECT s.lease_id = l.lease_id AND s.leased_until > now() + interval '100 seconds'
     FROM push_test_lease l JOIN public.inbox_watch_state s USING (inbox_id)),
  'the row records the same lease id and an expiry');

CREATE TEMP TABLE push_test_lease2 AS
  SELECT * FROM public.lease_inbox_watches(20, 120) WHERE inbox_id::text LIKE 'd0000000-%';
SELECT is((SELECT count(*) FROM push_test_lease2), 1::bigint,
  'a second dispatcher gets only the mailbox the first did not take');
SELECT is(
  (SELECT count(*) FROM push_test_lease l JOIN push_test_lease2 m USING (inbox_id)),
  0::bigint,
  'no mailbox is leased to two dispatchers');
SELECT is(
  (SELECT count(*) FROM public.lease_inbox_watches(20, 120) WHERE inbox_id::text LIKE 'd0000000-%'),
  0::bigint,
  'while both are leased, nothing is due');

SELECT is(
  (SELECT provider || ':' || coalesce(mail_host, '-') FROM push_test_lease2
    UNION ALL SELECT provider || ':' || coalesce(mail_host, '-') FROM push_test_lease ORDER BY 1 LIMIT 1),
  'gmail:-',
  'the lease reports the provider (and the mail host for IMAP only)');

-- An expired lease (the isolate died) is claimable again.
UPDATE public.inbox_watch_state SET leased_until = now() - interval '1 second'
 WHERE inbox_id = 'd0000000-0000-0000-0000-0000000000a1';
SELECT is(
  (SELECT array_agg(inbox_id::text) FROM public.lease_inbox_watches(20, 120) WHERE inbox_id::text LIKE 'd0000000-%'),
  ARRAY['d0000000-0000-0000-0000-0000000000a1'],
  'an expired lease is claimable again, and gets a NEW lease id');
SELECT isnt(
  (SELECT lease_id FROM public.inbox_watch_state WHERE inbox_id = 'd0000000-0000-0000-0000-0000000000a1'),
  (SELECT lease_id FROM push_test_lease WHERE inbox_id = 'd0000000-0000-0000-0000-0000000000a1'
    UNION ALL SELECT lease_id FROM push_test_lease2 WHERE inbox_id = 'd0000000-0000-0000-0000-0000000000a1' LIMIT 1),
  'so the dead dispatcher''s late write (matched on lease id) can no longer land');

-- Released, but not due yet / backing off.
UPDATE public.inbox_watch_state
   SET lease_id = NULL, leased_until = NULL, next_check_at = now() + interval '50 seconds'
 WHERE inbox_id = 'd0000000-0000-0000-0000-0000000000a1';
UPDATE public.inbox_watch_state
   SET lease_id = NULL, leased_until = NULL, next_check_at = now() - interval '1 minute',
       backoff_until = now() + interval '10 minutes', failure_count = 3
 WHERE inbox_id = 'd0000000-0000-0000-0000-0000000000a2';
SELECT is(
  (SELECT count(*) FROM public.lease_inbox_watches(20, 120) WHERE inbox_id::text LIKE 'd0000000-%'),
  0::bigint,
  'a mailbox that is not due yet, or is backing off after failures, is not leased');

UPDATE public.inbox_watch_state SET next_check_at = now() - interval '2 minutes', backoff_until = NULL
 WHERE inbox_id::text LIKE 'd0000000-%';
UPDATE public.inbox_watch_state SET next_check_at = now() - interval '9 minutes'
 WHERE inbox_id = 'd0000000-0000-0000-0000-0000000000a2';
SELECT is(
  (SELECT inbox_id::text FROM public.lease_inbox_watches(1, 120) WHERE inbox_id::text LIKE 'd0000000-%'),
  'd0000000-0000-0000-0000-0000000000a2',
  'the longest-overdue mailbox goes first');
UPDATE public.inbox_watch_state SET lease_id = NULL, leased_until = NULL WHERE inbox_id::text LIKE 'd0000000-%';

-- ------------------------------------------------------------
-- 3. Who is told
-- ------------------------------------------------------------
SELECT is(
  (SELECT array_agg(subscription_id::text || ':' || payload_mode || ':' || coalesce(quiet_timezone, '-'))
     FROM public.push_recipients('d0000000-0000-0000-0000-0000000000a1')),
  ARRAY['d5000000-0000-0000-0000-0000000000a1:rich:-'],
  'recipients: the workspace''s active subscription, with the defaults when there is no preference row');

INSERT INTO public.push_subscriptions (id, user_id, workspace_id, endpoint, p256dh, auth)
VALUES ('d5000000-0000-0000-0000-0000000000b1', 'd2000000-0000-0000-0000-000000000002', 'da000000-0000-0000-0000-00000000000a',
        'https://updates.push.services.mozilla.com/wpush/v2/push-test-bob', repeat('B', 87), repeat('b', 22));
INSERT INTO public.push_preferences (user_id, inbox_id, payload_mode, quiet_start, quiet_end, quiet_timezone)
VALUES ('d2000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-0000000000a1', 'private', 1320, 420, 'Europe/Oslo');
INSERT INTO public.push_preferences (user_id, inbox_id, enabled)
VALUES ('d1000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-0000000000a1', false);

SELECT is(
  (SELECT array_agg(subscription_id::text || ':' || payload_mode || ':' || quiet_start || '-' || quiet_end || ':' || quiet_timezone)
     FROM public.push_recipients('d0000000-0000-0000-0000-0000000000a1')),
  ARRAY['d5000000-0000-0000-0000-0000000000b1:private:1320-420:Europe/Oslo'],
  'recipients: a person who switched the mailbox off is left out; another person''s mode and quiet hours are their own');
SELECT is(
  (SELECT count(*) FROM public.push_recipients('d0000000-0000-0000-0000-0000000000a2')),
  2::bigint,
  'the other mailbox still reaches both people');
SELECT is(
  (SELECT count(*) FROM public.push_recipients('d0000000-0000-0000-0000-0000000000c1')),
  0::bigint,
  'a workspace with the web client off has no recipients, subscription or not');
SELECT is(
  (SELECT count(*) FROM public.push_recipients('d0000000-0000-0000-0000-0000000000a3')),
  0::bigint,
  'a mailbox that needs reconnecting has no recipients');

-- Bob is removed from the workspace: his browser stops being told at once.
DELETE FROM public.workspace_members
 WHERE workspace_id = 'da000000-0000-0000-0000-00000000000a' AND user_id = 'd2000000-0000-0000-0000-000000000002';
SELECT is(
  (SELECT count(*) FROM public.push_recipients('d0000000-0000-0000-0000-0000000000a1')),
  0::bigint,
  'a removed member''s subscription is not a recipient');
SELECT public.sync_inbox_watch_state();
SELECT is(
  (SELECT array_agg(inbox_id::text) FROM push_test_watch),
  ARRAY['d0000000-0000-0000-0000-0000000000a2'],
  'and a mailbox whose only remaining subscriber switched it off stops being watched');

-- ------------------------------------------------------------
-- 4. What the push services answered
-- ------------------------------------------------------------
SELECT public.record_push_results(
  ARRAY['d5000000-0000-0000-0000-0000000000a1']::uuid[],
  ARRAY['d5000000-0000-0000-0000-0000000000b1']::uuid[],
  ARRAY[]::uuid[]);
SELECT ok(
  (SELECT last_success_at IS NOT NULL AND failure_count = 0 AND disabled_at IS NULL
     FROM public.push_subscriptions WHERE id = 'd5000000-0000-0000-0000-0000000000a1'),
  'sent: last_success_at is stamped');
SELECT ok(
  (SELECT disabled_at IS NOT NULL FROM public.push_subscriptions WHERE id = 'd5000000-0000-0000-0000-0000000000b1'),
  'gone (404/410): the subscription is disabled');

SELECT public.record_push_results(NULL, NULL, ARRAY['d5000000-0000-0000-0000-0000000000a1']::uuid[])
  FROM generate_series(1, 9);
SELECT is(
  (SELECT failure_count::text || ':' || (disabled_at IS NULL)::text
     FROM public.push_subscriptions WHERE id = 'd5000000-0000-0000-0000-0000000000a1'),
  '9:true',
  'nine failures in a row are counted and the subscription stays live');
SELECT public.record_push_results(NULL, NULL, ARRAY['d5000000-0000-0000-0000-0000000000a1']::uuid[]);
SELECT ok(
  (SELECT disabled_at IS NOT NULL FROM public.push_subscriptions WHERE id = 'd5000000-0000-0000-0000-0000000000a1'),
  'the tenth disables it');

SELECT public.sync_inbox_watch_state();
SELECT is((SELECT count(*) FROM push_test_watch), 0::bigint,
  'with every subscription disabled the workspace''s mailboxes stop being watched');

-- Back to one live subscription each for the RLS section.
UPDATE public.push_subscriptions SET disabled_at = NULL, failure_count = 0 WHERE id::text LIKE 'd5000000-%';
INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES ('da000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-000000000002', 'member');
SELECT public.sync_inbox_watch_state();

-- ------------------------------------------------------------
-- 5. Constraints that keep the tables to what they are for
-- ------------------------------------------------------------
SELECT throws_ok(
  $$INSERT INTO public.push_subscriptions (user_id, workspace_id, endpoint, p256dh, auth)
    VALUES ('d2000000-0000-0000-0000-000000000002', 'da000000-0000-0000-0000-00000000000a',
            'https://fcm.googleapis.com/fcm/send/push-test-alice', repeat('B', 87), repeat('b', 22))$$,
  '23505', NULL,
  'an endpoint is unique across the table');
SELECT throws_ok(
  $$INSERT INTO public.push_subscriptions (user_id, workspace_id, endpoint, p256dh, auth)
    VALUES ('d2000000-0000-0000-0000-000000000002', 'da000000-0000-0000-0000-00000000000a',
            'http://plain.example/x', repeat('B', 87), repeat('b', 22))$$,
  '23514', NULL,
  'an endpoint must be https');
SELECT throws_ok(
  $$UPDATE public.push_preferences SET payload_mode = 'full_body'
     WHERE user_id = 'd2000000-0000-0000-0000-000000000002'$$,
  '23514', NULL,
  'payload_mode is rich or private');
SELECT throws_ok(
  $$UPDATE public.push_preferences SET quiet_timezone = NULL
     WHERE user_id = 'd2000000-0000-0000-0000-000000000002'$$,
  '23514', NULL,
  'quiet hours are all set or all null');
SELECT throws_ok(
  $$UPDATE public.inbox_watch_state SET folders = jsonb_build_object('inbox', jsonb_build_object('fingerprint', repeat(md5(random()::text), 200)))
     WHERE inbox_id = 'd0000000-0000-0000-0000-0000000000a2'$$,
  '23514', NULL,
  'the cursor column cannot grow into a place to keep content');
SELECT throws_ok(
  $$UPDATE public.inbox_watch_state SET last_error_code = repeat('x', 41)
     WHERE inbox_id = 'd0000000-0000-0000-0000-0000000000a2'$$,
  '23514', NULL,
  'last_error_code is a code, not a message');
SELECT is(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('push_subscriptions', 'push_preferences', 'inbox_watch_state')
      AND column_name ~ '(subject|sender|recipient|body|snippet|preview|message)'),
  0::bigint,
  'no column for a subject, sender, recipient, body, snippet or message id');

-- ------------------------------------------------------------
-- 6. RLS: Alice, through her own session
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"d1000000-0000-0000-0000-000000000001","role":"authenticated"}';

SELECT is(
  (SELECT array_agg(id::text) FROM public.push_subscriptions),
  ARRAY['d5000000-0000-0000-0000-0000000000a1'],
  'a person sees only their own subscription, not a workspace colleague''s');
SELECT is(
  (SELECT count(*) FROM public.push_preferences),
  1::bigint,
  'and only their own preferences');
SELECT throws_ok(
  $$INSERT INTO public.push_subscriptions (user_id, workspace_id, endpoint, p256dh, auth)
    VALUES ('d1000000-0000-0000-0000-000000000001', 'da000000-0000-0000-0000-00000000000a',
            'https://attacker.example/collect', repeat('A', 87), repeat('a', 22))$$,
  '42501', NULL,
  'a browser session cannot insert a subscription (the edge function validates the endpoint)');
SELECT throws_ok(
  $$UPDATE public.push_subscriptions SET endpoint = 'https://attacker.example/collect'
     WHERE id = 'd5000000-0000-0000-0000-0000000000a1'$$,
  '42501', NULL,
  'or re-point one');
SELECT throws_ok(
  $$INSERT INTO public.push_preferences (user_id, inbox_id, enabled)
    VALUES ('d1000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-0000000000a2', false)$$,
  '42501', NULL,
  'or write a preference directly');
SELECT throws_ok(
  $$SELECT count(*) FROM public.inbox_watch_state$$,
  '42501', NULL,
  'watch state is not readable from a browser session');
SELECT throws_ok(
  $$SELECT * FROM public.push_recipients('d0000000-0000-0000-0000-0000000000a2')$$,
  '42501', NULL,
  'push_recipients (other people''s endpoints and keys) is not callable');
SELECT throws_ok(
  $$SELECT * FROM public.lease_inbox_watches(20, 120)$$,
  '42501', NULL,
  'lease_inbox_watches is not callable');
SELECT throws_ok(
  $$SELECT public.record_push_results(NULL, ARRAY['d5000000-0000-0000-0000-0000000000b1']::uuid[], NULL)$$,
  '42501', NULL,
  'record_push_results is not callable');
SELECT throws_ok(
  $$SELECT public.dispatch_inbox_watch()$$,
  '42501', NULL,
  'dispatch_inbox_watch is not callable');

DELETE FROM public.push_subscriptions WHERE id = 'd5000000-0000-0000-0000-0000000000b1';
DELETE FROM public.push_subscriptions WHERE id = 'd5000000-0000-0000-0000-0000000000a1';
RESET ROLE;
SELECT is(
  (SELECT array_agg(id::text ORDER BY id) FROM public.push_subscriptions WHERE id::text LIKE 'd5000000-%'),
  ARRAY['d5000000-0000-0000-0000-0000000000b1', 'd5000000-0000-0000-0000-0000000000c1'],
  'a person can delete their own subscription and nobody else''s');

SET LOCAL ROLE anon;
SELECT throws_ok(
  $$SELECT count(*) FROM public.push_subscriptions$$,
  '42501', NULL,
  'anon cannot read subscriptions');
RESET ROLE;

-- ------------------------------------------------------------
-- 7. The cron entry point
-- ------------------------------------------------------------
SELECT is(
  (SELECT schedule FROM cron.job WHERE jobname = 'dispatch-inbox-watch'),
  '* * * * *',
  'the watcher job runs every minute');

-- Nothing due: no HTTP request is queued at all.
UPDATE public.inbox_watch_state SET next_check_at = now() + interval '1 hour';
CREATE TEMP TABLE push_test_queue AS SELECT count(*) AS n FROM net.http_request_queue;
SELECT public.dispatch_inbox_watch();
SELECT is(
  (SELECT count(*) FROM net.http_request_queue),
  (SELECT n FROM push_test_queue),
  'nothing due: dispatch_inbox_watch() makes no HTTP request');

-- Something due but no Vault secret: a warning and a skip, never an error.
UPDATE public.inbox_watch_state SET next_check_at = now() - interval '1 minute' WHERE inbox_id::text LIKE 'd0000000-%';
DELETE FROM vault.secrets WHERE name = 'dispatch_secret';
SELECT lives_ok(
  $$SELECT public.dispatch_inbox_watch()$$,
  'due mailboxes without the Vault secret: skipped, not raised');
SELECT is(
  (SELECT count(*) FROM net.http_request_queue),
  (SELECT n FROM push_test_queue),
  'and still no HTTP request');

-- With the secret: one request to the client-api dispatch route. (This
-- transaction is rolled back, so pg_net never sends it.)
SELECT vault.create_secret('push-test-dispatch-secret', 'dispatch_secret');
SELECT public.dispatch_inbox_watch();
SELECT is(
  (SELECT count(*) FROM net.http_request_queue
    WHERE url = 'https://swvaxorwumispmjaaszb.supabase.co/functions/v1/client-api/push/dispatch'),
  1::bigint,
  'due mailboxes with the secret: exactly one POST to client-api /push/dispatch for a small backlog');

SELECT * FROM finish();
ROLLBACK;
