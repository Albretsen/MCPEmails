-- ============================================================
-- Referral program (migration 20261025090000_referrals.sql)
-- ============================================================
-- Pins: a user reads only their own referral_codes row and nothing of
-- referrals or referral_rewards; my_referral_summary() returns only the
-- caller's referrals, shows a hold as 'charged' and never names the friend;
-- a friend can be referred once; one reward per (referral, side); no
-- self-referral; the referral Personal month is honored by the allowance and
-- effective_workspace_plan() while it runs and not after; it never overwrites
-- an existing entitlement's kind; the 'referral' acquisition source is
-- accepted by the signup trigger; the rollout flag defaults off; the funnel
-- stages, the dispatcher grant and the cron job exist.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(44);

-- Referrer (Free), friend, second referrer, second friend, an early user with
-- a 'standard' row, and a comped user. Signing up through auth.users runs
-- handle_new_user(), which creates each one's Free workspace. The friend
-- signs up with acquisition_source 'referral'.
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('7e000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ref-referrer@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('7e000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ref-friend@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}',
   '{"acquisition_source":"referral","acquisition_referrer":"referral","acquisition_utm_source":"referral"}'),
  ('7e000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ref-other@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('7e000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ref-friend-two@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('7e000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ref-early@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('7e000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ref-comped@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.user_usage_entitlements (user_id, kind, reason, source, unlimited_inboxes)
VALUES
  ('7e000000-0000-0000-0000-000000000005', 'standard', 'pgTAP fixture', 'migration', true),
  ('7e000000-0000-0000-0000-000000000006', 'comped_scale', 'pgTAP fixture', 'support', false);

INSERT INTO public.referral_codes (user_id, code) VALUES
  ('7e000000-0000-0000-0000-000000000001', 'ABCD2345'),
  ('7e000000-0000-0000-0000-000000000003', 'WXYZ6789');

INSERT INTO public.referrals (id, code, referrer_user_id, friend_user_id, attached_via, status, qualifies_at, ip_hash, hold_reason)
VALUES
  ('8e000000-0000-0000-0000-000000000001', 'ABCD2345', '7e000000-0000-0000-0000-000000000001',
   '7e000000-0000-0000-0000-000000000002', 'cookie', 'held', now() - interval '1 day', 'iphash', 'velocity'),
  ('8e000000-0000-0000-0000-000000000002', 'WXYZ6789', '7e000000-0000-0000-0000-000000000003',
   '7e000000-0000-0000-0000-000000000004', 'code', 'qualified', now() - interval '2 days', NULL, NULL);

INSERT INTO public.referral_rewards (referral_id, side, kind, amount_cents)
VALUES ('8e000000-0000-0000-0000-000000000002', 'referrer', 'stripe_credit', 900);

-- ── Shape and constraints ─────────────────────────────────────────────────
SELECT has_table('public', 'referral_codes', 'referral_codes exists');
SELECT has_table('public', 'referrals', 'referrals exists');
SELECT has_table('public', 'referral_rewards', 'referral_rewards exists');
SELECT ok((SELECT bool_and(relrowsecurity) FROM pg_class
            WHERE oid IN ('public.referral_codes'::regclass, 'public.referrals'::regclass, 'public.referral_rewards'::regclass)),
  'RLS is on for all three tables');

SELECT throws_ok(
  $$INSERT INTO public.referrals (code, referrer_user_id, friend_user_id, attached_via)
    VALUES ('WXYZ6789', '7e000000-0000-0000-0000-000000000003', '7e000000-0000-0000-0000-000000000002', 'code')$$,
  '23505', NULL, 'a friend can be referred only once');
SELECT throws_ok(
  $$INSERT INTO public.referrals (code, referrer_user_id, friend_user_id, attached_via)
    VALUES ('ABCD2345', '7e000000-0000-0000-0000-000000000001', '7e000000-0000-0000-0000-000000000001', 'code')$$,
  '23514', NULL, 'a user cannot refer themselves');
SELECT throws_ok(
  $$INSERT INTO public.referrals (code, referrer_user_id, friend_user_id, attached_via)
    VALUES ('ABCD2345', '7e000000-0000-0000-0000-000000000001', '7e000000-0000-0000-0000-000000000005', 'email')$$,
  '23514', NULL, 'attached_via is cookie or code');
SELECT throws_ok(
  $$INSERT INTO public.referrals (code, referrer_user_id, friend_user_id, attached_via)
    VALUES ('NOPE2345', '7e000000-0000-0000-0000-000000000001', '7e000000-0000-0000-0000-000000000005', 'code')$$,
  '23503', NULL, 'a referral names an existing code');
SELECT throws_ok(
  $$INSERT INTO public.referral_rewards (referral_id, side, kind, amount_cents)
    VALUES ('8e000000-0000-0000-0000-000000000002', 'referrer', 'stripe_credit', 900)$$,
  '23505', NULL, 'one reward per referral and side');
SELECT lives_ok(
  $$INSERT INTO public.referral_rewards (referral_id, side, kind, amount_cents)
    VALUES ('8e000000-0000-0000-0000-000000000002', 'clawback_referrer', 'stripe_credit', 900)$$,
  'a clawback is its own side');
SELECT throws_ok(
  $$INSERT INTO public.referral_codes (user_id, code) VALUES ('7e000000-0000-0000-0000-000000000005', 'ABCD0123')$$,
  '23514', NULL, 'a code with 0 or 1 is refused');
SELECT throws_ok(
  $$INSERT INTO public.referral_codes (user_id, code) VALUES ('7e000000-0000-0000-0000-000000000005', 'abcd2345')$$,
  '23514', NULL, 'a lower-case code is refused');
SELECT throws_ok(
  $$INSERT INTO public.referral_codes (user_id, code) VALUES ('7e000000-0000-0000-0000-000000000005', 'ABCD2345')$$,
  '23505', NULL, 'codes are unique');

-- ── What a signed-in referrer can see ─────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub": "7e000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);

SELECT is((SELECT count(*)::int FROM public.referral_codes), 1, '[referrer] sees exactly one referral_codes row');
SELECT is((SELECT code FROM public.referral_codes), 'ABCD2345', '[referrer] and it is their own');
SELECT throws_ok($$SELECT * FROM public.referrals$$, '42501', NULL, '[referrer] cannot select referrals');
SELECT throws_ok($$SELECT * FROM public.referral_rewards$$, '42501', NULL, '[referrer] cannot select referral_rewards');
SELECT throws_ok(
  $$INSERT INTO public.referral_codes (user_id, code) VALUES ('7e000000-0000-0000-0000-000000000001', 'QRST2345')$$,
  '42501', NULL, '[referrer] cannot write referral_codes');

SELECT is((SELECT count(*)::int FROM public.my_referral_summary()), 1, '[referrer] my_referral_summary returns only their referral');
SELECT is((SELECT id FROM public.my_referral_summary()), '8e000000-0000-0000-0000-000000000001'::uuid, '[referrer] the right one');
SELECT is((SELECT status FROM public.my_referral_summary()), 'charged', '[referrer] a hold is shown as charged');
SELECT ok(
  pg_get_function_result('public.my_referral_summary()'::regprocedure) !~ '(friend|user|email|workspace|ip_hash|reason|stripe)',
  'my_referral_summary returns no friend identity, reason or Stripe id');

SELECT set_config('request.jwt.claims', '{"sub": "7e000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
SELECT is((SELECT reward_cents FROM public.my_referral_summary()), 900, '[other referrer] sees their own referrer-side reward');

SELECT set_config('request.jwt.claims', '{"sub": "7e000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
SELECT is((SELECT count(*)::int FROM public.my_referral_summary()), 0, '[friend] sees nothing as a referrer');
SELECT is((SELECT count(*)::int FROM public.referral_codes), 0, '[friend] sees no one else''s code');
SELECT throws_ok($$SELECT public.dispatch_referrals()$$, '42501', NULL, '[friend] cannot call the dispatcher');
SELECT throws_ok($$SELECT public.grant_referral_personal('7e000000-0000-0000-0000-000000000002', 30)$$,
  '42501', NULL, '[friend] cannot grant themselves a referral month');
RESET ROLE;

-- ── The referral Personal month ───────────────────────────────────────────
CREATE TEMP TABLE ref_ws AS
SELECT id FROM public.workspaces WHERE owner_id = '7e000000-0000-0000-0000-000000000001';
GRANT SELECT ON ref_ws TO authenticated;

SELECT is((SELECT plan FROM public.workspace_action_allowance((SELECT id FROM ref_ws))), 'free',
  'before a grant the referrer''s workspace is metered as Free');

SELECT ok(public.grant_referral_personal('7e000000-0000-0000-0000-000000000001', 30) > now() + interval '29 days',
  'a grant returns its end, 30 days out');
SELECT is((SELECT kind FROM public.user_usage_entitlements WHERE user_id = '7e000000-0000-0000-0000-000000000001'),
  'referral_personal', 'a user without a row gets a referral_personal row');
SELECT ok(public.grant_referral_personal('7e000000-0000-0000-0000-000000000001', 30) > now() + interval '59 days',
  'a second grant extends the running month');

SELECT is((SELECT plan || ':' || cap FROM public.workspace_action_allowance((SELECT id FROM ref_ws))), 'personal:100000',
  'while it runs the allowance meters the workspace as Personal');
SELECT is((SELECT plan || ':' || cap FROM public.workspace_action_allowance_terms((SELECT id FROM ref_ws))), 'personal:100000',
  'and so do the allowance terms the tools/call gate reads');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub": "7e000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
SELECT is((SELECT plan || ':' || referral_personal FROM public.effective_workspace_plan((SELECT id FROM ref_ws))), 'free:true',
  'effective_workspace_plan keeps the stored plan and flags referral_personal');
RESET ROLE;

UPDATE public.user_usage_entitlements
   SET referral_personal_until = now() - interval '1 second', expires_at = now() - interval '1 second'
 WHERE user_id = '7e000000-0000-0000-0000-000000000001';

SELECT is((SELECT plan || ':' || cap FROM public.workspace_action_allowance((SELECT id FROM ref_ws))), 'free:150',
  'after it ends the workspace is Free again');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub": "7e000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
SELECT is((SELECT referral_personal FROM public.effective_workspace_plan((SELECT id FROM ref_ws))), false,
  'and effective_workspace_plan no longer flags it');
RESET ROLE;

SELECT ok(public.grant_referral_personal('7e000000-0000-0000-0000-000000000005', 30) IS NOT NULL,
  'an early user with a standard row can be granted a month');
SELECT is((SELECT kind || ':' || source || ':' || unlimited_inboxes FROM public.user_usage_entitlements
            WHERE user_id = '7e000000-0000-0000-0000-000000000005'),
  'standard:migration:true', 'and their standard row keeps its kind, source and inbox grandfather');
SELECT is(public.grant_referral_personal('7e000000-0000-0000-0000-000000000006', 30), NULL::timestamptz,
  'a comped user is not granted anything');
SELECT is((SELECT kind || ':' || coalesce(referral_personal_until::text, 'none') FROM public.user_usage_entitlements
            WHERE user_id = '7e000000-0000-0000-0000-000000000006'),
  'comped_scale:none', 'and their comped row is untouched');

-- ── Acquisition, flag, funnel, cron ──────────────────────────────────────
SELECT is((SELECT acquisition_source || ':' || acquisition_referrer || ':' || acquisition_utm_source
             FROM public.workspaces WHERE owner_id = '7e000000-0000-0000-0000-000000000002'),
  'referral:referral:referral', 'the signup trigger keeps the referral source');
SELECT is((SELECT referral_enabled FROM public.workspaces WHERE owner_id = '7e000000-0000-0000-0000-000000000002'),
  false, 'referral_enabled defaults off');
SELECT lives_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
    SELECT id, 'referral_attached', 'success', 'free' FROM public.workspaces
     WHERE owner_id = '7e000000-0000-0000-0000-000000000002'$$,
  'a referral funnel stage is accepted');
SELECT is((SELECT schedule FROM cron.job WHERE jobname = 'dispatch-referrals'), '15 10 * * *',
  'the dispatcher runs daily');

SELECT * FROM finish();
ROLLBACK;
