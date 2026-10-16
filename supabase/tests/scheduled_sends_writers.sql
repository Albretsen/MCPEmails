-- ============================================================
-- scheduled_sends: who may write, and what any writer may write
-- (migration 20261016160400_scheduled_sends_writer_lockdown, finding F-04-01)
-- ============================================================
-- Proves the hole is closed:
--   * no anon/authenticated INSERT (grant AND policy gone);
--   * a user client may only flip a PENDING row of a workspace it OPERATES
--     (owner/admin/member) to 'cancelled', touching status/updated_at only;
--   * viewers cannot cancel;
--   * for every writer, service role included, inbox_id must belong to
--     workspace_id, a plaintext payload must be an approval marker, and the
--     marker must name an APPROVED approval of the same workspace and inbox.
-- And that legitimate writes still work:
--   * service-role encrypted inserts (schedule_create) and approval markers
--     (lib/approvals/decide.ts);
--   * an operator cancelling a pending row.
-- ============================================================

BEGIN;

SELECT plan(26);

-- ── Seed (postgres) ─────────────────────────────────────────────────────────

INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('a5000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner@ss-writers.invalid',
   'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('a5000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'viewer@ss-writers.invalid',
   'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('a5000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'member@ss-writers.invalid',
   'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('b5000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'other@ss-writers.invalid',
   'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.users (id, email, display_name) VALUES
  ('a5000000-0000-0000-0000-000000000001', 'owner@ss-writers.invalid',  'Owner'),
  ('a5000000-0000-0000-0000-000000000002', 'viewer@ss-writers.invalid', 'Viewer'),
  ('a5000000-0000-0000-0000-000000000003', 'member@ss-writers.invalid', 'Member'),
  ('b5000000-0000-0000-0000-000000000001', 'other@ss-writers.invalid',  'Other')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('a5a00000-0000-0000-0000-000000000001', 'ss-writers-a', 'SS A',
   'a5000000-0000-0000-0000-000000000001', 'free'),
  ('b5b00000-0000-0000-0000-000000000001', 'ss-writers-b', 'SS B',
   'b5000000-0000-0000-0000-000000000001', 'free')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('a5a00000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000001', 'owner'),
  ('a5a00000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000002', 'viewer'),
  ('a5a00000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000003', 'member'),
  ('b5b00000-0000-0000-0000-000000000001', 'b5000000-0000-0000-0000-000000000001', 'owner')
ON CONFLICT DO NOTHING;

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status) VALUES
  ('a5100000-0000-0000-0000-000000000001', 'a5a00000-0000-0000-0000-000000000001',
   'imap', 'a1@ss-writers.invalid', 'active'),
  ('a5100000-0000-0000-0000-000000000002', 'a5a00000-0000-0000-0000-000000000001',
   'imap', 'a2@ss-writers.invalid', 'active'),
  ('b5100000-0000-0000-0000-000000000001', 'b5b00000-0000-0000-0000-000000000001',
   'imap', 'b1@ss-writers.invalid', 'active')
ON CONFLICT DO NOTHING;

INSERT INTO public.send_approvals (id, workspace_id, inbox_id, operation, payload, status) VALUES
  ('a5e00000-0000-0000-0000-000000000001', 'a5a00000-0000-0000-0000-000000000001',
   'a5100000-0000-0000-0000-000000000001', 'email_send', '{"v":1,"data":"x"}', 'approved'),
  ('a5e00000-0000-0000-0000-000000000002', 'a5a00000-0000-0000-0000-000000000001',
   'a5100000-0000-0000-0000-000000000001', 'email_send', '{"v":1,"data":"x"}', 'pending')
ON CONFLICT DO NOTHING;

INSERT INTO public.scheduled_sends (id, workspace_id, inbox_id, payload, payload_encrypted, send_at, status) VALUES
  -- pending, workspace A: the owner cancels it
  ('a5c00000-0000-0000-0000-000000000001', 'a5a00000-0000-0000-0000-000000000001',
   'a5100000-0000-0000-0000-000000000001', '{"v":1,"data":"x"}', true, now() + interval '1 day', 'pending'),
  -- pending, workspace A: the viewer cannot, the member can
  ('a5c00000-0000-0000-0000-000000000002', 'a5a00000-0000-0000-0000-000000000001',
   'a5100000-0000-0000-0000-000000000001', '{"v":1,"data":"x"}', true, now() + interval '1 day', 'pending'),
  -- already sent, workspace A: not cancellable
  ('a5c00000-0000-0000-0000-000000000003', 'a5a00000-0000-0000-0000-000000000001',
   'a5100000-0000-0000-0000-000000000001', '{"v":1,"data":"x"}', true, now() - interval '1 day', 'sent'),
  -- pending, workspace B
  ('b5c00000-0000-0000-0000-000000000001', 'b5b00000-0000-0000-0000-000000000001',
   'b5100000-0000-0000-0000-000000000001', '{"v":1,"data":"x"}', true, now() + interval '1 day', 'pending')
