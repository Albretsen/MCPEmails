-- ============================================================
-- Personal 3-month pass: storage, RLS, helper, cron entry point, funnel
-- ============================================================
-- Covers migration 20261024170000_personal_pass.sql:
--   - RLS: an owner reads only their own passes and writes none; anon reads
--     nothing
--   - user_active_pass(): the end of the current cover, stacked pass included;
--     nothing for an ended, refunded or not-yet-started pass; not callable
--     from a browser session
--   - the status, product and window constraints
--   - dispatch_pass_expiry(): no HTTP request when nothing is due, a skip
--     without the Vault secret, one request when a pass has ended
--   - product_funnel_events accepts the pass stages and categories
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(22);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('e1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pass-alice@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('e2000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pass-bob@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('e3000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pass-carol@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('ea000000-0000-0000-0000-00000000000a', 'pass-a', 'Pass A', 'e1000000-0000-0000-0000-000000000001', 'personal');

-- Alice: an active pass and a stacked one after it.
-- Bob: a refunded pass and an expired one.
-- Carol: a pass that has not started yet (scheduled, nothing active).
INSERT INTO public.user_passes (id, user_id, stripe_checkout_session_id, starts_at, ends_at, status)
VALUES
  ('e5000000-0000-0000-0000-0000000000a1', 'e1000000-0000-0000-0000-000000000001', 'cs_pass_test_a1',
   now() - interval '10 days', now() + interval '80 days', 'active'),
  ('e5000000-0000-0000-0000-0000000000a2', 'e1000000-0000-0000-0000-000000000001', 'cs_pass_test_a2',
   now() + interval '80 days', now() + interval '170 days', 'scheduled'),
  ('e5000000-0000-0000-0000-0000000000b1', 'e2000000-0000-0000-0000-000000000002', 'cs_pass_test_b1',
   now() - interval '5 days', now() + interval '85 days', 'refunded'),
  ('e5000000-0000-0000-0000-0000000000b2', 'e2000000-0000-0000-0000-000000000002', 'cs_pass_test_b2',
   now() - interval '100 days', now() - interval '10 days', 'expired'),
  ('e5000000-0000-0000-0000-0000000000c1', 'e3000000-0000-0000-0000-000000000003', 'cs_pass_test_c1',
   now() + interval '1 day', now() + interval '91 days', 'scheduled');

-- ------------------------------------------------------------
-- 1. user_active_pass()
-- ------------------------------------------------------------
SELECT ok(
  (SELECT ends_at > now() + interval '169 days' FROM public.user_active_pass('e1000000-0000-0000-0000-000000000001')),
  'an active pass with a stacked one: the cover runs to the end of the stacked pass');
SELECT is(
  (SELECT count(*) FROM public.user_active_pass('e2000000-0000-0000-0000-000000000002')),
  0::bigint,
  'a refunded pass and an expired pass cover nothing');
SELECT is(
  (SELECT count(*) FROM public.user_active_pass('e3000000-0000-0000-0000-000000000003')),
  0::bigint,
  'a pass that has not started yet covers nothing today');

UPDATE public.user_passes SET ends_at = now() - interval '1 minute', starts_at = now() - interval '91 days'
 WHERE id = 'e5000000-0000-0000-0000-0000000000a1';
UPDATE public.user_passes SET starts_at = now() - interval '1 minute'
 WHERE id = 'e5000000-0000-0000-0000-0000000000a2';
SELECT ok(
  (SELECT ends_at > now() + interval '169 days' FROM public.user_active_pass('e1000000-0000-0000-0000-000000000001')),
  'once the active pass has ended, the stacked pass covers before the sweep has run');

-- Put Alice back: active now, stacked later.
UPDATE public.user_passes SET starts_at = now() - interval '10 days', ends_at = now() + interval '80 days'
 WHERE id = 'e5000000-0000-0000-0000-0000000000a1';
UPDATE public.user_passes SET starts_at = now() + interval '80 days'
 WHERE id = 'e5000000-0000-0000-0000-0000000000a2';

-- ------------------------------------------------------------
-- 2. Constraints
-- ------------------------------------------------------------
SELECT throws_ok(
  $$INSERT INTO public.user_passes (user_id, stripe_checkout_session_id, starts_at, ends_at, status)
    VALUES ('e1000000-0000-0000-0000-000000000001', 'cs_pass_test_bad_status', now(), now() + interval '1 day', 'paused')$$,
  '23514', NULL,
  'status is one of active, scheduled, expired, refunded');
SELECT throws_ok(
  $$INSERT INTO public.user_passes (user_id, stripe_checkout_session_id, starts_at, ends_at, status)
    VALUES ('e1000000-0000-0000-0000-000000000001', 'cs_pass_test_bad_window', now(), now() - interval '1 day', 'active')$$,
  '23514', NULL,
  'a pass cannot end before it starts');
SELECT throws_ok(
  $$INSERT INTO public.user_passes (user_id, stripe_checkout_session_id, starts_at, ends_at, status)
    VALUES ('e1000000-0000-0000-0000-000000000001', 'cs_pass_test_a1', now(), now() + interval '1 day', 'active')$$,
  '23505', NULL,
  'one pass per Checkout session: a replayed webhook cannot insert twice');
SELECT throws_ok(
  $$INSERT INTO public.user_passes (user_id, product, stripe_checkout_session_id, starts_at, ends_at, status)
    VALUES ('e1000000-0000-0000-0000-000000000001', 'personal_pass_12m', 'cs_pass_test_bad_product', now(), now() + interval '1 day', 'active')$$,
  '23514', NULL,
  'only the known product');

-- ------------------------------------------------------------
-- 3. RLS: Alice, through her own session
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-0000-0000-000000000001","role":"authenticated"}';

SELECT is(
  (SELECT array_agg(id::text ORDER BY id) FROM public.user_passes),
  ARRAY['e5000000-0000-0000-0000-0000000000a1', 'e5000000-0000-0000-0000-0000000000a2'],
  'an owner sees only their own passes');
SELECT throws_ok(
  $$INSERT INTO public.user_passes (user_id, stripe_checkout_session_id, starts_at, ends_at, status)
    VALUES ('e1000000-0000-0000-0000-000000000001', 'cs_pass_forged', now(), now() + interval '365 days', 'active')$$,
  '42501', NULL,
  'a browser session cannot grant itself a pass');
SELECT throws_ok(
  $$UPDATE public.user_passes SET ends_at = now() + interval '10 years'
     WHERE id = 'e5000000-0000-0000-0000-0000000000a1'$$,
  '42501', NULL,
  'or extend one');
SELECT throws_ok(
  $$DELETE FROM public.user_passes WHERE id = 'e5000000-0000-0000-0000-0000000000a1'$$,
  '42501', NULL,
  'or delete one');
SELECT throws_ok(
  $$SELECT * FROM public.user_active_pass('e1000000-0000-0000-0000-000000000001')$$,
  '42501', NULL,
  'user_active_pass is not callable from a browser session');
SELECT throws_ok(
  $$SELECT public.dispatch_pass_expiry()$$,
  '42501', NULL,
  'dispatch_pass_expiry is not callable from a browser session');
RESET ROLE;

SET LOCAL ROLE anon;
SELECT throws_ok(
  $$SELECT count(*) FROM public.user_passes$$,
  '42501', NULL,
  'anon cannot read passes');
RESET ROLE;

-- ------------------------------------------------------------
-- 4. The cron entry point
-- ------------------------------------------------------------
SELECT is(
  (SELECT schedule FROM cron.job WHERE jobname = 'dispatch-pass-expiry'),
  '*/15 * * * *',
  'the expiry job runs every 15 minutes');

-- Nothing due: Carol's pass has not started and Alice's has not ended.
CREATE TEMP TABLE pass_test_queue AS SELECT count(*) AS n FROM net.http_request_queue;
SELECT public.dispatch_pass_expiry();
SELECT is(
  (SELECT count(*) FROM net.http_request_queue),
  (SELECT n FROM pass_test_queue),
  'nothing due: dispatch_pass_expiry() makes no HTTP request');

-- Alice's pass has ended, no Vault secret: a warning and a skip.
UPDATE public.user_passes SET starts_at = now() - interval '91 days', ends_at = now() - interval '1 minute'
 WHERE id = 'e5000000-0000-0000-0000-0000000000a1';
DELETE FROM vault.secrets WHERE name = 'dispatch_secret';
SELECT lives_ok(
  $$SELECT public.dispatch_pass_expiry()$$,
  'an ended pass without the Vault secret: skipped, not raised');
SELECT is(
  (SELECT count(*) FROM net.http_request_queue),
  (SELECT n FROM pass_test_queue),
  'and still no HTTP request');

-- With the secret: one request to the web route. (Rolled back, never sent.)
SELECT vault.create_secret('pass-test-dispatch-secret', 'dispatch_secret');
SELECT public.dispatch_pass_expiry();
SELECT is(
  (SELECT count(*) FROM net.http_request_queue
    WHERE url = 'https://mcpemails.com/api/internal/pass-expiry'),
  1::bigint,
  'an ended pass with the secret: exactly one POST to /api/internal/pass-expiry');

-- ------------------------------------------------------------
-- 5. Funnel vocabulary
-- ------------------------------------------------------------
SELECT lives_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
    VALUES ('ea000000-0000-0000-0000-00000000000a', 'pass_checkout_completed', 'success', 'personal_pass_3m'),
           ('ea000000-0000-0000-0000-00000000000a', 'pass_offer_shown', 'started', 'cap_banner'),
           ('ea000000-0000-0000-0000-00000000000a', 'pass_renewed', 'success', 'pass'),
           ('ea000000-0000-0000-0000-00000000000a', 'pass_expired', 'success', 'personal_pass_3m'),
           ('ea000000-0000-0000-0000-00000000000a', 'pass_refunded', 'success', 'personal_pass_3m')$$,
  'the pass stages and categories are accepted');
SELECT lives_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
    VALUES ('ea000000-0000-0000-0000-00000000000a', 'paywall_clicked', 'success', 'personal_month'),
           ('ea000000-0000-0000-0000-00000000000a', 'checkout_completed', 'success', 'pro_year')$$,
  'the existing stages and categories are still accepted');

SELECT * FROM finish();
ROLLBACK;
