-- ============================================================
-- Cancellation feedback (/billing/feedback and the Billing card)
-- ============================================================
-- Covers migration 20261024220000_cancellation_feedback:
--   - the fixed reasons, the detail cap and the two sources
--   - one answer per cancellation: a resubmit upserts, also with no period end
--   - service-role only: a browser session can neither read nor write it
--   - deleting the user removes their answers
--   - product_funnel_events accepts the new stages and categories and still
--     accepts the old ones
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(19);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('f3000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'feedback-alice@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.users (id, email, display_name) VALUES
  ('f3000000-0000-0000-0000-000000000001', 'feedback-alice@rls-test.invalid', 'Alice')
ON CONFLICT DO NOTHING;

INSERT INTO public.cancellation_feedback (id, stripe_customer_id, user_id, subscription_id, period_end, reason, source)
VALUES ('fe000000-0000-0000-0000-000000000001', 'cus_test1', 'f3000000-0000-0000-0000-000000000001',
        'sub_test1', '2026-11-10T00:00:00Z', 'too_expensive', 'cancel_email');

-- ------------------------------------------------------------
-- 1. Constraints
-- ------------------------------------------------------------
SELECT throws_ok(
  $$INSERT INTO public.cancellation_feedback (subscription_id, reason, source)
    VALUES ('sub_x', 'price', 'cancel_email')$$,
  '23514', NULL,
  'reason is one of the seven fixed answers');

SELECT lives_ok(
  $$INSERT INTO public.cancellation_feedback (subscription_id, reason, detail, source)
    VALUES ('sub_x1', 'other', repeat('d', 500), 'billing_card')$$,
  'detail may be 500 characters');

SELECT throws_ok(
  $$INSERT INTO public.cancellation_feedback (subscription_id, reason, detail, source)
    VALUES ('sub_x2', 'other', repeat('d', 501), 'billing_card')$$,
  '23514', NULL,
  'detail is capped at 500 characters');

SELECT throws_ok(
  $$INSERT INTO public.cancellation_feedback (subscription_id, reason, source)
    VALUES ('sub_x3', 'other', 'portal')$$,
  '23514', NULL,
  'source is billing_card or cancel_email');

SELECT throws_ok(
  $$INSERT INTO public.cancellation_feedback (reason, source) VALUES ('other', 'cancel_email')$$,
  '23502', NULL,
  'subscription_id is required');

-- ------------------------------------------------------------
-- 2. One answer per cancellation
-- ------------------------------------------------------------
SELECT throws_ok(
  $$INSERT INTO public.cancellation_feedback (subscription_id, period_end, reason, source)
    VALUES ('sub_test1', '2026-11-10T00:00:00Z', 'reliability', 'billing_card')$$,
  '23505', NULL,
  'a second plain insert for the same cancellation is refused');

-- The route's upsert: ON CONFLICT (subscription_id, period_end) DO UPDATE.
INSERT INTO public.cancellation_feedback (subscription_id, period_end, reason, source)
VALUES ('sub_test1', '2026-11-10T00:00:00Z', 'reliability', 'billing_card')
ON CONFLICT (subscription_id, period_end) DO UPDATE SET reason = EXCLUDED.reason, source = EXCLUDED.source;

SELECT is(
  (SELECT count(*)::int FROM public.cancellation_feedback WHERE subscription_id = 'sub_test1'),
  1,
  'a resubmit keeps one row');

SELECT is(
  (SELECT reason || '/' || source FROM public.cancellation_feedback WHERE subscription_id = 'sub_test1'),
  'reliability/billing_card',
  'a resubmit replaces the answer');

SELECT lives_ok(
  $$INSERT INTO public.cancellation_feedback (subscription_id, period_end, reason, source)
    VALUES ('sub_test1', '2027-11-10T00:00:00Z', 'other', 'cancel_email')$$,
  'a later cancellation of the same subscription is its own row');

INSERT INTO public.cancellation_feedback (subscription_id, reason, source)
VALUES ('sub_noend', 'other', 'cancel_email');

SELECT throws_ok(
  $$INSERT INTO public.cancellation_feedback (subscription_id, reason, source)
    VALUES ('sub_noend', 'switched_tool', 'cancel_email')$$,
  '23505', NULL,
  'NULLS NOT DISTINCT: no period end is still one answer per subscription');

-- ------------------------------------------------------------
-- 3. Service-role only
-- ------------------------------------------------------------
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cancellation_feedback'::regclass),
  'RLS is enabled');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"f3000000-0000-0000-0000-000000000001","role":"authenticated"}';

SELECT throws_ok(
  $$SELECT count(*) FROM public.cancellation_feedback$$,
  '42501', NULL,
  'a signed-in user cannot read answers, not even their own');

SELECT throws_ok(
  $$INSERT INTO public.cancellation_feedback (subscription_id, reason, source)
    VALUES ('sub_y', 'other', 'billing_card')$$,
  '42501', NULL,
  'a signed-in user cannot write an answer directly');

RESET ROLE;
SET LOCAL ROLE anon;

SELECT throws_ok(
  $$SELECT count(*) FROM public.cancellation_feedback$$,
  '42501', NULL,
  'anon cannot read answers');

RESET ROLE;

-- ------------------------------------------------------------
-- 4. Deleting the user removes their answers
-- ------------------------------------------------------------
DELETE FROM auth.users WHERE id = 'f3000000-0000-0000-0000-000000000001';
DELETE FROM public.users WHERE id = 'f3000000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT count(*)::int FROM public.cancellation_feedback WHERE id = 'fe000000-0000-0000-0000-000000000001'),
  0,
  'deleting the user deletes the answer they gave');

-- ------------------------------------------------------------
-- 5. Funnel vocabulary widened, nothing dropped
-- ------------------------------------------------------------
SELECT ok(
  (SELECT pg_get_constraintdef(oid) LIKE '%cancel_reason_submitted%'
          AND pg_get_constraintdef(oid) LIKE '%retention_option_clicked%'
     FROM pg_constraint WHERE conname = 'product_funnel_events_stage_check'),
  'the stage CHECK accepts the two new stages');

SELECT ok(
  (SELECT pg_get_constraintdef(oid) LIKE '%paywall_clicked%'
          AND pg_get_constraintdef(oid) LIKE '%onboarding_started%'
          AND pg_get_constraintdef(oid) LIKE '%plan_downgraded%'
     FROM pg_constraint WHERE conname = 'product_funnel_events_stage_check'),
  'the stage CHECK still accepts the existing stages');

SELECT ok(
  (SELECT pg_get_constraintdef(oid) LIKE '%temporary_need%'
          AND pg_get_constraintdef(oid) LIKE '%''downgrade''%'
          AND pg_get_constraintdef(oid) LIKE '%''pause''%'
     FROM pg_constraint WHERE conname = 'product_funnel_events_category_check'),
  'the category CHECK accepts the reasons and the retention options');

SELECT ok(
  (SELECT pg_get_constraintdef(oid) LIKE '%generic_imap%'
          AND pg_get_constraintdef(oid) LIKE '%dashboard_billing%'
          AND pg_get_constraintdef(oid) LIKE '%pro_year%'
     FROM pg_constraint WHERE conname = 'product_funnel_events_category_check'),
  'the category CHECK still accepts the existing categories');

SELECT * FROM finish();

ROLLBACK;
