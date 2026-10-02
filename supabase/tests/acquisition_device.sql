-- ============================================================
-- Signup device class (20261002100000_acquisition_device.sql)
-- ============================================================
-- Proves:
--   1. A workspace made by the real signup trigger starts with no device, even
--      when the signup metadata tries to supply one: the class is derived on
--      the server from request headers and has no metadata path.
--   2. workspaces.acquisition_device takes exactly the three words
--      deviceClass() can return (apps/web/src/lib/acquisition-device.mjs), and
--      NULL, and nothing else. A User-Agent string must never fit.
--   3. The app's write, filtered on IS NULL, changes nothing once a value is
--      there.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(8);

-- The real on_auth_user_created path creates the workspace.
INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES (
  'a9000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'owner@device-test.invalid',
  'x', now(), now(), now(), '{"provider":"email","providers":["email"]}',
  '{"acquisition_device":"mobile"}'
);

SELECT ok(
  (SELECT acquisition_device IS NULL FROM public.workspaces
     WHERE owner_id = 'a9000000-0000-0000-0000-000000000001'),
  '[device] a new workspace starts unknown, whatever the signup metadata claims'
);

SELECT lives_ok(
  $$UPDATE public.workspaces SET acquisition_device = 'tablet'
     WHERE owner_id = 'a9000000-0000-0000-0000-000000000001'$$,
  '[device] tablet is accepted'
);
SELECT lives_ok(
  $$UPDATE public.workspaces SET acquisition_device = 'desktop'
     WHERE owner_id = 'a9000000-0000-0000-0000-000000000001'$$,
  '[device] desktop is accepted'
);
SELECT lives_ok(
  $$UPDATE public.workspaces SET acquisition_device = 'mobile'
     WHERE owner_id = 'a9000000-0000-0000-0000-000000000001'$$,
  '[device] mobile is accepted'
);

SELECT throws_ok(
  $$UPDATE public.workspaces
       SET acquisition_device = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)'
     WHERE owner_id = 'a9000000-0000-0000-0000-000000000001'$$,
  '23514',
  NULL,
  '[device] a User-Agent string never fits in the column'
);

SELECT throws_ok(
  $$UPDATE public.workspaces SET acquisition_device = 'Mobile'
     WHERE owner_id = 'a9000000-0000-0000-0000-000000000001'$$,
  '23514',
  NULL,
  '[device] the vocabulary is exact, including case'
);

-- The statement the app runs (acquisition-device-stamp.ts): first write wins.
UPDATE public.workspaces SET acquisition_device = 'desktop'
 WHERE owner_id = 'a9000000-0000-0000-0000-000000000001'
   AND acquisition_device IS NULL;

SELECT is(
  (SELECT acquisition_device FROM public.workspaces
     WHERE owner_id = 'a9000000-0000-0000-0000-000000000001'),
  'mobile',
  '[device] a later stamp never overwrites the first one'
);

SELECT col_is_null(
  'public', 'workspaces', 'acquisition_device',
  '[device] the column is nullable: unknown is a legitimate answer'
);

SELECT * FROM finish();
ROLLBACK;
