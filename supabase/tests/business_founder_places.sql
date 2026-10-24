-- ============================================================
-- public.business_founder_places: the founder-price place counter
-- ============================================================
-- Covers 20261024180000_business_founder_places.sql.
--
--   - RLS is on and neither anon nor authenticated can read or write it
--   - service_role may SELECT and INSERT, never UPDATE or DELETE
--   - record_business_founder_place() inserts once per subscription
--   - internal accounts never take a place
--   - the runtime flag is seeded OFF
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(14);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('fd000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'founder-buyer@founder-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('fd000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'someone@mcpemails.com', 'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.users (id, email, display_name) VALUES
  ('fd000000-0000-0000-0000-0000000000a1', 'founder-buyer@founder-test.invalid', 'Buyer'),
  ('fd000000-0000-0000-0000-0000000000a2', 'someone@mcpemails.com', 'Internal')
ON CONFLICT DO NOTHING;

SELECT has_table('public', 'business_founder_places', 'business_founder_places exists');

SELECT ok(
  (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'business_founder_places'),
  'business_founder_places has RLS enabled');

SELECT is(
  (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = 'business_founder_places'),
  0,
  'no policies: nobody but the service role reaches it');

SELECT is(
  (SELECT enabled FROM public.pricing_switches WHERE key = 'business_founder_price'),
  false,
  'the business_founder_price flag is seeded off');

SELECT ok(NOT has_table_privilege('anon', 'public.business_founder_places', 'SELECT'), 'anon cannot read');
SELECT ok(NOT has_table_privilege('authenticated', 'public.business_founder_places', 'SELECT'), 'authenticated cannot read');
SELECT ok(NOT has_table_privilege('authenticated', 'public.business_founder_places', 'INSERT'), 'authenticated cannot insert');
SELECT ok(has_table_privilege('service_role', 'public.business_founder_places', 'INSERT'), 'service_role can insert');
SELECT ok(NOT has_table_privilege('service_role', 'public.business_founder_places', 'DELETE'), 'service_role cannot delete: places are never given back');
SELECT ok(NOT has_table_privilege('service_role', 'public.business_founder_places', 'UPDATE'), 'service_role cannot update');

SELECT is(
  public.record_business_founder_place('sub_founder_1', 'fd000000-0000-0000-0000-0000000000a1', 'month'),
  true,
  'a paid founder subscription takes a place');

SELECT is(
  public.record_business_founder_place('sub_founder_1', 'fd000000-0000-0000-0000-0000000000a1', 'month'),
  false,
  'a retried event for the same subscription takes no second place');

SELECT is(
  public.record_business_founder_place('sub_founder_internal', 'fd000000-0000-0000-0000-0000000000a2', 'year'),
  false,
  'an internal account never takes a place');

SELECT is(
  (SELECT count(*)::int FROM public.business_founder_places),
  1,
  'exactly one place is taken');

SELECT * FROM finish();
ROLLBACK;
