-- ============================================================
-- Subscription cleanup (mcp-server subscriptions_scan / subscriptions_cleanup)
-- ============================================================
-- Covers migrations 20261024210000_subscription_cleanup and
-- 20261024210100_schedule_subscription_followup:
--   - the rollout flag exists and defaults to false
--   - the ledger's idempotency key is unique (the replay guard)
--   - status / method constraints
--   - the stale-claim and follow-up retry columns
--   - RLS: members read their own workspace's rows, never another's, and
--     never the plan ciphertext; no browser writes; anon sees nothing
--   - the dispatcher function exists and is service-role only
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(21);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('f1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'unsub-alice@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('f1000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'unsub-bob@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES
  ('fa000000-0000-0000-0000-00000000000a', 'unsub-a', 'Unsub A', 'f1000000-0000-0000-0000-000000000001', 'solo'),
  ('fb000000-0000-0000-0000-00000000000b', 'unsub-b', 'Unsub B', 'f1000000-0000-0000-0000-000000000002', 'solo');

INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES
  ('fa000000-0000-0000-0000-00000000000a', 'f1000000-0000-0000-0000-000000000001', 'owner'),
  ('fb000000-0000-0000-0000-00000000000b', 'f1000000-0000-0000-0000-000000000002', 'owner');

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host)
VALUES
  ('f0000000-0000-0000-0000-0000000000a1', 'fa000000-0000-0000-0000-00000000000a', 'imap', 'a1@unsub-test.invalid', 'active', 'imap.unsub-test.invalid'),
  ('f0000000-0000-0000-0000-0000000000b1', 'fb000000-0000-0000-0000-00000000000b', 'imap', 'b1@unsub-test.invalid', 'active', 'imap.unsub-test.invalid');

INSERT INTO public.subscription_plans (id, workspace_id, inbox_id, senders, sender_count, window_days, expires_at)
VALUES
  ('f5000000-0000-0000-0000-00000000000a', 'fa000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1',
   '{"v":1,"data":"ciphertext"}', 1, 90, now() + interval '15 minutes'),
  ('f5000000-0000-0000-0000-00000000000b', 'fb000000-0000-0000-0000-00000000000b', 'f0000000-0000-0000-0000-0000000000b1',
   '{"v":1,"data":"ciphertext"}', 1, 90, now() + interval '15 minutes');

INSERT INTO public.unsubscribe_requests (workspace_id, inbox_id, plan_id, sender_key, method, status, idempotency_key, url_host)
VALUES
  ('fa000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1', 'f5000000-0000-0000-0000-00000000000a',
   'list:news.example.com', 'one_click', 'requested', 'key-a', 'unsub.example.com'),
  ('fb000000-0000-0000-0000-00000000000b', 'f0000000-0000-0000-0000-0000000000b1', 'f5000000-0000-0000-0000-00000000000b',
   'list:news.example.com', 'one_click', 'requested', 'key-b', 'unsub.example.com');

-- ------------------------------------------------------------
-- 1. Schema
-- ------------------------------------------------------------
SELECT has_column('public', 'workspaces', 'subscription_cleanup_enabled', 'the rollout flag exists');
SELECT is(
  (SELECT subscription_cleanup_enabled FROM public.workspaces WHERE id = 'fa000000-0000-0000-0000-00000000000a'),
  false,
  'the flag defaults to false');

SELECT throws_ok(
  $$INSERT INTO public.unsubscribe_requests (workspace_id, inbox_id, sender_key, method, status, idempotency_key)
    VALUES ('fa000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1',
            'list:news.example.com', 'one_click', 'requested', 'key-a')$$,
  '23505', NULL,
  'one ledger row per idempotency key');
SELECT throws_ok(
  $$INSERT INTO public.unsubscribe_requests (workspace_id, inbox_id, sender_key, method, status, idempotency_key)
    VALUES ('fa000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1',
            'from:x@example.com', 'one_click', 'sent', 'key-c')$$,
  '23514', NULL,
  'status is one of the ladder outcomes');
SELECT throws_ok(
  $$INSERT INTO public.unsubscribe_requests (workspace_id, inbox_id, sender_key, method, status, idempotency_key)
    VALUES ('fa000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1',
            'from:x@example.com', 'get', 'requested', 'key-d')$$,
  '23514', NULL,
  'method is one of the four rungs');
SELECT has_column('public', 'unsubscribe_requests', 'claimed_at',
  'a pending row records when it was claimed (stale claims are retaken)');
SELECT has_column('public', 'unsubscribe_requests', 'check_attempts',
  'the follow-up counts its failed attempts');
SELECT throws_ok(
  $$INSERT INTO public.unsubscribe_requests (workspace_id, inbox_id, sender_key, method, status, idempotency_key, check_attempts)
    VALUES ('fa000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1',
            'from:x@example.com', 'one_click', 'requested', 'key-f', -1)$$,
  '23514', NULL,
  'check_attempts is never negative');
SELECT is(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'unsubscribe_requests'
      AND column_name ~ '^(url|link|unsubscribe_url|body|subject)$'),
  0::bigint,
  'the ledger has no column for a URL or message content');

-- RLS is on for both tables.
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.subscription_plans'::regclass),
  'subscription_plans has RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.unsubscribe_requests'::regclass),
  'unsubscribe_requests has RLS enabled');

-- ------------------------------------------------------------
-- 2. Members read their own workspace's rows only
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"f1000000-0000-0000-0000-000000000001","role":"authenticated"}';

SELECT is(
  (SELECT count(*) FROM public.unsubscribe_requests),
  1::bigint,
  'a member sees their own workspace''s ledger rows only');
SELECT is(
  (SELECT count(*) FROM public.subscription_plans),
  1::bigint,
  'a member sees their own workspace''s plans only');
SELECT is(
  (SELECT sender_count FROM public.subscription_plans WHERE id = 'f5000000-0000-0000-0000-00000000000a'),
  1,
  'a member reads a plan''s bookkeeping columns');
SELECT throws_ok(
  $$SELECT senders FROM public.subscription_plans$$,
  '42501', NULL,
  'a member never reads the plan ciphertext');
SELECT throws_ok(
  $$SELECT progress FROM public.subscription_plans$$,
  '42501', NULL,
  'or the progress ciphertext');
SELECT throws_ok(
  $$INSERT INTO public.unsubscribe_requests (workspace_id, inbox_id, sender_key, method, status, idempotency_key)
    VALUES ('fa000000-0000-0000-0000-00000000000a', 'f0000000-0000-0000-0000-0000000000a1',
            'from:x@example.com', 'none', 'skipped_unsafe', 'key-e')$$,
  '42501', NULL,
  'a member cannot write the ledger');
SELECT throws_ok(
  $$UPDATE public.subscription_plans SET used_at = now()$$,
  '42501', NULL,
  'or claim a plan');

RESET ROLE;

SET LOCAL ROLE anon;
SELECT throws_ok(
  $$SELECT count(*) FROM public.unsubscribe_requests$$,
  '42501', NULL,
  'anon reads nothing');
RESET ROLE;

-- ------------------------------------------------------------
-- 3. The dispatcher
-- ------------------------------------------------------------
SELECT has_function('public', 'dispatch_subscription_followup', ARRAY[]::text[],
  'the follow-up dispatcher exists');
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.dispatch_subscription_followup()', 'EXECUTE'),
  'a browser session cannot trigger the dispatcher');

SELECT * FROM finish();
ROLLBACK;