ON CONFLICT DO NOTHING;

-- ── 1. Grants and policies ─────────────────────────────────────────────────

SELECT ok(NOT has_table_privilege('authenticated', 'public.scheduled_sends', 'INSERT'),
  'authenticated has no INSERT on scheduled_sends');
SELECT ok(NOT has_table_privilege('anon', 'public.scheduled_sends', 'INSERT'),
  'anon has no INSERT on scheduled_sends');
SELECT ok(NOT has_table_privilege('anon', 'public.scheduled_sends', 'UPDATE')
          AND NOT has_column_privilege('anon', 'public.scheduled_sends', 'status', 'UPDATE'),
  'anon has no UPDATE on scheduled_sends');
SELECT ok(NOT has_column_privilege('authenticated', 'public.scheduled_sends', 'payload', 'UPDATE')
          AND NOT has_column_privilege('authenticated', 'public.scheduled_sends', 'inbox_id', 'UPDATE')
          AND NOT has_column_privilege('authenticated', 'public.scheduled_sends', 'workspace_id', 'UPDATE')
          AND NOT has_column_privilege('authenticated', 'public.scheduled_sends', 'send_at', 'UPDATE')
          AND NOT has_column_privilege('authenticated', 'public.scheduled_sends', 'payload_encrypted', 'UPDATE'),
  'authenticated cannot UPDATE payload/inbox/workspace/send_at/payload_encrypted');
SELECT ok(has_column_privilege('authenticated', 'public.scheduled_sends', 'status', 'UPDATE'),
  'authenticated keeps UPDATE on status (cancel)');
SELECT ok(has_table_privilege('service_role', 'public.scheduled_sends', 'INSERT')
          AND has_table_privilege('service_role', 'public.scheduled_sends', 'UPDATE'),
  'service_role keeps INSERT and UPDATE');
SELECT is_empty(
  $$SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'scheduled_sends'
      AND policyname = 'scheduled_sends_insert_members'$$,
  'the member INSERT policy is gone');
SELECT has_column('public', 'send_approvals', 'dispatch_scheduled_send_id',
  'send_approvals.dispatch_scheduled_send_id exists (single-use dispatch binding)');

-- ── 2. Owner of workspace A ────────────────────────────────────────────────

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"a5000000-0000-0000-0000-000000000001","role":"authenticated"}';

SELECT throws_ok(
  $$INSERT INTO public.scheduled_sends (workspace_id, inbox_id, payload, payload_encrypted, send_at)
    VALUES ('a5a00000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000001',
            '{"to":["x@evil.invalid"],"subject":"s","body":"b"}', false, now())$$,
  '42501', NULL,
  'a member cannot INSERT a scheduled send into their own workspace');

SELECT throws_ok(
  $$INSERT INTO public.scheduled_sends (workspace_id, inbox_id, payload, payload_encrypted, send_at)
    VALUES ('a5a00000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000001',
            '{"approval_id":"a5e00000-0000-0000-0000-000000000001"}', false, now())$$,
  '42501', NULL,
  'a member cannot INSERT an approval marker (replay)');

SELECT throws_ok(
  $$UPDATE public.scheduled_sends SET payload = '{"to":["x@evil.invalid"]}'
    WHERE id = 'a5c00000-0000-0000-0000-000000000001'$$,
  '42501', NULL,
  'a member cannot rewrite the payload of a pending send');

SELECT throws_ok(
  $$UPDATE public.scheduled_sends SET send_at = now()
    WHERE id = 'a5c00000-0000-0000-0000-000000000001'$$,
  '42501', NULL,
  'a member cannot move send_at');

SELECT throws_ok(
  $$UPDATE public.scheduled_sends SET status = 'pending'
    WHERE id = 'a5c00000-0000-0000-0000-000000000001'$$,
  '42501', NULL,
  'a member can only set status to cancelled');

SELECT is_empty(
  $$UPDATE public.scheduled_sends SET status = 'cancelled'
    WHERE id = 'a5c00000-0000-0000-0000-000000000003' RETURNING id$$,
  'a sent row cannot be cancelled');

