-- ============================================================
-- Failed-payment columns (20261024190000_payment_issue_columns.sql)
-- ============================================================
-- Proves:
--   1. The owner reads their own user_billing.last_decline_code (the banner
--      needs it) and cannot write any of the three workspaces.payment_*
--      columns through PostgREST. (user_billing writes are refused by its
--      RLS, select-own only, as before.)
--   2. payment_issue_kind accepts only 'declined', 'confirm' or NULL.
--   3. The service role writes all four (the webhook and mcp-server do).
--   4. mcp_tools_call_gate returns the three workspace payment columns.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(11);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('9f000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'payment-issue@rls-test.invalid', 'x', now(), now(), now(),
   '{"provider":"email","providers":["email"]}', '{}');

CREATE TEMP TABLE p_ids ON COMMIT DROP AS
SELECT (SELECT id FROM public.workspaces WHERE owner_id = '9f000000-0000-0000-0000-000000000001') AS ws;
GRANT SELECT ON p_ids TO anon, authenticated, service_role;

INSERT INTO public.user_billing (user_id, plan, stripe_customer_id, subscription_status, last_decline_code)
VALUES ('9f000000-0000-0000-0000-000000000001', 'personal', 'cus_pgtap_payment_issue', 'past_due', 'insufficient_funds')
ON CONFLICT (user_id) DO UPDATE
  SET plan = EXCLUDED.plan,
      stripe_customer_id = EXCLUDED.stripe_customer_id,
      subscription_status = EXCLUDED.subscription_status,
      last_decline_code = EXCLUDED.last_decline_code;

-- ── 2. The CHECK constraint (as postgres) ───────────────────────────────────
SELECT throws_ok(
  $$UPDATE public.workspaces SET payment_issue_kind = 'other' WHERE id = (SELECT ws FROM p_ids)$$,
  '23514', NULL, 'payment_issue_kind refuses anything but declined / confirm');
SELECT lives_ok(
  $$UPDATE public.workspaces SET payment_issue_kind = NULL WHERE id = (SELECT ws FROM p_ids)$$,
  'payment_issue_kind may be NULL');

-- ── 1. The owner, through their own session ────────────────────────────────
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO
  '{"sub":"9f000000-0000-0000-0000-000000000001","role":"authenticated"}';

SELECT is(
  (SELECT last_decline_code FROM public.user_billing WHERE user_id = '9f000000-0000-0000-0000-000000000001'),
  'insufficient_funds', '[read] the owner reads their own last_decline_code');
SELECT is(
  (SELECT count(*)::int FROM public.workspaces WHERE id = (SELECT ws FROM p_ids) AND payment_issue_since IS NULL),
  1, '[read] the owner reads the workspace payment columns');

SELECT throws_ok(
  $$UPDATE public.workspaces SET payment_issue_since = now() WHERE id = (SELECT ws FROM p_ids)$$,
  '42501', NULL, '[update] owner cannot set payment_issue_since');
SELECT throws_ok(
  $$UPDATE public.workspaces SET payment_issue_kind = 'confirm' WHERE id = (SELECT ws FROM p_ids)$$,
  '42501', NULL, '[update] owner cannot set payment_issue_kind');
SELECT throws_ok(
  $$UPDATE public.workspaces SET payment_notice_shown_on = current_date WHERE id = (SELECT ws FROM p_ids)$$,
  '42501', NULL, '[update] owner cannot set payment_notice_shown_on');

RESET ROLE;

-- ── 3. The service role ─────────────────────────────────────────────────────
SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$UPDATE public.workspaces
       SET payment_issue_since = now(), payment_issue_kind = 'confirm', payment_notice_shown_on = current_date
     WHERE id = (SELECT ws FROM p_ids)$$,
  '[service] the service role writes the workspace payment columns');
SELECT lives_ok(
  $$UPDATE public.user_billing SET last_decline_code = 'authentication_required'
     WHERE user_id = '9f000000-0000-0000-0000-000000000001'$$,
  '[service] the service role writes last_decline_code');
RESET ROLE;

-- ── 4. The gate RPC carries them ────────────────────────────────────────────
INSERT INTO public.api_keys (id, workspace_id, created_by, name, key_prefix, key_hash, scopes)
SELECT 'bf000000-0000-0000-0000-000000000001', ws, '9f000000-0000-0000-0000-000000000001',
       'Payment', 'mcpe_p1', 'gate_hash_payment_issue', ARRAY['read:email']
FROM p_ids;

SELECT is(
  public.mcp_tools_call_gate('gate_hash_payment_issue', ARRAY[now()], now(), false, NULL, 1)
    ->'workspace'->>'payment_issue_kind',
  'confirm', 'mcp_tools_call_gate returns payment_issue_kind');
SELECT is(
  public.mcp_tools_call_gate('gate_hash_payment_issue', ARRAY[now()], now(), false, NULL, 1)
    ->'workspace'->>'payment_notice_shown_on',
  current_date::text, 'and payment_notice_shown_on, as a YYYY-MM-DD day');

SELECT * FROM finish();
ROLLBACK;
