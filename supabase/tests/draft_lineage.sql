-- ============================================================
-- Draft lineage (mcp-server stale draft id resolution)
-- ============================================================
-- Covers migration 20261013120000_draft_lineage:
--   - the upsert key the edge function relies on: one row per (inbox, draft id)
--   - the column constraints that keep the table to ids and bookkeeping
--   - no column that could hold mail content
--   - service-role only: a browser session can neither read nor write it
--   - deleting the inbox removes its rows
--   - draft_lineage_record: the atomic revision (one locked call computes
--     max + 1), the contended flag, both line shapes (one row per line on
--     Gmail/Outlook, a row per write on IMAP), the unique (inbox, line,
--     revision) backstop, adopt and closed-line rules, and service-role only
--
-- Run with: supabase test db
-- ============================================================

BEGIN;

SELECT plan(27);

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

-- The upsert draft_lineage_record runs (ON CONFLICT (inbox_id, draft_id)).
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
-- 5. draft_lineage_record: the only writer, atomic
-- ------------------------------------------------------------
SELECT has_function(
  'public', 'draft_lineage_record',
  ARRAY['uuid', 'uuid', 'text', 'text', 'uuid', 'integer', 'text', 'boolean', 'timestamp with time zone'],
  'draft_lineage_record exists with the signature the edge function calls');

-- A Gmail-shaped draft (the id never moves): a new line.
CREATE TEMP TABLE rec ON COMMIT DROP AS
  SELECT * FROM public.draft_lineage_record(
    'ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a2', 'r-1', 'agent');
SELECT is((SELECT recorded_revision FROM rec), 1, 'a new line starts at revision 1');

SELECT is(
  (SELECT (r.recorded_revision, r.contended)::text FROM public.draft_lineage_record(
     'ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a2', 'r-1', 'user',
     p_line_id => (SELECT recorded_line_id FROM rec), p_expected_revision => 1) r),
  '(2,f)',
  'continuing from the revision the caller read: next revision, not contended');

SELECT is(
  (SELECT count(*) || ':' || max(revision) FROM public.draft_lineage
    WHERE inbox_id = 'e0000000-0000-0000-0000-0000000000a2' AND draft_id = 'r-1'),
  '1:2',
  'a provider that keeps the id keeps ONE row per line, its revision moved up in place');

-- A second writer that read revision 1 too: the store computes 3, never a second 2.
SELECT is(
  (SELECT (r.recorded_revision, r.contended)::text FROM public.draft_lineage_record(
     'ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a2', 'r-1', 'agent',
     p_line_id => (SELECT recorded_line_id FROM rec), p_expected_revision => 1) r),
  '(3,t)',
  'a writer whose read is stale gets max + 1 and is told it was contended');

SELECT throws_ok(
  format($$INSERT INTO public.draft_lineage (workspace_id, inbox_id, line_id, draft_id, revision, written_by)
           VALUES ('ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a2',
                   %L, 'r-2', 3, 'agent')$$, (SELECT recorded_line_id FROM rec)),
  '23505', NULL,
  'two rows can never hold the same revision of one line');

-- An IMAP-shaped draft that had no line until a write moved its id.
CREATE TEMP TABLE seeded ON COMMIT DROP AS
  SELECT * FROM public.draft_lineage_record(
    'ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a2', 'Drafts:501', 'user',
    p_seed_draft_id => 'Drafts:500');
SELECT is((SELECT recorded_revision FROM seeded), 2, 'the moved-to id is revision 2');
SELECT is(
  (SELECT line_id = (SELECT recorded_line_id FROM seeded) AND revision = 1
     FROM public.draft_lineage
    WHERE inbox_id = 'e0000000-0000-0000-0000-0000000000a2' AND draft_id = 'Drafts:500'),
  true,
  'the older id is revision 1 of the same line, so it resolves from now on');

-- A caller that found no line for r-1 (its read failed, or it raced the first
-- write): adopt continues the open line instead of restarting at 1.
SELECT is(
  (SELECT (r.recorded_line_id = (SELECT recorded_line_id FROM rec), r.recorded_revision, r.contended)::text
     FROM public.draft_lineage_record(
       'ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a2', 'r-1', 'user',
       p_adopt => true) r),
  '(t,4,t)',
  'adopt continues the line the id heads');

-- A line closed by a send meanwhile is never written to again.
UPDATE public.draft_lineage SET closed_at = now(), closed_reason = 'sent'
 WHERE line_id = (SELECT recorded_line_id FROM rec);
SELECT is(
  (SELECT (r.recorded_line_id <> (SELECT recorded_line_id FROM rec), r.recorded_revision, r.contended)::text
     FROM public.draft_lineage_record(
       'ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a2', 'r-1', 'agent',
       p_line_id => (SELECT recorded_line_id FROM rec), p_expected_revision => 4) r),
  '(t,1,t)',
  'a write onto a closed line starts a new line, contended');

INSERT INTO public.workspaces (id, slug, display_name, owner_id, plan)
VALUES ('eb000000-0000-0000-0000-00000000000b', 'lineage-b', 'Lineage B', 'e1000000-0000-0000-0000-000000000001', 'solo');
SELECT throws_ok(
  $$SELECT * FROM public.draft_lineage_record(
      'eb000000-0000-0000-0000-00000000000b', 'e0000000-0000-0000-0000-0000000000a2', 'Drafts:501', 'agent')$$,
  '42501', NULL,
  'a row of one workspace is never moved by a call for another');

SELECT is(
  (SELECT prosecdef FROM pg_catalog.pg_proc
    WHERE oid = 'public.draft_lineage_record(uuid,uuid,text,text,uuid,integer,text,boolean,timestamptz)'::regprocedure),
  false,
  'SECURITY INVOKER: it needs no privilege its caller lacks');
SELECT ok(
  (SELECT array_to_string(proconfig, ',') LIKE '%search_path=%'
     FROM pg_catalog.pg_proc
    WHERE oid = 'public.draft_lineage_record(uuid,uuid,text,text,uuid,integer,text,boolean,timestamptz)'::regprocedure),
  'search_path is pinned');

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" TO '{"sub":"e1000000-0000-0000-0000-000000000001","role":"authenticated"}';
SELECT throws_ok(
  $$SELECT * FROM public.draft_lineage_record(
      'ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a2', 'Drafts:900', 'user')$$,
  '42501', NULL,
  'a browser session cannot call draft_lineage_record');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok(
  $$SELECT * FROM public.draft_lineage_record(
      'ea000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-0000000000a2', 'Drafts:901', 'user')$$,
  '42501', NULL,
  'nor can an anonymous one');
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
