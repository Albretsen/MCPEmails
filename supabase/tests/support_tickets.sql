-- ============================================================
-- Support tickets (the /help contact form)
-- ============================================================
-- Covers migration 20261016090000_support_tickets:
--   - the human ref (MCPE-1001, MCPE-1002, ...) and the defaults
--   - the constraints that mirror the API's validation and length caps
--   - service-role only: a browser session can neither read nor write it
--   - deleting the user keeps the ticket but drops the link to them
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(13);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('f2000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'support-alice@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('fc000000-0000-0000-0000-00000000000a', 'support-a', 'Support A', 'f2000000-0000-0000-0000-000000000001', 'free');

INSERT INTO public.support_tickets (id, user_id, workspace_id, email, category, subject, message, source)
VALUES ('fd000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001',
        'fc000000-0000-0000-0000-00000000000a', 'support-alice@rls-test.invalid',
        'connect', 'Cannot connect', 'It says the password is wrong.', 'form_signed_in');

INSERT INTO public.support_tickets (id, email, category, subject, message, source)
VALUES ('fd000000-0000-0000-0000-000000000002', 'visitor@rls-test.invalid',
        'other', 'Question', 'Hello.', 'form_signed_out');

-- ------------------------------------------------------------
-- 1. Ref and defaults
-- ------------------------------------------------------------
SELECT ok(
  (SELECT ref ~ '^MCPE-[0-9]{4,}$' FROM public.support_tickets WHERE id = 'fd000000-0000-0000-0000-000000000001'),
  'a ticket gets a human ref like MCPE-1001');

SELECT ok(
  (SELECT substr(b.ref, 6)::bigint > substr(a.ref, 6)::bigint
     FROM public.support_tickets a, public.support_tickets b
    WHERE a.id = 'fd000000-0000-0000-0000-000000000001'
      AND b.id = 'fd000000-0000-0000-0000-000000000002'),
  'refs count up');

SELECT is(
  (SELECT status FROM public.support_tickets WHERE id = 'fd000000-0000-0000-0000-000000000002'),
  'open',
  'a new ticket is open');

-- ------------------------------------------------------------
-- 2. Constraints
-- ------------------------------------------------------------
SELECT throws_ok(
  $$INSERT INTO public.support_tickets (email, category, subject, message, source)
    VALUES ('x@rls-test.invalid', 'sales', 's', 'm', 'form_signed_out')$$,
  '23514', NULL,
  'category is one of the six the form offers');

SELECT throws_ok(
  $$INSERT INTO public.support_tickets (email, category, subject, message, source)
    VALUES ('X@RLS-TEST.invalid', 'other', 's', 'm', 'form_signed_out')$$,
  '23514', NULL,
  'email is stored lowercased, so the rate-limit lookup is an equality');

SELECT throws_ok(
  $$INSERT INTO public.support_tickets (email, category, subject, message, source)
    VALUES ('x@rls-test.invalid', 'other', repeat('s', 151), 'm', 'form_signed_out')$$,
  '23514', NULL,
  'subject is capped at 150 characters');

SELECT throws_ok(
  $$INSERT INTO public.support_tickets (email, category, subject, message, source)
    VALUES ('x@rls-test.invalid', 'other', 's', repeat('m', 5001), 'form_signed_out')$$,
  '23514', NULL,
  'message is capped at 5000 characters');

SELECT throws_ok(
  $$INSERT INTO public.support_tickets (email, category, subject, message, source)
    VALUES ('x@rls-test.invalid', 'other', 's', 'm', 'email')$$,
  '23514', NULL,
  'source is one of the two form sources');

-- ------------------------------------------------------------
-- 3. Service-role only
-- ------------------------------------------------------------
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.support_tickets'::regclass),
  'RLS is enabled');

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"f2000000-0000-0000-0000-000000000001","role":"authenticated"}';

SELECT throws_ok(
  $$SELECT count(*) FROM public.support_tickets$$,
  '42501', NULL,
  'a signed-in user cannot read tickets, not even their own');

SELECT throws_ok(
  $$INSERT INTO public.support_tickets (email, category, subject, message, source)
    VALUES ('support-alice@rls-test.invalid', 'other', 's', 'm', 'form_signed_in')$$,
  '42501', NULL,
  'a signed-in user cannot write a ticket directly');

RESET ROLE;
SET LOCAL ROLE anon;

SELECT throws_ok(
  $$SELECT count(*) FROM public.support_tickets$$,
  '42501', NULL,
  'anon cannot read tickets');

RESET ROLE;

-- ------------------------------------------------------------
-- 4. Deleting the user keeps the ticket, without the link
-- ------------------------------------------------------------
DELETE FROM auth.users WHERE id = 'f2000000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT user_id::text FROM public.support_tickets WHERE id = 'fd000000-0000-0000-0000-000000000001'),
  NULL,
  'deleting the user nulls user_id and keeps the ticket');

SELECT * FROM finish();

ROLLBACK;