SELECT is_empty(
  $$UPDATE public.scheduled_sends SET status = 'cancelled'
    WHERE id = 'b5c00000-0000-0000-0000-000000000001' RETURNING id$$,
  'another workspace''s row cannot be cancelled');

SELECT results_eq(
  $$UPDATE public.scheduled_sends SET status = 'cancelled', updated_at = now()
    WHERE id = 'a5c00000-0000-0000-0000-000000000001' RETURNING id$$,
  $$VALUES ('a5c00000-0000-0000-0000-000000000001'::uuid)$$,
  'the owner can still cancel a pending send');

-- ── 3. Viewer of workspace A ───────────────────────────────────────────────

SET LOCAL "request.jwt.claims" TO '{"sub":"a5000000-0000-0000-0000-000000000002","role":"authenticated"}';

SELECT is_empty(
  $$UPDATE public.scheduled_sends SET status = 'cancelled'
    WHERE id = 'a5c00000-0000-0000-0000-000000000002' RETURNING id$$,
  'a viewer (read-only) cannot cancel');

SELECT isnt_empty(
  $$SELECT id FROM public.scheduled_sends WHERE id = 'a5c00000-0000-0000-0000-000000000002'$$,
  'a viewer can still read the workspace''s scheduled sends');

-- ── 4. Member of workspace A ───────────────────────────────────────────────

SET LOCAL "request.jwt.claims" TO '{"sub":"a5000000-0000-0000-0000-000000000003","role":"authenticated"}';

SELECT results_eq(
  $$UPDATE public.scheduled_sends SET status = 'cancelled'
    WHERE id = 'a5c00000-0000-0000-0000-000000000002' RETURNING id$$,
  $$VALUES ('a5c00000-0000-0000-0000-000000000002'::uuid)$$,
  'a member can cancel a pending send');

-- ── 5. Row integrity for every writer (service role) ──────────────────────

RESET ROLE;
SET LOCAL ROLE service_role;

SELECT throws_ok(
  $$INSERT INTO public.scheduled_sends (workspace_id, inbox_id, payload, payload_encrypted, send_at)
    VALUES ('a5a00000-0000-0000-0000-000000000001', 'b5100000-0000-0000-0000-000000000001',
            '{"v":1,"data":"x"}', true, now())$$,
  '23514', NULL,
  'inbox_id must belong to workspace_id, even for service role');

SELECT throws_ok(
  $$INSERT INTO public.scheduled_sends (workspace_id, inbox_id, payload, payload_encrypted, send_at)
    VALUES ('a5a00000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000001',
            '{"to":["x@example.invalid"],"subject":"s","body":"b"}', false, now())$$,
  '23514', NULL,
  'a plaintext payload that is not an approval marker is refused');

SELECT throws_ok(
  $$INSERT INTO public.scheduled_sends (workspace_id, inbox_id, payload, payload_encrypted, send_at)
    VALUES ('a5a00000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000001',
            '{"approval_id":"a5e00000-0000-0000-0000-000000000002"}', false, now())$$,
  '23514', NULL,
  'a marker for a not-yet-approved approval is refused');

SELECT throws_ok(
  $$INSERT INTO public.scheduled_sends (workspace_id, inbox_id, payload, payload_encrypted, send_at)
    VALUES ('a5a00000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000002',
            '{"approval_id":"a5e00000-0000-0000-0000-000000000001"}', false, now())$$,
  '23514', NULL,
  'a marker whose approval belongs to a different inbox is refused');

SELECT throws_ok(
  $$UPDATE public.scheduled_sends SET inbox_id = 'b5100000-0000-0000-0000-000000000001'
    WHERE id = 'a5c00000-0000-0000-0000-000000000003'$$,
  '23514', NULL,
  'an UPDATE cannot re-point a row at another workspace''s inbox');

SELECT lives_ok(
  $$INSERT INTO public.scheduled_sends (workspace_id, inbox_id, payload, payload_encrypted, send_at)
    VALUES ('a5a00000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000001',
            '{"approval_id":"a5e00000-0000-0000-0000-000000000001"}', false, now())$$,
  'the approve decision''s marker (decide.ts) still inserts');

SELECT lives_ok(
  $$INSERT INTO public.scheduled_sends (workspace_id, inbox_id, payload, payload_encrypted, send_at)
    VALUES ('a5a00000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000001',
            '{"v":1,"data":"ciphertext"}', true, now() + interval '1 hour')$$,
  'schedule_create''s encrypted row still inserts');

SELECT * FROM finish();
ROLLBACK;
