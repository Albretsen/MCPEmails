-- ============================================================
-- send_approvals.revision (approval bound to what the reviewer saw)
-- ============================================================
-- Covers migration 20261016160600_send_approval_revision:
--   - new rows start at revision 1
--   - every change to what a reviewer is shown (payload, summary, send_at)
--     bumps the revision, whoever writes it
--   - a decision (status / decided_*) does not bump it
--   - a writer cannot set the counter by hand (not backwards, not forwards)
--   - the approve claim the web app runs (UPDATE ... WHERE revision = <rendered>)
--     matches nothing for a stale revision and the row for the current one
--   - a workspace member can still read the row and its revision; a browser
--     session still cannot write it
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(13);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('e1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'apprev-owner@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('ea000000-0000-0000-0000-00000000000a', 'apprev-a', 'Approval revision A', 'e1000000-0000-0000-0000-000000000001', 'solo');

INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES ('ea000000-0000-0000-0000-00000000000a', 'e1000000-0000-0000-0000-000000000001', 'owner');

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host)
VALUES ('e0000000-0000-0000-0000-0000000000a1', 'ea000000-0000-0000-0000-00000000000a', 'imap',
        'a1@apprev-test.invalid', 'active', 'imap.apprev-test.invalid');

INSERT INTO public.api_keys (id, workspace_id, created_by, name, key_prefix, key_hash, scopes)
VALUES ('eb000000-0000-0000-0000-0000000000a1', 'ea000000-0000-0000-0000-00000000000a',
        'e1000000-0000-0000-0000-000000000001', 'Key A', 'mcpe_test', 'apprev-hash-a', '{send:email}');

INSERT INTO public.send_approvals (id, workspace_id, inbox_id, api_key_id, operation, payload, summary, status)
VALUES ('ec000000-0000-0000-0000-000000000001', 'ea000000-0000-0000-0000-00000000000a',
        'e0000000-0000-0000-0000-0000000000a1', 'eb000000-0000-0000-0000-0000000000a1',
        'email_send', '{"v":1,"data":"cipher-1"}', '{"subject":"Hello"}', 'pending');

-- ------------------------------------------------------------
-- 1. Starts at 1
-- ------------------------------------------------------------
SELECT is(
  (SELECT revision FROM public.send_approvals WHERE id = 'ec000000-0000-0000-0000-000000000001'),
  1, 'a new approval starts at revision 1');

-- ------------------------------------------------------------
-- 2. Content changes bump it
-- ------------------------------------------------------------
UPDATE public.send_approvals SET payload = '{"v":1,"data":"cipher-2"}'
  WHERE id = 'ec000000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT revision FROM public.send_approvals WHERE id = 'ec000000-0000-0000-0000-000000000001'),
  2, 'rewriting the payload (approval_update) bumps the revision');

UPDATE public.send_approvals SET summary = '{"subject":"Changed"}'
  WHERE id = 'ec000000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT revision FROM public.send_approvals WHERE id = 'ec000000-0000-0000-0000-000000000001'),
  3, 'changing the summary bumps the revision');

UPDATE public.send_approvals SET send_at = now() + interval '1 day'
  WHERE id = 'ec000000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT revision FROM public.send_approvals WHERE id = 'ec000000-0000-0000-0000-000000000001'),
  4, 'moving the delivery time (approval_schedule) bumps the revision');

UPDATE public.send_approvals SET summary = summary
  WHERE id = 'ec000000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT revision FROM public.send_approvals WHERE id = 'ec000000-0000-0000-0000-000000000001'),
  4, 'a write that changes nothing a reviewer sees does not bump it');

-- ------------------------------------------------------------
-- 3. The counter cannot be set by hand
-- ------------------------------------------------------------
UPDATE public.send_approvals SET revision = 1
  WHERE id = 'ec000000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT revision FROM public.send_approvals WHERE id = 'ec000000-0000-0000-0000-000000000001'),
  4, 'the revision cannot be wound back to match a stale review');

UPDATE public.send_approvals SET payload = '{"v":1,"data":"cipher-3"}', revision = 4
  WHERE id = 'ec000000-0000-0000-0000-000000000001';
SELECT is(
  (SELECT revision FROM public.send_approvals WHERE id = 'ec000000-0000-0000-0000-000000000001'),
  5, 'a content write that also names the old revision still bumps it');

-- ------------------------------------------------------------
-- 4. The approve claim
-- ------------------------------------------------------------
WITH claimed AS (
  UPDATE public.send_approvals SET status = 'approved', decided_at = now()
  WHERE id = 'ec000000-0000-0000-0000-000000000001' AND status = 'pending' AND revision = 1
  RETURNING id
)
SELECT is((SELECT count(*)::int FROM claimed), 0, 'approving a stale revision claims nothing');

SELECT is(
  (SELECT status FROM public.send_approvals WHERE id = 'ec000000-0000-0000-0000-000000000001'),
  'pending', 'and the request stays pending');

WITH claimed AS (
  UPDATE public.send_approvals SET status = 'approved', decided_at = now()
  WHERE id = 'ec000000-0000-0000-0000-000000000001' AND status = 'pending' AND revision = 5
  RETURNING id
)
SELECT is((SELECT count(*)::int FROM claimed), 1, 'approving the current revision claims the row');

SELECT is(
  (SELECT revision FROM public.send_approvals WHERE id = 'ec000000-0000-0000-0000-000000000001'),
  5, 'a decision does not bump the revision');

-- ------------------------------------------------------------
-- 5. Legitimate access is unchanged
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"e1000000-0000-0000-0000-000000000001","role":"authenticated"}', true);

SELECT is(
  (SELECT revision FROM public.send_approvals WHERE id = 'ec000000-0000-0000-0000-000000000001'),
  5, 'a workspace member still reads the approval, revision included');

-- No UPDATE policy exists, so this matches no row (or, without the grant, is
-- refused outright). Either way nothing changes.
DO $$
BEGIN
  UPDATE public.send_approvals SET status = 'pending', payload = '{"v":1,"data":"evil"}'
    WHERE id = 'ec000000-0000-0000-0000-000000000001';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END
$$;
RESET ROLE;
SELECT is(
  (SELECT payload->>'data' FROM public.send_approvals WHERE id = 'ec000000-0000-0000-0000-000000000001'),
  'cipher-3', 'a browser session still cannot rewrite an approval');

SELECT * FROM finish();
ROLLBACK;
