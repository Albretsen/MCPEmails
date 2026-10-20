-- ============================================================
-- Signup country (20261020140000_acquisition_country.sql)
-- ============================================================
-- Proves:
--   1. A workspace made by the real signup trigger starts with no country,
--      even when the signup metadata tries to supply one: the code comes from
--      a request header on the server and has no metadata path.
--   2. workspaces.acquisition_country takes two uppercase letters, and NULL,
--      and nothing else. An IP address must never fit.
--   3. The app's write, filtered on IS NULL, changes nothing once a value is
--      there.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(8);

INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES (
  'a9100000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'owner@country-test.invalid',
  'x', now(), now(), now(), '{"provider":"email","providers":["email"]}',
  '{"acquisition_country":"NO"}'
);

SELECT ok(
  (SELECT acquisition_country IS NULL FROM public.workspaces
     WHERE owner_id = 'a9100000-0000-0000-0000-000000000001'),
  '[country] a new workspace starts unknown, whatever the signup metadata claims'
);

SELECT lives_ok(
  $$UPDATE public.workspaces SET acquisition_country = 'FR'
     WHERE owner_id = 'a9100000-0000-0000-0000-000000000001'$$,
  '[country] a two-letter code is accepted'
);

SELECT throws_ok(
  $$UPDATE public.workspaces SET acquisition_country = 'fr'
     WHERE owner_id = 'a9100000-0000-0000-0000-000000000001'$$,
  '23514', NULL,
  '[country] lowercase is refused'
);

SELECT throws_ok(
  $$UPDATE public.workspaces SET acquisition_country = 'FRA'
     WHERE owner_id = 'a9100000-0000-0000-0000-000000000001'$$,
  '23514', NULL,
  '[country] a three-letter code is refused'
);

SELECT throws_ok(
  $$UPDATE public.workspaces SET acquisition_country = '192.0.2.1'
     WHERE owner_id = 'a9100000-0000-0000-0000-000000000001'$$,
  '23514', NULL,
  '[country] an IP address never fits in the column'
);

SELECT throws_ok(
  $$UPDATE public.workspaces SET acquisition_country = ''
     WHERE owner_id = 'a9100000-0000-0000-0000-000000000001'$$,
  '23514', NULL,
  '[country] an empty string is refused; unknown is NULL'
);

-- The statement the app runs (acquisition-country-stamp.ts): first write wins.
UPDATE public.workspaces SET acquisition_country = 'DE'
 WHERE owner_id = 'a9100000-0000-0000-0000-000000000001'
   AND acquisition_country IS NULL;

SELECT is(
  (SELECT acquisition_country FROM public.workspaces
     WHERE owner_id = 'a9100000-0000-0000-0000-000000000001'),
  'FR',
  '[country] a later stamp never overwrites the first one'
);

SELECT col_is_null(
  'public', 'workspaces', 'acquisition_country',
  '[country] the column is nullable: unknown is a legitimate answer'
);

SELECT * FROM finish();
ROLLBACK;
