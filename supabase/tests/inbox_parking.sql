-- ============================================================
-- public.inboxes.parked_at / parked_reason and the 'inbox_parked' rule pause
-- ============================================================
-- Covers 20261024173000_inbox_parking.sql.
--
--   - the columns exist and default to NULL (nothing is parked by the migration)
--   - the pair stays consistent: both NULL, or both set with a known reason
--   - members READ the columns (the dashboard shows parked inboxes) but cannot
--     WRITE them: unparking is server-owned, or a member could lift their own
--     plan's inbox cap
--   - triage_rules.paused_reason accepts 'plan_limit' and 'inbox_parked' only,
--     and an 'infinity' pause is never due under the dispatcher's predicate
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(16);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('fa100000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'parking-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.users (id, email, display_name) VALUES
  ('fa100000-0000-0000-0000-0000000000a1', 'parking-owner@rls-test.invalid', 'Owner')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('fa10aaaa-0000-0000-0000-00000000000a', 'parking-ws-a', 'Owner WS', 'fa100000-0000-0000-0000-0000000000a1', 'free')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('fa10aaaa-0000-0000-0000-00000000000a', 'fa100000-0000-0000-0000-0000000000a1', 'owner')
ON CONFLICT DO NOTHING;

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host, smtp_host) VALUES
  ('fa101111-0000-0000-0000-000000000001', 'fa10aaaa-0000-0000-0000-00000000000a',
   'imap', 'one@parking-test.invalid', 'active', 'imap.parking-test.invalid', 'smtp.parking-test.invalid'),
  ('fa101111-0000-0000-0000-000000000002', 'fa10aaaa-0000-0000-0000-00000000000a',
   'imap', 'two@parking-test.invalid', 'active', 'imap.parking-test.invalid', 'smtp.parking-test.invalid');

SELECT has_column('public', 'inboxes', 'parked_at', 'inboxes.parked_at exists');
SELECT has_column('public', 'inboxes', 'parked_reason', 'inboxes.parked_reason exists');
SELECT is(
  (SELECT count(*)::int FROM public.inboxes
    WHERE workspace_id = 'fa10aaaa-0000-0000-0000-00000000000a' AND parked_at IS NULL),
  2,
  'a new row is not parked');

-- The pair, as the table owner (what service_role writes as).
SELECT lives_ok(
  $$UPDATE public.inboxes SET parked_at = now(), parked_reason = 'plan_limit'
     WHERE id = 'fa101111-0000-0000-0000-000000000002'$$,
  'parking with the plan_limit reason is accepted');
SELECT lives_ok(
  $$UPDATE public.inboxes SET parked_at = NULL, parked_reason = NULL
     WHERE id = 'fa101111-0000-0000-0000-000000000002'$$,
  'unparking clears both columns');
SELECT throws_ok(
  $$UPDATE public.inboxes SET parked_at = now() WHERE id = 'fa101111-0000-0000-0000-000000000002'$$,
  '23514', NULL, 'parked_at without a reason is refused');
SELECT throws_ok(
  $$UPDATE public.inboxes SET parked_reason = 'plan_limit' WHERE id = 'fa101111-0000-0000-0000-000000000002'$$,
  '23514', NULL, 'a reason without parked_at is refused');
SELECT throws_ok(
  $$UPDATE public.inboxes SET parked_at = now(), parked_reason = 'because' WHERE id = 'fa101111-0000-0000-0000-000000000002'$$,
  '23514', NULL, 'an unknown reason is refused');

UPDATE public.inboxes SET parked_at = now(), parked_reason = 'plan_limit'
 WHERE id = 'fa101111-0000-0000-0000-000000000002';

-- A member reads the columns but cannot write them.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub": "fa100000-0000-0000-0000-0000000000a1", "role": "authenticated"}', true);
SELECT is(
  (SELECT parked_reason FROM public.inboxes WHERE id = 'fa101111-0000-0000-0000-000000000002'),
  'plan_limit',
  '[owner] reads parked_reason');
SELECT ok(
  (SELECT parked_at IS NOT NULL FROM public.inboxes WHERE id = 'fa101111-0000-0000-0000-000000000002'),
  '[owner] reads parked_at');
SELECT throws_ok(
  $$UPDATE public.inboxes SET parked_at = NULL, parked_reason = NULL WHERE id = 'fa101111-0000-0000-0000-000000000002'$$,
  '42501', NULL, '[owner] cannot unpark through PostgREST');
SELECT throws_ok(
  $$UPDATE public.inboxes SET parked_at = now(), parked_reason = 'plan_limit' WHERE id = 'fa101111-0000-0000-0000-000000000001'$$,
  '42501', NULL, '[owner] cannot park through PostgREST');
RESET ROLE;

-- triage_rules.paused_reason.
SELECT col_has_check('public', 'triage_rules', 'paused_reason', 'triage_rules.paused_reason has a CHECK');

INSERT INTO public.api_keys (id, workspace_id, name, key_hash, key_prefix, scopes)
VALUES ('fa10cccc-0000-0000-0000-00000000000c', 'fa10aaaa-0000-0000-0000-00000000000a',
        'parking key', 'parking-test-hash', 'mcpe_pk', ARRAY['read:email'])
ON CONFLICT DO NOTHING;

INSERT INTO public.triage_rules (id, workspace_id, inbox_id, api_key_id, name, enabled, filter, action, interval_minutes, next_run_at)
VALUES ('fa10dddd-0000-0000-0000-00000000000d', 'fa10aaaa-0000-0000-0000-00000000000a',
        'fa101111-0000-0000-0000-000000000002', 'fa10cccc-0000-0000-0000-00000000000c',
        'parking rule', true, '{}'::jsonb, '{"type":"mark_read"}'::jsonb, 60, now() - interval '1 minute');

SELECT lives_ok(
  $$UPDATE public.triage_rules SET paused_reason = 'inbox_parked', paused_until = 'infinity'
     WHERE id = 'fa10dddd-0000-0000-0000-00000000000d'$$,
  'an inbox_parked pause is accepted');
SELECT is(
  (SELECT count(*)::int FROM public.triage_rules
    WHERE id = 'fa10dddd-0000-0000-0000-00000000000d'
      AND (paused_until IS NULL OR paused_until <= now())),
  0,
  'an infinity pause is never due under the dispatcher predicate');
SELECT throws_ok(
  $$UPDATE public.triage_rules SET paused_reason = 'parked' WHERE id = 'fa10dddd-0000-0000-0000-00000000000d'$$,
  '23514', NULL, 'an unknown pause reason is refused');

SELECT * FROM finish();
ROLLBACK;
