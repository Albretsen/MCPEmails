-- ============================================================
-- Draft lineage (mcp-server stale draft id resolution)
-- ============================================================
-- Covers migration 20261013120000_draft_lineage:
--   - the upsert key the edge function relies on: one row per (inbox, draft id)
--   - the column constraints that keep the table to ids and bookkeeping
--   - no column that could hold mail content
--   - service-role only: a browser session can neither read nor write it
--   - deleting the inbox removes its rows
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(12);

INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) VALUES
  ('e1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'lineage-alice@rls-test.invalid', 'x', now(), now(), now(), '{"provider":"email"}', '{}');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('ea000000-0000-0000-0000-00000000000a', 'lineage-a', 'Lineage A', 'e1000000-0000-0000-0000-000000000001', 'solo');

INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES ('ea000000-0000-0000-0000-00000000000a', 'e1000000-0000-0000-0000-000000000001', 'owner');

INSERT INTO public.inboxes (id, workspace_id, provider, email_address, status, imap_host)
VALUES
  ('e0000000-0000-0000-0000-0000000000a1', 'ea000000-0000-0000-0000-00000000000a', 'imap', 'a1@lineage-test.invalid', 'active', 'imap.lineage-test.invalid'),
  ('e0000000-0000-0000-0000-0000000000a2', 'ea000000-0000-0000-0000-00000000000a', 'imap', 'a2@lineage-test.invalid', 'active', 'imap.lineage-test.invalid');

-- A line of two ids, as two IMAP saves leave it.
INSERT INTO public.draft_lineage (workspace_id, inbox_id, line_id, draft_id, revision, written_by)
VALUES
  ('ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a1',
   'e5000000-0000-0000-0000-000000000001', 'Drafts:101', 1, 'agent'),
  ('ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a1',
   'e5000000-0000-0000-0000-000000000001', 'Drafts:102', 2, 'user');

-- ------------------------------------------------------------
-- 1. The upsert key
-- ------------------------------------------------------------
SELECT throws_ok(
  $$INSERT INTO public.draft_lineage (workspace_id, inbox_id, line_id, draft_id, revision, written_by)
    VALUES ('ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a1',
            'e5000000-0000-0000-0000-000000000002', 'Drafts:102', 1, 'agent')$$,
  '23505', NULL,
  'one row per draft id per inbox');

SELECT lives_ok(
  $$INSERT INTO public.draft_lineage (workspace_id, inbox_id, line_id, draft_id, revision, written_by)
    VALUES ('ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a2',
            'e5000000-0000-0000-0000-000000000003', 'Drafts:102', 1, 'agent')$$,
  'the same id in another inbox is another draft');

-- What the edge function's upsert (`onConflict: "inbox_id,draft_id"`) compiles to.
INSERT INTO public.draft_lineage (workspace_id, inbox_id, line_id, draft_id, revision, written_by, closed_at, closed_reason)
VALUES ('ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a1',
        'e5000000-0000-0000-0000-000000000001', 'Drafts:102', 3, 'agent', NULL, NULL)
ON CONFLICT (inbox_id, draft_id) DO UPDATE
  SET line_id = EXCLUDED.line_id, revision = EXCLUDED.revision, written_by = EXCLUDED.written_by,
      written_at = EXCLUDED.written_at, closed_at = EXCLUDED.closed_at, closed_reason = EXCLUDED.closed_reason;
SELECT is(
  (SELECT revision FROM public.draft_lineage
    WHERE inbox_id = 'e0000000-0000-0000-0000-0000000000a1' AND draft_id = 'Drafts:102'),
  3,
  'the upsert on (inbox_id, draft_id) bumps the existing row');

-- ------------------------------------------------------------
-- 2. Constraints
-- ------------------------------------------------------------
SELECT throws_ok(
  $$INSERT INTO public.draft_lineage (workspace_id, inbox_id, line_id, draft_id, revision, written_by)
    VALUES ('ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a1',
            'e5000000-0000-0000-0000-000000000004', 'Drafts:200', 1, 'someone')$$,
  '23514', NULL,
  'written_by is agent or user');
SELECT throws_ok(
  $$INSERT INTO public.draft_lineage (workspace_id, inbox_id, line_id, draft_id, revision, written_by)
    VALUES ('ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a1',
            'e5000000-0000-0000-0000-000000000004', 'Drafts:201', 0, 'agent')$$,
  '23514', NULL,
  'revisions start at 1');
SELECT throws_ok(
  $$UPDATE public.draft_lineage SET closed_at = now()
     WHERE draft_id = 'Drafts:101'$$,
  '23514', NULL,
  'a closed row says how it closed');
SELECT throws_ok(
  $$UPDATE public.draft_lineage SET closed_at = now(), closed_reason = 'archived'
     WHERE draft_id = 'Drafts:101'$$,
  '23514', NULL,
  'a line closes by a send or a delete');
SELECT throws_ok(
  $$UPDATE public.draft_lineage SET draft_id = repeat('x', 1025)
     WHERE draft_id = 'Drafts:101'$$,
  '23514', NULL,
  'a draft id is an id, not a place to keep content');
SELECT is(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'draft_lineage'
      AND column_name ~ '(subject|sender|recipient|body|snippet|preview|message|hash|sha)'),
  0::bigint,
  'no column for a subject, recipient, body or a hash of one');

-- ------------------------------------------------------------
-- 3. Service-role only
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-0000-0000-000000000001","role":"authenticated"}';

SELECT throws_ok(
  $$SELECT count(*) FROM public.draft_lineage$$,
  '42501', NULL,
  'a browser session cannot read lineage, even for its own workspace');
SELECT throws_ok(
  $$INSERT INTO public.draft_lineage (workspace_id, inbox_id, line_id, draft_id, revision, written_by)
    VALUES ('ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a1',
            'e5000000-0000-0000-0000-000000000005', 'Drafts:300', 1, 'user')$$,
  '42501', NULL,
  'or write it');

RESET ROLE;

-- ------------------------------------------------------------
-- 4. Lifetime
-- ------------------------------------------------------------
DELETE FROM public.inboxes WHERE id = 'e0000000-0000-0000-0000-0000000000a1';
SELECT is(
  (SELECT count(*) FROM public.draft_lineage WHERE inbox_id = 'e0000000-0000-0000-0000-0000000000a1'),
  0::bigint,
  'deleting the inbox removes its lineage');

SELECT * FROM finish();
ROLLBACK;
