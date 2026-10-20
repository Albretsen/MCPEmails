-- ============================================================
-- Independent verification of 20261016160400_scheduled_sends_writer_lockdown
-- ============================================================
-- Adversarial / regression checks the fixer's suite does not cover:
--   * the send_approvals.dispatch_scheduled_send_id BACKFILL binds each
--     approved approval to its legitimate (decide.ts) marker, never to a row in
--     another workspace, never to a not-yet-approved approval;
--   * re-running the migration (prod applies files by hand) is idempotent and
--     never re-binds an already-bound approval;
--   * legacy rows the trigger would refuse at INSERT time (pre-encryption
--     plaintext payloads, rows inserted through the old member policy) can
--     still be moved through every status the dispatcher / schedule_cancel
--     write (sending, sent, error with error_detail, cancelled, pending);
--   * deleting an inbox or workspace still cascades through scheduled_sends and
--     the new send_approvals FK;
--   * PostgREST-shaped attacks from a signed-in user (insert into another
--     workspace, viewer insert, member re-pointing via cancel UPDATE).
-- ============================================================

BEGIN;

SELECT plan(24);

-- ── Seed (postgres) ─────────────────────────────────────────────────────────

INSERT INTO auth.users (
  id, instance_id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('c6000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner@ss-verify.invalid',
   'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('c6000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'viewer@ss-verify.invalid',
   'x', now(), now(), now(), '{"provider":"email"}', '{}'),
  ('d6000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'attacker@ss-verify.invalid',
   'x', now(), now(), now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.users (id, email, display_name) VALUES
  ('c6000000-0000-0000-0000-000000000001', 'owner@ss-verify.invalid',    'Owner'),
  ('c6000000-0000-0000-0000-000000000002', 'viewer@ss-verify.invalid',   'Viewer'),
  ('d6000000-0000-0000-0000-000000000001', 'attacker@ss-verify.invalid', 'Attacker')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan) VALUES
  ('c6a00000-0000-0000-0000-000000000001', 'ss-verify-c', 'SS C',
   'c6000000-0000-0000-0000-000000000001', 'free'),
  ('d6a00000-0000-0000-0000-000000000001', 'ss-verify-d', 'SS D',
   'd6000000-0000-0000-0000-000000000001', 'free')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('c6a00000-0000-0000-0000-000000000001', 'c6000000-0000-0000-0000-000000000001', 'owner'),
  ('c6a00000-0000-0000-0000-000000000001', 'c6000000-0000-0000-0000-000000000002', 'viewer'),
  ('d6a00000-0000-0000-0000-000000000001', 'd6000000-0000-0000-0000-000000000001', 'owner')
ON CONFLICT DO NOTHING;

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status) VALUES
  ('c6100000-0000-0000-0000-000000000001', 'c6a00000-0000-0000-0000-000000000001',
   'imap', 'c1@ss-verify.invalid', 'active'),
  ('c6100000-0000-0000-0000-000000000002', 'c6a00000-0000-0000-0000-000000000001',
   'gmail', 'c2@ss-verify.invalid', 'active'),
  ('d6100000-0000-0000-0000-000000000001', 'd6a00000-0000-0000-0000-000000000001',
   'imap', 'd1@ss-verify.invalid', 'active')
ON CONFLICT DO NOTHING;

