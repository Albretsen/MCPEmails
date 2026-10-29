-- ============================================================
-- Park on cancel and the parked-inbox swap (migration 20261025020000)
-- ============================================================
-- Pins: the park-on-end pair CHECK, and that an owner can neither clear their
-- own park-on-end marker nor reset their workspace's last swap time.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(6);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('fb300000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'park-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan, inbox_swapped_at) VALUES
  ('fb30aaaa-0000-0000-0000-00000000000a', 'park-ws-a', 'Park', 'fb300000-0000-0000-0000-0000000000a1', 'free', now())
ON CONFLICT DO NOTHING;

INSERT INTO public.user_billing (user_id, plan, subscription_status, park_on_end_subscription_id, park_on_end_marked_at)
VALUES ('fb300000-0000-0000-0000-0000000000a1', 'personal', 'active', 'sub_park_test', now())
ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan, subscription_status = EXCLUDED.subscription_status,
  park_on_end_subscription_id = EXCLUDED.park_on_end_subscription_id, park_on_end_marked_at = EXCLUDED.park_on_end_marked_at;

SELECT has_column('public', 'user_billing', 'park_on_end_subscription_id', 'user_billing.park_on_end_subscription_id exists');
SELECT has_column('public', 'workspaces', 'inbox_swapped_at', 'workspaces.inbox_swapped_at exists');
SELECT throws_ok(
  $$UPDATE public.user_billing SET park_on_end_marked_at = NULL WHERE user_id = 'fb300000-0000-0000-0000-0000000000a1'$$,
  '23514', NULL, 'a marker without its time is refused');

-- ── The owner cannot clear the marker or reset the swap clock ─────────────
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub": "fb300000-0000-0000-0000-0000000000a1", "role": "authenticated"}', true);
UPDATE public.user_billing SET park_on_end_subscription_id = NULL, park_on_end_marked_at = NULL
 WHERE user_id = 'fb300000-0000-0000-0000-0000000000a1';
SELECT throws_ok(
  $$UPDATE public.workspaces SET inbox_swapped_at = NULL WHERE id = 'fb30aaaa-0000-0000-0000-00000000000a'$$,
  '42501', NULL, '[owner] workspaces.inbox_swapped_at is not writable');
RESET ROLE;
SELECT is(
  (SELECT park_on_end_subscription_id FROM public.user_billing WHERE user_id = 'fb300000-0000-0000-0000-0000000000a1'),
  'sub_park_test',
  '[owner] an update of the park-on-end marker changes nothing');
SELECT ok(
  (SELECT inbox_swapped_at IS NOT NULL FROM public.workspaces WHERE id = 'fb30aaaa-0000-0000-0000-00000000000a'),
  'the swap time is still set');

SELECT * FROM finish();
ROLLBACK;
