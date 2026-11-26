-- ============================================================
-- Account email sync (20261126150000_sync_user_email_on_change.sql)
-- ============================================================
-- Proves:
--   1. A confirmed change of auth.users.email reaches public.users.email.
--   2. An auth update that leaves the email alone does not touch it.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(3);

INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES (
  'a9200000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'old@email-sync-test.invalid',
  'x', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'
);

SELECT is(
  (SELECT email FROM public.users WHERE id = 'a9200000-0000-0000-0000-000000000001'),
  'old@email-sync-test.invalid',
  '[email-sync] signup copies the address'
);

UPDATE auth.users SET email = 'new@email-sync-test.invalid'
 WHERE id = 'a9200000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT email FROM public.users WHERE id = 'a9200000-0000-0000-0000-000000000001'),
  'new@email-sync-test.invalid',
  '[email-sync] a changed account email reaches public.users'
);

UPDATE auth.users SET last_sign_in_at = now()
 WHERE id = 'a9200000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT email FROM public.users WHERE id = 'a9200000-0000-0000-0000-000000000001'),
  'new@email-sync-test.invalid',
  '[email-sync] other auth updates leave the address alone'
);

SELECT * FROM finish();
ROLLBACK;