-- Approvals as production holds them before the migration.
--   E1: approved, decided 10:00:00; its decide.ts marker M1 at 10:00:01.
--   E2: approved, decided 11:00:00; legit marker M2 at 11:00:02, and an
--       attacker's cross-workspace marker X2 at exactly 11:00:00 (closer).
--   E3: approved, no decided_at (legacy), two markers; earliest wins.
--   E4: still pending, a forged marker exists: must NOT be bound.
--   E5: approved and already sent (marker status 'sent'): bound to it.
--   E6: approved in workspace C, but the only marker names inbox c2: not bound.
INSERT INTO public.send_approvals (id, workspace_id, inbox_id, operation, payload, status, decided_at) VALUES
  ('c6e00000-0000-0000-0000-000000000001', 'c6a00000-0000-0000-0000-000000000001',
   'c6100000-0000-0000-0000-000000000001', 'email_send', '{"v":1,"data":"x"}', 'approved', '2026-09-01 10:00:00+00'),
  ('c6e00000-0000-0000-0000-000000000002', 'c6a00000-0000-0000-0000-000000000001',
   'c6100000-0000-0000-0000-000000000001', 'email_reply', '{"v":1,"data":"x"}', 'approved', '2026-09-01 11:00:00+00'),
  ('c6e00000-0000-0000-0000-000000000003', 'c6a00000-0000-0000-0000-000000000001',
   'c6100000-0000-0000-0000-000000000001', 'email_send', '{"v":1,"data":"x"}', 'approved', NULL),
  ('c6e00000-0000-0000-0000-000000000004', 'c6a00000-0000-0000-0000-000000000001',
   'c6100000-0000-0000-0000-000000000001', 'email_send', '{"v":1,"data":"x"}', 'pending', NULL),
  ('c6e00000-0000-0000-0000-000000000005', 'c6a00000-0000-0000-0000-000000000001',
   'c6100000-0000-0000-0000-000000000001', 'draft_send', '{"v":1,"data":"x"}', 'approved', '2026-08-01 09:00:00+00'),
  ('c6e00000-0000-0000-0000-000000000006', 'c6a00000-0000-0000-0000-000000000001',
   'c6100000-0000-0000-0000-000000000001', 'email_send', '{"v":1,"data":"x"}', 'approved', '2026-09-02 09:00:00+00')
ON CONFLICT DO NOTHING;

-- Legacy rows the new trigger would refuse at INSERT, written the way the old
-- grants allowed: bypass triggers for the seed only.
UPDATE public.send_approvals SET dispatch_scheduled_send_id = NULL
WHERE id::text LIKE 'c6e00000-%';

SET LOCAL session_replication_role = replica;
INSERT INTO public.scheduled_sends (id, workspace_id, inbox_id, payload, payload_encrypted, send_at, status, created_at) VALUES
  ('c6c00000-0000-0000-0000-000000000001', 'c6a00000-0000-0000-0000-000000000001', 'c6100000-0000-0000-0000-000000000001',
   '{"approval_id":"c6e00000-0000-0000-0000-000000000001"}', false, now() + interval '1 day', 'pending', '2026-09-01 10:00:01+00'),
  ('c6c00000-0000-0000-0000-000000000002', 'c6a00000-0000-0000-0000-000000000001', 'c6100000-0000-0000-0000-000000000001',
   '{"approval_id":"c6e00000-0000-0000-0000-000000000002"}', false, now() + interval '1 day', 'pending', '2026-09-01 11:00:02+00'),
  -- X2: attacker workspace D, own inbox, names workspace C's approval
  ('d6c00000-0000-0000-0000-000000000002', 'd6a00000-0000-0000-0000-000000000001', 'd6100000-0000-0000-0000-000000000001',
   '{"approval_id":"c6e00000-0000-0000-0000-000000000002"}', false, now() + interval '1 day', 'pending', '2026-09-01 11:00:00+00'),
  ('c6c00000-0000-0000-0000-000000000031', 'c6a00000-0000-0000-0000-000000000001', 'c6100000-0000-0000-0000-000000000001',
   '{"approval_id":"c6e00000-0000-0000-0000-000000000003"}', false, now() + interval '1 day', 'pending', '2026-08-15 08:00:00+00'),
  ('c6c00000-0000-0000-0000-000000000032', 'c6a00000-0000-0000-0000-000000000001', 'c6100000-0000-0000-0000-000000000001',
   '{"approval_id":"c6e00000-0000-0000-0000-000000000003"}', false, now() + interval '1 day', 'pending', '2026-08-16 08:00:00+00'),
  ('c6c00000-0000-0000-0000-000000000004', 'c6a00000-0000-0000-0000-000000000001', 'c6100000-0000-0000-0000-000000000001',
   '{"approval_id":"c6e00000-0000-0000-0000-000000000004"}', false, now() + interval '1 day', 'pending', '2026-09-03 08:00:00+00'),
  ('c6c00000-0000-0000-0000-000000000005', 'c6a00000-0000-0000-0000-000000000001', 'c6100000-0000-0000-0000-000000000001',
   '{"approval_id":"c6e00000-0000-0000-0000-000000000005"}', false, now() - interval '30 days', 'sent', '2026-08-01 09:00:01+00'),
  ('c6c00000-0000-0000-0000-000000000006', 'c6a00000-0000-0000-0000-000000000001', 'c6100000-0000-0000-0000-000000000002',
   '{"approval_id":"c6e00000-0000-0000-0000-000000000006"}', false, now() + interval '1 day', 'pending', '2026-09-02 09:00:01+00'),
  -- L1: pre-encryption plaintext message payload, still pending
  ('c6c00000-0000-0000-0000-000000000099', 'c6a00000-0000-0000-0000-000000000001', 'c6100000-0000-0000-0000-000000000001',
   '{"to":["legacy@example.invalid"],"subject":"s","body":"b"}', false, now() - interval '1 minute', 'pending', '2026-06-01 00:00:00+00'),
  -- L2: a row the old member policy let a user point at ANOTHER workspace's inbox
  ('d6c00000-0000-0000-0000-000000000099', 'd6a00000-0000-0000-0000-000000000001', 'c6100000-0000-0000-0000-000000000001',
   '{"v":1,"data":"x"}', true, now() - interval '1 minute', 'pending', '2026-10-01 00:00:00+00')
