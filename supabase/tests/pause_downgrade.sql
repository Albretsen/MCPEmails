-- ============================================================
-- Pause and downgrade state (migration 20261024190000)
-- ============================================================
-- Pins: the user_billing pair CHECKs; that an owner cannot write the pause
-- columns (no user write policy, so a customer cannot widen their own Free
-- window); the Free allowance window opening at paused_from once a pause has
-- started, and not before; workspace_action_allowance_terms() agreeing with
-- workspace_action_allowance(); and the new funnel stages and email templates.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(14);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('fb200000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pause-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('fb200000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pause-later@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

-- Two Free workspaces, both long out of grace.
INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan, created_at, free_action_cap_exempt) VALUES
  ('fb20aaaa-0000-0000-0000-00000000000a', 'pause-ws-a', 'Paused', 'fb200000-0000-0000-0000-0000000000a1', 'free', now() - interval '90 days', false),
  ('fb20aaaa-0000-0000-0000-00000000000b', 'pause-ws-b', 'Later',  'fb200000-0000-0000-0000-0000000000a2', 'free', now() - interval '90 days', false)
ON CONFLICT DO NOTHING;

-- The pause started a minute ago for A; B's starts tomorrow.
INSERT INTO public.user_billing (user_id, plan, subscription_status, paused_from, pause_resumes_at) VALUES
  ('fb200000-0000-0000-0000-0000000000a1', 'free', 'paused', now() - interval '1 minute', now() + interval '30 days'),
  ('fb200000-0000-0000-0000-0000000000a2', 'personal', 'active', now() + interval '1 day', now() + interval '31 days')
ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan, subscription_status = EXCLUDED.subscription_status,
  paused_from = EXCLUDED.paused_from, pause_resumes_at = EXCLUDED.pause_resumes_at;

-- One action before the pause (a paid action) and one after.
INSERT INTO public.action_usage (workspace_id, tool_name, billable, quantity, meter_version, occurred_at) VALUES
  ('fb20aaaa-0000-0000-0000-00000000000a', 'email_read', true, 1, 1, now() - interval '2 minutes'),
  ('fb20aaaa-0000-0000-0000-00000000000a', 'email_read', true, 1, 1, now() - interval '30 seconds'),
  ('fb20aaaa-0000-0000-0000-00000000000b', 'email_read', true, 1, 1, now() - interval '2 minutes');

-- ── Columns and CHECKs ───────────────────────────────────────────────────
SELECT has_column('public', 'user_billing', 'paused_from', 'user_billing.paused_from exists');
SELECT has_column('public', 'user_billing', 'inbox_keep_order', 'user_billing.inbox_keep_order exists');
SELECT throws_ok(
  $$UPDATE public.user_billing SET pending_plan = 'personal' WHERE user_id = 'fb200000-0000-0000-0000-0000000000a2'$$,
  '23514', NULL, 'a pending plan without a date is refused');
SELECT throws_ok(
  $$UPDATE public.user_billing SET pause_resumes_at = NULL WHERE user_id = 'fb200000-0000-0000-0000-0000000000a1'$$,
  '23514', NULL, 'a pause start without an end is refused');
SELECT throws_ok(
  $$UPDATE public.user_billing SET inbox_keep_order = '{"a": 1}'::jsonb WHERE user_id = 'fb200000-0000-0000-0000-0000000000a1'$$,
  '23514', NULL, 'inbox_keep_order must be an array');

-- ── The owner cannot move their own pause ─────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub": "fb200000-0000-0000-0000-0000000000a1", "role": "authenticated"}', true);
UPDATE public.user_billing SET paused_from = now() WHERE user_id = 'fb200000-0000-0000-0000-0000000000a1';
RESET ROLE;
SELECT ok(
  (SELECT paused_from < now() - interval '30 seconds' FROM public.user_billing WHERE user_id = 'fb200000-0000-0000-0000-0000000000a1'),
  '[owner] an update of paused_from changes nothing');

-- ── The Free window during a pause ────────────────────────────────────────
SELECT ok(
  (SELECT period_start >= now() - interval '1 minute' - interval '1 second'
     FROM public.workspace_action_allowance('fb20aaaa-0000-0000-0000-00000000000a')),
  'a running pause opens the Free window at paused_from');
SELECT is(
  (SELECT used FROM public.workspace_action_allowance('fb20aaaa-0000-0000-0000-00000000000a')),
  1,
  'only the action after the pause start is counted');
SELECT is(
  (SELECT period_start FROM public.workspace_action_allowance('fb20aaaa-0000-0000-0000-00000000000b')),
  (SELECT GREATEST(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
                   public.free_action_grace_ends_at(now() - interval '90 days'))),
  'a pause that has not started does not move the window');
SELECT is(
  (SELECT to_jsonb(t) - 'used' - 'remaining' FROM public.workspace_action_allowance_terms('fb20aaaa-0000-0000-0000-00000000000a') t),
  (SELECT to_jsonb(a) - 'used' - 'remaining' FROM public.workspace_action_allowance('fb20aaaa-0000-0000-0000-00000000000a') a),
  'the terms agree with the full allowance during a pause');

-- ── Funnel stages, categories and templates ──────────────────────────────
SELECT lives_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
    VALUES ('fb20aaaa-0000-0000-0000-00000000000a', 'pause_started', 'success', 'solo')$$,
  'pause_started is a stage');
SELECT lives_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
    VALUES ('fb20aaaa-0000-0000-0000-00000000000a', 'pause_resumed', 'success', 'early')$$,
  'pause_resumed takes the early category');
SELECT lives_ok(
  $$INSERT INTO public.billing_email_sends (stripe_customer_id, recipient, template, scope_key, send_after)
    VALUES ('cus_pause_test', 'pause-owner@rls-test.invalid', 'pause_ending_3', 'sub_x:1790000000', now())$$,
  'pause_ending_3 is a template');
SELECT is(
  (SELECT category FROM public.billing_email_sends WHERE scope_key = 'sub_x:1790000000'),
  'transactional',
  'and it is transactional');

SELECT * FROM finish();
ROLLBACK;
