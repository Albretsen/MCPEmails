-- ============================================================
-- "How did you hear about MCPEmails?" (20261111150000_heard_about.sql)
-- ============================================================
-- Proves:
--   1. The owner reads heard_about_at (the dashboard gate) and cannot write
--      any of the three columns through their own session.
--   2. heard_about accepts only the option ids; heard_about_other only with
--      'other' and at most 200 characters; an answer needs heard_about_at.
--   3. The service role writes them (POST /api/onboarding/heard-about).
--   4. The funnel accepts heard_about_answered and heard_about_dismissed.
--   5. growth_heard_about counts answers and dismissals with paid, and is not
--      callable by authenticated.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(14);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('9e000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'heard-about@rls-test.invalid', 'x', now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{}');

CREATE TEMP TABLE h_ids ON COMMIT DROP AS
SELECT (SELECT id FROM public.workspaces WHERE owner_id = '9e000000-0000-0000-0000-000000000001') AS ws;
GRANT SELECT ON h_ids TO anon, authenticated, service_role;

-- ── 2. The CHECK constraints (as postgres) ──────────────────────────────────
SELECT throws_ok(
  $$UPDATE public.workspaces SET heard_about = 'tiktok', heard_about_at = now() WHERE id = (SELECT ws FROM h_ids)$$,
  '23514', NULL, 'heard_about refuses an unknown option');
SELECT throws_ok(
  $$UPDATE public.workspaces SET heard_about = 'chatgpt', heard_about_at = NULL WHERE id = (SELECT ws FROM h_ids)$$,
  '23514', NULL, 'an answer needs heard_about_at');
SELECT throws_ok(
  $$UPDATE public.workspaces SET heard_about = 'claude', heard_about_other = 'x', heard_about_at = now() WHERE id = (SELECT ws FROM h_ids)$$,
  '23514', NULL, 'heard_about_other only goes with other');
SELECT throws_ok(
  $$UPDATE public.workspaces SET heard_about = 'other', heard_about_other = repeat('x', 201), heard_about_at = now() WHERE id = (SELECT ws FROM h_ids)$$,
  '23514', NULL, 'heard_about_other is at most 200 characters');
SELECT lives_ok(
  $$UPDATE public.workspaces SET heard_about = NULL, heard_about_other = NULL, heard_about_at = NULL WHERE id = (SELECT ws FROM h_ids)$$,
  'all three may be NULL');

-- ── 1. The owner, through their own session ────────────────────────────────
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO
  '{"sub":"9e000000-0000-0000-0000-000000000001","role":"authenticated"}';

SELECT is(
  (SELECT count(*)::int FROM public.workspaces WHERE id = (SELECT ws FROM h_ids) AND heard_about_at IS NULL),
  1, '[read] the owner reads heard_about_at');
SELECT throws_ok(
  $$UPDATE public.workspaces SET heard_about = 'chatgpt', heard_about_at = now() WHERE id = (SELECT ws FROM h_ids)$$,
  '42501', NULL, '[update] owner cannot set heard_about');
SELECT throws_ok(
  $$UPDATE public.workspaces SET heard_about_at = now() WHERE id = (SELECT ws FROM h_ids)$$,
  '42501', NULL, '[update] owner cannot set heard_about_at');
SELECT throws_ok(
  $$SELECT * FROM public.growth_heard_about()$$,
  '42501', NULL, '[rpc] authenticated cannot call growth_heard_about');

RESET ROLE;

-- ── 3. The service role ─────────────────────────────────────────────────────
SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$UPDATE public.workspaces
       SET heard_about = 'other', heard_about_other = 'a podcast', heard_about_at = now()
     WHERE id = (SELECT ws FROM h_ids)$$,
  '[service] the service role writes the answer');

-- ── 4. Funnel vocabulary ────────────────────────────────────────────────────
SELECT lives_ok(
  $$INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
    VALUES ((SELECT ws FROM h_ids), 'heard_about_answered', 'success', 'surface_overview'),
           ((SELECT ws FROM h_ids), 'heard_about_dismissed', 'success', 'surface_overview'),
           ((SELECT ws FROM h_ids), 'checkout_completed', 'success', 'personal_month')$$,
  '[funnel] heard_about stages are in the vocabulary');

-- ── 5. The growth table ─────────────────────────────────────────────────────
SELECT is(
  (SELECT workspaces FROM public.growth_heard_about('{}', '{}') WHERE answer = 'other'),
  1, '[rpc] the answer is counted');
SELECT is(
  (SELECT paid FROM public.growth_heard_about('{}', '{}') WHERE answer = 'other'),
  1, '[rpc] a completed checkout counts as paid');
SELECT is(
  (SELECT count(*)::int FROM public.growth_heard_about(ARRAY['heard-about@rls-test.invalid'], '{}') WHERE answer = 'other'),
  0, '[rpc] an internal owner is excluded');

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