ON CONFLICT DO NOTHING;
SET LOCAL session_replication_role = origin;

-- ── 1. Re-run the migration (as prod would, by hand) → backfill ─────────────

\ir fixtures/20261016160400_scheduled_sends_writer_lockdown.psql

SELECT is((SELECT dispatch_scheduled_send_id FROM public.send_approvals WHERE id = 'c6e00000-0000-0000-0000-000000000001'),
  'c6c00000-0000-0000-0000-000000000001'::uuid,
  'backfill binds an approved approval to its decide.ts marker');
SELECT is((SELECT dispatch_scheduled_send_id FROM public.send_approvals WHERE id = 'c6e00000-0000-0000-0000-000000000002'),
  'c6c00000-0000-0000-0000-000000000002'::uuid,
  'backfill ignores a closer-in-time marker from another workspace');
SELECT is((SELECT dispatch_scheduled_send_id FROM public.send_approvals WHERE id = 'c6e00000-0000-0000-0000-000000000003'),
  'c6c00000-0000-0000-0000-000000000031'::uuid,
  'backfill with no decided_at picks the earliest marker');
SELECT is((SELECT dispatch_scheduled_send_id FROM public.send_approvals WHERE id = 'c6e00000-0000-0000-0000-000000000004'),
  NULL::uuid,
  'backfill never binds a pending approval');
SELECT is((SELECT dispatch_scheduled_send_id FROM public.send_approvals WHERE id = 'c6e00000-0000-0000-0000-000000000005'),
  'c6c00000-0000-0000-0000-000000000005'::uuid,
  'backfill binds an already-sent approval to its sent marker (replay closed)');
SELECT is((SELECT dispatch_scheduled_send_id FROM public.send_approvals WHERE id = 'c6e00000-0000-0000-0000-000000000006'),
  NULL::uuid,
  'backfill never binds a marker whose inbox differs from the approval''s');

-- Re-run again: idempotent, and an existing binding is never moved.
UPDATE public.send_approvals SET dispatch_scheduled_send_id = 'c6c00000-0000-0000-0000-000000000032'
WHERE id = 'c6e00000-0000-0000-0000-000000000003';
\ir fixtures/20261016160400_scheduled_sends_writer_lockdown.psql
SELECT is((SELECT dispatch_scheduled_send_id FROM public.send_approvals WHERE id = 'c6e00000-0000-0000-0000-000000000003'),
  'c6c00000-0000-0000-0000-000000000032'::uuid,
  'a second run of the migration never re-binds an already-bound approval');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgname = 'scheduled_sends_enforce_integrity'), 1,
  'a second run leaves exactly one integrity trigger');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = 'scheduled_sends'), 2,
  'after re-runs scheduled_sends has exactly the select + cancel policies');

-- ── 2. Dispatcher / schedule_cancel writes on legacy rows (service role) ───

SET LOCAL ROLE service_role;

SELECT lives_ok(
  $$UPDATE public.scheduled_sends SET status = 'sending', updated_at = now()
    WHERE id = 'c6c00000-0000-0000-0000-000000000099' AND status = 'pending'$$,
  'dispatcher can claim a legacy plaintext row (pending -> sending)');
SELECT lives_ok(
  $$UPDATE public.scheduled_sends SET status = 'pending', error_detail = 'deferred, nothing was sent: x', updated_at = now()
    WHERE id = 'c6c00000-0000-0000-0000-000000000099'$$,
  'dispatcher can defer a legacy row back to pending with error_detail');
SELECT lives_ok(
  $$UPDATE public.scheduled_sends SET status = 'error', error_detail = 'Refused', updated_at = now()
    WHERE id = 'd6c00000-0000-0000-0000-000000000099'$$,
  'dispatcher can fail a legacy cross-workspace row (status-only update does not fire the trigger)');
