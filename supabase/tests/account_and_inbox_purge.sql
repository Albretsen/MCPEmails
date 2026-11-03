-- ============================================================
-- 30-day purge of deleted accounts and disconnected inboxes
-- (migration 20261030130000_account_and_inbox_purge)
-- ============================================================
--   * the auth.users app_metadata stamp reaches public.users.deleted_at, and
--     removing it (an undo by hand) clears it; a browser session cannot set it;
--   * dry run (the default) counts and logs, and erases nothing;
--   * a real run erases an account deleted 40 days ago: activity log, auth log,
--     workspaces, inboxes, queued mail, the auth user; scrubs its support
--     ticket; writes one anonymous tally row;
--   * it leaves alone an account deleted 10 days ago and a restored account;
--   * signup_scoreboard() total does not drop;
--   * disconnected inboxes go after 30 days, not before, and not in dry run.
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(24);

-- ── Seed ────────────────────────────────────────────────────────────────────
-- p1: deleted 40 days ago (purged)      p2: deleted 10 days ago (kept)
-- p3: deleted 40 days ago, restored (still a member somewhere: kept)
-- p4: live, owns a workspace with disconnected inboxes

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('a8000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'gone@purge.invalid', 'x', now(), now() - interval '200 days', now(), '{"provider":"email"}', '{}'),
  ('a8000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'recent@purge.invalid', 'x', now(), now() - interval '100 days', now(), '{"provider":"email"}', '{}'),
  ('a8000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'restored@purge.invalid', 'x', now(), now() - interval '100 days', now(), '{"provider":"email"}', '{}'),
  ('a8000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'live@purge.invalid', 'x', now(), now() - interval '100 days', now(), '{"provider":"email"}', '{}')
ON CONFLICT DO NOTHING;

INSERT INTO public.users (id, email, display_name, created_at) VALUES
  ('a8000000-0000-0000-0000-000000000001', 'gone@purge.invalid', 'Gone', now() - interval '200 days'),
  ('a8000000-0000-0000-0000-000000000002', 'recent@purge.invalid', 'Recent', now() - interval '100 days'),
  ('a8000000-0000-0000-0000-000000000003', 'restored@purge.invalid', 'Restored', now() - interval '100 days'),
  ('a8000000-0000-0000-0000-000000000004', 'live@purge.invalid', 'Live', now() - interval '100 days')
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan, deleted_at) VALUES
  ('a8a00000-0000-0000-0000-000000000001', 'purge-gone', 'Gone WS', 'a8000000-0000-0000-0000-000000000001', 'free', now() - interval '40 days'),
  ('a8a00000-0000-0000-0000-000000000004', 'purge-live', 'Live WS', 'a8000000-0000-0000-0000-000000000004', 'free', NULL)
ON CONFLICT DO NOTHING;

-- p3 is still a member of p4's workspace.
INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('a8a00000-0000-0000-0000-000000000004', 'a8000000-0000-0000-0000-000000000004', 'owner'),
  ('a8a00000-0000-0000-0000-000000000004', 'a8000000-0000-0000-0000-000000000003', 'member')
ON CONFLICT DO NOTHING;

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, deleted_at) VALUES
  ('a8100000-0000-0000-0000-000000000001', 'a8a00000-0000-0000-0000-000000000001', 'imap', 'g1@purge.invalid', 'revoked', now() - interval '40 days'),
  ('a8100000-0000-0000-0000-000000000041', 'a8a00000-0000-0000-0000-000000000004', 'imap', 'old@purge.invalid', 'revoked', now() - interval '40 days'),
  ('a8100000-0000-0000-0000-000000000042', 'a8a00000-0000-0000-0000-000000000004', 'imap', 'new@purge.invalid', 'revoked', now() - interval '10 days'),
  ('a8100000-0000-0000-0000-000000000043', 'a8a00000-0000-0000-0000-000000000004', 'imap', 'live@purge.invalid', 'active', NULL)
ON CONFLICT DO NOTHING;

INSERT INTO public.activity_log (workspace_id, inbox_id, tool_name, status, created_at) VALUES
  ('a8a00000-0000-0000-0000-000000000001', 'a8100000-0000-0000-0000-000000000001', 'email_search', 'success', now() - interval '50 days'),
  ('a8a00000-0000-0000-0000-000000000004', 'a8100000-0000-0000-0000-000000000041', 'email_search', 'success', now() - interval '50 days');

INSERT INTO public.auth_logs (user_id, workspace_id, event_type) VALUES
  ('a8000000-0000-0000-0000-000000000001', 'a8a00000-0000-0000-0000-000000000001', 'token_refreshed');

INSERT INTO public.support_tickets (id, user_id, email, category, subject, message, source) VALUES
  ('a8f00000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000001', 'gone@purge.invalid',
   'connect', 'Cannot connect', 'My password is hunter2.', 'form_signed_in');

-- What DELETE /api/user/delete-account leaves behind for p1 and p2 (and for
-- p3 before it was restored): every owned workspace soft-deleted, including
-- the one signup provisions, and no membership anywhere.
UPDATE public.workspaces SET deleted_at = coalesce(deleted_at, now() - interval '40 days')
WHERE owner_id IN ('a8000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000002',
                   'a8000000-0000-0000-0000-000000000003');
DELETE FROM public.workspace_members
WHERE user_id IN ('a8000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000002')
   OR (user_id = 'a8000000-0000-0000-0000-000000000003' AND workspace_id <> 'a8a00000-0000-0000-0000-000000000004');

-- ── 1. The deleted_at stamp ─────────────────────────────────────────────────

UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data || jsonb_build_object('deleted_at', (now() - interval '40 days')::text)
WHERE id IN ('a8000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000003');
UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data || jsonb_build_object('deleted_at', (now() - interval '10 days')::text)
WHERE id = 'a8000000-0000-0000-0000-000000000002';

SELECT ok((SELECT deleted_at < now() - interval '39 days' FROM public.users WHERE id = 'a8000000-0000-0000-0000-000000000001'),
  'the app_metadata stamp reaches public.users.deleted_at');

UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data - 'deleted_at'
WHERE id = 'a8000000-0000-0000-0000-000000000003';
SELECT is((SELECT deleted_at FROM public.users WHERE id = 'a8000000-0000-0000-0000-000000000003'),
  NULL::timestamptz, 'removing the stamp (an undo by hand) clears it');
-- Put it back: the membership alone must keep p3 safe.
UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data || jsonb_build_object('deleted_at', (now() - interval '40 days')::text)
WHERE id = 'a8000000-0000-0000-0000-000000000003';

SELECT throws_ok($$
  SET LOCAL request.jwt.claim.sub = 'a8000000-0000-0000-0000-000000000004';
  SET LOCAL request.jwt.claims = '{"sub":"a8000000-0000-0000-0000-000000000004","role":"authenticated"}';
  SET LOCAL ROLE authenticated;
  UPDATE public.users SET deleted_at = now() WHERE id = 'a8000000-0000-0000-0000-000000000004';
$$, '42501', NULL, 'a browser session cannot stamp deleted_at');
RESET ROLE;

-- ── 2. Dry run (the default) ────────────────────────────────────────────────

SELECT is((SELECT dry_run FROM public.retention_purge_settings), true, 'ships in dry run');

CREATE TEMP TABLE before_score AS SELECT total, internal_excluded FROM public.signup_scoreboard();

SELECT is((public.purge_deleted_accounts() ->> 'candidates')::int >= 1, true, 'dry run finds the account');
SELECT is((SELECT count(*)::int FROM auth.users WHERE id = 'a8000000-0000-0000-0000-000000000001'),
  1, 'dry run erases nothing');
SELECT is((public.purge_disconnected_inboxes() ->> 'purged')::int, 0, 'dry run deletes no inbox');
SELECT is((SELECT count(*)::int FROM public.system_events
           WHERE event_type IN ('retention.account_purge', 'retention.inbox_purge')
             AND (payload ->> 'dry_run')::boolean), 2, 'both dry runs are logged');

-- ── 3. Real run ─────────────────────────────────────────────────────────────

UPDATE public.retention_purge_settings SET dry_run = false;

SELECT lives_ok($$ SELECT public.purge_deleted_accounts() $$, 'the account purge runs');

SELECT is((SELECT count(*)::int FROM auth.users WHERE id = 'a8000000-0000-0000-0000-000000000001'), 0, 'the auth user is gone');
SELECT is((SELECT count(*)::int FROM public.users WHERE id = 'a8000000-0000-0000-0000-000000000001'), 0, 'public.users follows');
SELECT is((SELECT count(*)::int FROM public.workspaces WHERE id = 'a8a00000-0000-0000-0000-000000000001'), 0, 'its workspace is gone');
SELECT is((SELECT count(*)::int FROM public.inboxes WHERE id = 'a8100000-0000-0000-0000-000000000001'), 0, 'its inbox is gone');
SELECT is((SELECT count(*)::int FROM public.activity_log WHERE workspace_id = 'a8a00000-0000-0000-0000-000000000001'), 0, 'its activity log is gone');
SELECT is((SELECT count(*)::int FROM public.auth_logs WHERE workspace_id = 'a8a00000-0000-0000-0000-000000000001'
             OR user_id = 'a8000000-0000-0000-0000-000000000001'), 0, 'its auth log is gone');
SELECT is((SELECT email || '|' || subject || '|' || message FROM public.support_tickets WHERE id = 'a8f00000-0000-0000-0000-000000000001'),
  'deleted@invalid|[deleted]|[deleted]', 'its support ticket is scrubbed, the ref stays');
SELECT is((SELECT count(*)::int FROM public.deleted_account_tally WHERE deleted_at < now() - interval '39 days'), 1, 'one tally row');

SELECT is((SELECT count(*)::int FROM public.users WHERE id = 'a8000000-0000-0000-0000-000000000002'), 1, 'an account deleted 10 days ago stays');
SELECT is((SELECT count(*)::int FROM public.users WHERE id = 'a8000000-0000-0000-0000-000000000003'), 1, 'a restored account (still a member) stays');

SELECT is((SELECT total FROM public.signup_scoreboard()), (SELECT total FROM before_score), 'the signup total does not drop');

-- ── 4. Disconnected inboxes ─────────────────────────────────────────────────

SELECT lives_ok($$ SELECT public.purge_disconnected_inboxes() $$, 'the inbox purge runs');
SELECT is((SELECT count(*)::int FROM public.inboxes WHERE id = 'a8100000-0000-0000-0000-000000000041'), 0, 'an inbox disconnected 40 days ago is gone');
SELECT is((SELECT count(*)::int FROM public.inboxes
           WHERE id IN ('a8100000-0000-0000-0000-000000000042', 'a8100000-0000-0000-0000-000000000043')), 2,
  'one disconnected 10 days ago and a live one stay');

SELECT ok(NOT has_function_privilege('authenticated', 'public.purge_deleted_accounts()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.purge_disconnected_inboxes()', 'EXECUTE')
          AND NOT has_table_privilege('authenticated', 'public.deleted_account_tally', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.retention_purge_settings', 'UPDATE'),
  'no API role can run the purges or read their tables');

SELECT * FROM finish();
ROLLBACK;
