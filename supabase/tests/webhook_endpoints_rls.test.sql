-- ============================================================
-- Webhooks: RLS, grants, the watch set, enqueue, lease and attempts
-- ============================================================
-- Covers migration 20261024180000_webhook_endpoints:
--   - a member reads their workspace's endpoints and deliveries, never the
--     secret column or the pending message ids, and cannot write at all;
--   - an admin cannot write directly either (writes go through the routes);
--   - another workspace reads nothing;
--   - the dispatcher functions are not callable from a browser session;
--   - an enabled endpoint on Pro/Business watches its inboxes, a paused
--     (Free) or disabled one does not;
--   - enqueue / lease / record_webhook_attempt / auto-disable.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(24);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('e1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'hook-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('e2000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'hook-member@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('e3000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'hook-outsider@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('e4000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'hook-admin@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

-- A is Pro (solo), web client OFF: webhooks alone must watch its inbox.
-- F is Free: its endpoint is paused.
INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan, web_client_enabled)
VALUES
  ('ea000000-0000-0000-0000-00000000000a', 'hook-a', 'Hook A', 'e1000000-0000-0000-0000-000000000001', 'solo', false),
  ('ef000000-0000-0000-0000-00000000000f', 'hook-f', 'Hook F', 'e3000000-0000-0000-0000-000000000003', 'free', false);

INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES
  ('ea000000-0000-0000-0000-00000000000a', 'e1000000-0000-0000-0000-000000000001', 'owner'),
  ('ea000000-0000-0000-0000-00000000000a', 'e2000000-0000-0000-0000-000000000002', 'member'),
  ('ea000000-0000-0000-0000-00000000000a', 'e4000000-0000-0000-0000-000000000004', 'admin'),
  ('ef000000-0000-0000-0000-00000000000f', 'e3000000-0000-0000-0000-000000000003', 'owner');

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host, deleted_at)
VALUES
  ('e0000000-0000-0000-0000-0000000000a1', 'ea000000-0000-0000-0000-00000000000a', 'imap', 'a1@hook-test.invalid', 'active', 'imap.hook-test.invalid', NULL),
  ('e0000000-0000-0000-0000-0000000000a2', 'ea000000-0000-0000-0000-00000000000a', 'imap', 'a2@hook-test.invalid', 'active', 'imap.hook-test.invalid', NULL),
  ('e0000000-0000-0000-0000-0000000000f1', 'ef000000-0000-0000-0000-00000000000f', 'imap', 'f1@hook-test.invalid', 'active', 'imap.hook-test.invalid', NULL);

INSERT INTO public.webhook_endpoints (id, workspace_id, url, secret_ciphertext, secret_prefix, inbox_ids, created_by)
VALUES
  ('e5000000-0000-0000-0000-0000000000a1', 'ea000000-0000-0000-0000-00000000000a', 'https://hooks.hook-test.invalid/a',
   repeat('c', 60), 'whsec_aaaaaa', ARRAY['e0000000-0000-0000-0000-0000000000a1']::uuid[], 'e1000000-0000-0000-0000-000000000001'),
  ('e5000000-0000-0000-0000-0000000000f1', 'ef000000-0000-0000-0000-00000000000f', 'https://hooks.hook-test.invalid/f',
   repeat('c', 60), 'whsec_ffffff', NULL, 'e3000000-0000-0000-0000-000000000003');

CREATE TEMP VIEW hook_test_watch AS
  SELECT s.inbox_id FROM public.inbox_watch_state s WHERE s.inbox_id::text LIKE 'e0000000-%';

-- ------------------------------------------------------------
-- 1. The watch set and the plan gate
-- ------------------------------------------------------------
SELECT public.sync_inbox_watch_state();
SELECT is(
  (SELECT array_agg(inbox_id::text) FROM hook_test_watch),
  ARRAY['e0000000-0000-0000-0000-0000000000a1'],
  'an enabled Pro endpoint watches the inbox it covers, without the web client; the Free one is paused');
SELECT ok(public.webhooks_plan_allowed('ea000000-0000-0000-0000-00000000000a'), 'Pro may deliver');
SELECT ok(NOT public.webhooks_plan_allowed('ef000000-0000-0000-0000-00000000000f'), 'Free may not');
SELECT ok(public.webhook_has_targets('e0000000-0000-0000-0000-0000000000a1'), 'the covered inbox has a target');
SELECT ok(NOT public.webhook_has_targets('e0000000-0000-0000-0000-0000000000a2'), 'the inbox outside the filter has none');
SELECT ok(NOT public.webhook_has_targets('e0000000-0000-0000-0000-0000000000f1'), 'a paused workspace has none');

UPDATE public.webhook_endpoints SET disabled_at = now(), disabled_reason = 'manual'
 WHERE id = 'e5000000-0000-0000-0000-0000000000a1';
SELECT public.sync_inbox_watch_state();
SELECT is((SELECT count(*) FROM hook_test_watch), 0::bigint, 'a disabled endpoint watches nothing');
UPDATE public.webhook_endpoints SET disabled_at = NULL, disabled_reason = NULL
 WHERE id = 'e5000000-0000-0000-0000-0000000000a1';

-- ------------------------------------------------------------
-- 2. Enqueue, lease, attempts, auto-disable
-- ------------------------------------------------------------
CREATE TEMP TABLE hook_test_enq AS
  SELECT * FROM public.webhook_enqueue_event('e0000000-0000-0000-0000-0000000000a1',
    'evt_00000000000000000000000000000001', ARRAY['INBOX:7'], 1, 120);
SELECT is((SELECT count(*) FROM hook_test_enq), 1::bigint, 'one delivery per matching endpoint');
SELECT is(
  (SELECT count(*) FROM public.webhook_enqueue_event('e0000000-0000-0000-0000-0000000000a1',
    'evt_00000000000000000000000000000001', ARRAY['INBOX:7'], 1, 120)),
  0::bigint, 'the same event id is not enqueued twice');
SELECT is(
  (SELECT count(*) FROM public.webhook_enqueue_event('e0000000-0000-0000-0000-0000000000f1',
    'evt_00000000000000000000000000000002', ARRAY['INBOX:1'], 1, 120)),
  0::bigint, 'a paused workspace enqueues nothing');
SELECT is(
  (SELECT count(*) FROM public.lease_webhook_deliveries(20, 120) WHERE endpoint_id::text LIKE 'e5000000-%'),
  0::bigint, 'a delivery leased for its first attempt is not due to anybody else');

SELECT is(
  (SELECT endpoint_disabled FROM public.record_webhook_attempt(
     (SELECT delivery_id FROM hook_test_enq), (SELECT lease_id FROM hook_test_enq),
     false, 503, 'http_status', now() - interval '1 second', 50, 86400)),
  false, 'a first failure does not disable');
SELECT ok(
  (SELECT status = 'pending' AND attempt = 1 AND message_ids = ARRAY['INBOX:7'] AND response_code = 503
     FROM public.webhook_deliveries WHERE id = (SELECT delivery_id FROM hook_test_enq)),
  'the failed delivery stays pending, keeps its ids, records the code');

CREATE TEMP TABLE hook_test_lease AS
  SELECT * FROM public.lease_webhook_deliveries(20, 120) WHERE endpoint_id::text LIKE 'e5000000-%';
SELECT ok(
  (SELECT count(*) = 1 AND bool_and(endpoint_enabled AND plan_allowed AND message_ids = ARRAY['INBOX:7']) FROM hook_test_lease),
  'a due retry is leased with what it needs');

UPDATE public.webhook_endpoints SET consecutive_failures = 49 WHERE id = 'e5000000-0000-0000-0000-0000000000a1';
SELECT is(
  (SELECT endpoint_disabled FROM public.record_webhook_attempt(
     (SELECT delivery_id FROM hook_test_lease), (SELECT lease_id FROM hook_test_lease),
     false, NULL, 'timeout', now() + interval '5 minutes', 50, 86400)),
  true, 'the 50th failure in a row disables the endpoint');
SELECT ok(
  (SELECT disabled_reason = 'failing' AND disabled_at IS NOT NULL FROM public.webhook_endpoints
    WHERE id = 'e5000000-0000-0000-0000-0000000000a1'),
  'disabled for failing');
SELECT ok(
  (SELECT status = 'abandoned' AND message_ids IS NULL FROM public.webhook_deliveries
    WHERE id = (SELECT delivery_id FROM hook_test_enq)),
  'its pending delivery is abandoned and its ids cleared');

-- ------------------------------------------------------------
-- 3. RLS and grants, as the member
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"e2000000-0000-0000-0000-000000000002","role":"authenticated"}';

SELECT is(
  (SELECT array_agg(id::text) FROM public.webhook_endpoints),
  ARRAY['e5000000-0000-0000-0000-0000000000a1'],
  'a member sees their workspace''s endpoint and not another workspace''s');
SELECT throws_ok(
  $$SELECT secret_ciphertext FROM public.webhook_endpoints$$,
  '42501', NULL, 'the secret column is not readable from a browser session');
SELECT throws_ok(
  $$SELECT message_ids FROM public.webhook_deliveries$$,
  '42501', NULL, 'nor are the pending message ids');
SELECT throws_ok(
  $$UPDATE public.webhook_endpoints SET url = 'https://attacker.example/x'$$,
  '42501', NULL, 'a member cannot write an endpoint');
SELECT throws_ok(
  $$SELECT * FROM public.lease_webhook_deliveries(20, 120)$$,
  '42501', NULL, 'the dispatcher functions are not callable');

SET LOCAL "request.jwt.claims" TO '{"sub":"e4000000-0000-0000-0000-000000000004","role":"authenticated"}';
SELECT throws_ok(
  $$INSERT INTO public.webhook_endpoints (workspace_id, url, secret_ciphertext, secret_prefix)
    VALUES ('ea000000-0000-0000-0000-00000000000a', 'https://x.example/', repeat('c', 60), 'whsec_xxxxxx')$$,
  '42501', NULL, 'an admin writes through the routes, not directly');

SET LOCAL "request.jwt.claims" TO '{"sub":"e3000000-0000-0000-0000-000000000003","role":"authenticated"}';
SELECT is(
  (SELECT count(*) FROM public.webhook_deliveries WHERE workspace_id = 'ea000000-0000-0000-0000-00000000000a'),
  0::bigint, 'another workspace reads none of these deliveries');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