SELECT lives_ok(
  $$UPDATE public.scheduled_sends SET status = 'sent', sent_at = now(), updated_at = now()
    WHERE id = 'c6c00000-0000-0000-0000-000000000001'$$,
  'dispatcher can mark an approval marker sent');
SELECT lives_ok(
  $$UPDATE public.scheduled_sends SET status = 'cancelled', updated_at = now()
    WHERE id = 'c6c00000-0000-0000-0000-000000000004' AND workspace_id = 'c6a00000-0000-0000-0000-000000000001' AND status = 'pending'$$,
  'schedule_cancel (service role) can cancel a marker whose approval is not approved');
SELECT lives_ok(
  $$UPDATE public.send_approvals SET dispatch_scheduled_send_id = 'c6c00000-0000-0000-0000-000000000006'
    WHERE id = 'c6e00000-0000-0000-0000-000000000006' AND dispatch_scheduled_send_id IS NULL$$,
  'dispatcher can claim an approval binding (null -> row id)');

-- ── 3. Signed-in attacker (owner of workspace D) over PostgREST ────────────

RESET ROLE;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"d6000000-0000-0000-0000-000000000001","role":"authenticated"}';

SELECT throws_ok(
  $$INSERT INTO public.scheduled_sends (workspace_id, inbox_id, payload, payload_encrypted, send_at)
    VALUES ('d6a00000-0000-0000-0000-000000000001', 'c6100000-0000-0000-0000-000000000001',
            '{"to":["x@evil.invalid"]}', false, now())$$,
  '42501', NULL,
  'an owner cannot insert a row naming another workspace''s inbox');
SELECT throws_ok(
  $$UPDATE public.scheduled_sends SET inbox_id = 'c6100000-0000-0000-0000-000000000001'
    WHERE id = 'd6c00000-0000-0000-0000-000000000002'$$,
  '42501', NULL,
  'an owner cannot re-point their own pending row at another tenant''s inbox');
-- Either refused by grant or filtered to zero rows by RLS; checked below.
DO $$ BEGIN
  UPDATE public.send_approvals SET dispatch_scheduled_send_id = NULL
  WHERE id = 'c6e00000-0000-0000-0000-000000000001';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
SELECT is_empty(
  $$SELECT 1 FROM public.send_approvals WHERE workspace_id = 'c6a00000-0000-0000-0000-000000000001'$$,
  'another workspace''s approvals stay invisible');
SELECT throws_ok(
  $$SELECT public.scheduled_sends_enforce_integrity()$$,
  '42501', NULL,
  'the trigger function is not callable over RPC');

-- ── 4. Viewer of workspace C ───────────────────────────────────────────────

SET LOCAL "request.jwt.claims" TO '{"sub":"c6000000-0000-0000-0000-000000000002","role":"authenticated"}';

SELECT throws_ok(
  $$INSERT INTO public.scheduled_sends (workspace_id, inbox_id, payload, payload_encrypted, send_at)
    VALUES ('c6a00000-0000-0000-0000-000000000001', 'c6100000-0000-0000-0000-000000000001',
            '{"v":1,"data":"x"}', true, now())$$,
  '42501', NULL,
  'a viewer cannot insert');
SELECT isnt_empty(
  $$SELECT dispatch_scheduled_send_id FROM public.send_approvals WHERE workspace_id = 'c6a00000-0000-0000-0000-000000000001'$$,
  'a workspace member can still select send_approvals including the new column (select * keeps working)');

-- ── 5. Cascades still work through the new FK ─────────────────────────────

RESET ROLE;

SELECT is((SELECT dispatch_scheduled_send_id FROM public.send_approvals WHERE id = 'c6e00000-0000-0000-0000-000000000001'),
  'c6c00000-0000-0000-0000-000000000001'::uuid,
  'a signed-in user (other tenant) cannot clear an approval binding');

SELECT lives_ok(
  $$DELETE FROM public.inboxes WHERE id = 'c6100000-0000-0000-0000-000000000001'$$,
  'deleting an inbox cascades through scheduled_sends and the approval binding');
SELECT lives_ok(
  $$DELETE FROM public.workspaces WHERE id = 'd6a00000-0000-0000-0000-000000000001'$$,
  'deleting a workspace still cascades');

SELECT * FROM finish();
ROLLBACK;
