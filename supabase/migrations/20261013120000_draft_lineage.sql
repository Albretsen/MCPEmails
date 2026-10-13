-- ===========================================================================
-- Draft lineage: which draft id is the CURRENT one for a draft that has been
-- rewritten.
-- 20261013120000_draft_lineage
--
-- Design: docs/mcp-apps/CONCEPT-draft-editor.md §5 (phase 1) and contract §8.
-- Read and written by the `mcp-server` edge function only
-- (supabase/functions/mcp-server/draft-lineage.ts and its store in index.ts).
--
-- WHY. On IMAP every draft save APPENDs a new message and expunges the old
-- one, so the draft gets a new id each time. A card reloaded with the id of its
-- first tool result, or a save retried after its response was lost, then met
-- `draft_not_found` although the draft was sitting in the mailbox under a newer
-- id (QA 2026-10-13). A LINE is every id one draft has had; every draft action
-- first asks "what is the current id of the one I was given".
--
-- WHAT IS STORED, AND WHAT IS NOT. Provider draft ids (opaque handles such as
-- "Drafts:103", a Gmail draft id or a Graph message id), a revision counter,
-- who wrote last ('agent' | 'user'), when, and whether the line ended in a send
-- (and whether the sent draft's copy was left in Drafts) or a delete. No subject, recipient, body or hash of one: mail content is not
-- stored, and there is no column that could hold it.
--
-- TENANCY. Service-role only: RLS on, no policies, and anon / authenticated
-- hold no privileges. The edge function filters every statement on
-- workspace_id AND inbox_id, and the inbox comes from the calling key's
-- workspace and inbox allowlist.
--
-- FAIL SOFT. The function tolerates this table being absent (every id then
-- resolves to itself, as before), so this migration and the function deploy
-- can go in either order. Applying it first is still the tidy order.
--
-- REVISIONS ARE COMPUTED HERE, ATOMICALLY (review 2 of 2026-10-13). The
-- edge function used to read a line's head and write head + 1. Two writers
-- that read the same head both wrote N+1, and the editor card's
-- `base_revision` check (contract §8) then passed for a card showing content
-- it never saw. Every write now goes through `public.draft_lineage_record`,
-- which takes a per-inbox advisory transaction lock, decides the line and
-- writes max(revision) + 1 in one call, and says whether the line had moved
-- since the caller read it (`contended`). UNIQUE (inbox_id, line_id, revision)
-- is the backstop: a second N+1 is a constraint violation, not a quiet tie.
--
-- Forward-only, re-runnable: CREATE TABLE / INDEX IF NOT EXISTS, a guarded
-- ADD CONSTRAINT, CREATE OR REPLACE FUNCTION, no policies to re-create,
-- idempotent REVOKEs and GRANTs. NOT APPLIED BY THE AGENT THAT WROTE IT. Apply
-- with the normal migration workflow (never `db push`).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.draft_lineage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  inbox_id      uuid NOT NULL REFERENCES public.inboxes(id) ON DELETE CASCADE,
  -- A fresh UUID per draft, not the first draft id, so a line can never
  -- collide with rows left over from an older one.
  line_id       uuid NOT NULL,
  draft_id      text NOT NULL CHECK (char_length(draft_id) BETWEEN 1 AND 1024),
  revision      integer NOT NULL CHECK (revision >= 1),
  written_by    text NOT NULL CHECK (written_by IN ('agent', 'user')),
  written_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  -- 'sent_kept': sent, but the draft copy could not be removed from Drafts
  -- afterwards (the IMAP post-send delete is best-effort), so the line's last
  -- id may still name the message that was sent.
  closed_reason text CHECK (closed_reason IS NULL OR closed_reason IN ('sent', 'sent_kept', 'deleted')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT draft_lineage_closed_together
    CHECK ((closed_at IS NULL) = (closed_reason IS NULL)),
  -- One row per id per mailbox. `draft_lineage_record` upserts on exactly
  -- these columns: a provider that keeps the id (Gmail, Outlook) bumps its one
  -- row, and an id that turns up again is moved and reopened.
  CONSTRAINT draft_lineage_inbox_draft_key UNIQUE (inbox_id, draft_id),
  -- One row per revision per line. Compatible with both shapes a line takes:
  -- on IMAP every write adds a row at the next revision; on Gmail and Outlook
  -- the line is ONE row whose revision is moved up in place. Its index is also
  -- "the head of a line" (highest revision for inbox + line).
  CONSTRAINT draft_lineage_line_revision_key UNIQUE (inbox_id, line_id, revision)
);

-- A table created by an earlier draft of this migration had a plain index
-- where the unique key now is.
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.draft_lineage'::regclass
       AND conname = 'draft_lineage_line_revision_key'
  ) THEN
    ALTER TABLE public.draft_lineage
      ADD CONSTRAINT draft_lineage_line_revision_key UNIQUE (inbox_id, line_id, revision);
  END IF;
END
$guard$;
DROP INDEX IF EXISTS public.draft_lineage_line_idx;

-- Workspace deletes cascade through this column.
CREATE INDEX IF NOT EXISTS draft_lineage_workspace_idx
  ON public.draft_lineage (workspace_id);

COMMENT ON TABLE public.draft_lineage IS
  'Draft id lineage for the mcp-server draft tools: every id one draft has had (IMAP gives a draft a new id on every save), so an older id resolves to the current one. Provider ids, a revision, who wrote last and when, and how the line closed (sent / deleted). No mail content. Service-role only; no policies on purpose.';

ALTER TABLE public.draft_lineage ENABLE ROW LEVEL SECURITY;

-- Belt and braces beside RLS with no policies: a browser session never reads
-- or writes this table.
REVOKE ALL ON public.draft_lineage FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- draft_lineage_record: record one draft write, atomically.
--
-- The only writer of rows (the edge function's store calls it through
-- PostgREST `rpc`; supabase/functions/mcp-server/draft-lineage.ts
-- #recordDraftWrite and #closeDraftLine decide the arguments, and
-- draft-lineage-fake.ts is its in-memory transcription for tests).
--
--   p_line_id + p_expected_revision
--       continue that line: the line and the revision the caller resolved
--       BEFORE its provider write. A line that is closed (its head row has
--       closed_at) or gone starts a new one instead.
--   p_seed_draft_id
--       a new line starts with this OLDER id at revision 1 (a draft that had
--       no line until a write moved its id).
--   p_adopt
--       the caller found no line for an id its write did not change. When that
--       id is NOW the head of an open line, continue it instead of starting a
--       second line at revision 1, which would let a card holding revision 1 of
--       the first line pass its check.
--
-- Returns the line written to, the revision the new id got, and `contended`:
-- true when the line was not where the caller left it (head revision is not
-- p_expected_revision, the line closed meanwhile, or an adopted line). The row
-- is written regardless; the caller does not publish that revision, because
-- the two provider writes may have landed in the other order.
--
-- One writer per INBOX at a time (pg_advisory_xact_lock, released at commit).
-- Per inbox rather than per line on purpose: two writers starting the first
-- line of the same draft have no line id to lock on yet, and draft writes per
-- mailbox are few and this transaction is a handful of index lookups.
--
-- SECURITY INVOKER, service role only: it needs no privilege the caller lacks,
-- and anon / authenticated can neither execute it nor touch the table. The
-- empty search_path and qualified names keep it independent of the caller's.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.draft_lineage_record(
  p_workspace_id      uuid,
  p_inbox_id          uuid,
  p_draft_id          text,
  p_written_by        text,
  p_line_id           uuid        DEFAULT NULL,
  p_expected_revision integer     DEFAULT NULL,
  p_seed_draft_id     text        DEFAULT NULL,
  p_adopt             boolean     DEFAULT false,
  p_written_at        timestamptz DEFAULT NULL
)
RETURNS TABLE (recorded_line_id uuid, recorded_revision integer, contended boolean)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_line        uuid;
  v_head_rev    integer;
  v_head_closed boolean;
  v_contended   boolean := false;
  v_next        integer;
  v_at          timestamptz := coalesce(p_written_at, now());
  v_rows        integer;
BEGIN
  IF p_workspace_id IS NULL OR p_inbox_id IS NULL OR p_draft_id IS NULL OR p_written_by IS NULL THEN
    RAISE EXCEPTION 'draft_lineage_record: workspace, inbox, draft id and writer are required'
      USING ERRCODE = '22004';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public.draft_lineage:' || p_inbox_id::text, 0)
  );

  -- 1. The line the caller resolved, if it is still open.
  IF p_line_id IS NOT NULL THEN
    SELECT l.revision, l.closed_at IS NOT NULL
      INTO v_head_rev, v_head_closed
      FROM public.draft_lineage l
     WHERE l.workspace_id = p_workspace_id
       AND l.inbox_id = p_inbox_id
       AND l.line_id = p_line_id
     ORDER BY l.revision DESC
     LIMIT 1;
    IF FOUND AND NOT v_head_closed THEN
      v_line := p_line_id;
      v_contended := p_expected_revision IS DISTINCT FROM v_head_rev;
    ELSE
      v_contended := true;
    END IF;
  END IF;

  -- 2. A line somebody else started for this very id meanwhile.
  IF v_line IS NULL AND p_adopt THEN
    SELECT l.line_id, l.revision
      INTO v_line, v_head_rev
      FROM public.draft_lineage l
     WHERE l.workspace_id = p_workspace_id
       AND l.inbox_id = p_inbox_id
       AND l.draft_id = p_draft_id
       AND l.closed_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.draft_lineage h
          WHERE h.inbox_id = l.inbox_id
            AND h.line_id = l.line_id
            AND h.revision > l.revision
       );
    IF v_line IS NOT NULL THEN
      v_contended := true;
    END IF;
  END IF;

  -- 3. Otherwise a new line, seeded with the older id when there is one.
  IF v_line IS NULL THEN
    v_line := gen_random_uuid();
    v_head_rev := 0;
    IF p_seed_draft_id IS NOT NULL AND p_seed_draft_id <> p_draft_id THEN
      INSERT INTO public.draft_lineage
        (workspace_id, inbox_id, line_id, draft_id, revision, written_by, written_at)
      VALUES
        (p_workspace_id, p_inbox_id, v_line, p_seed_draft_id, 1, p_written_by, v_at)
      ON CONFLICT (inbox_id, draft_id) DO UPDATE
        SET line_id = EXCLUDED.line_id,
            revision = EXCLUDED.revision,
            written_by = EXCLUDED.written_by,
            written_at = EXCLUDED.written_at,
            closed_at = NULL,
            closed_reason = NULL
        WHERE public.draft_lineage.workspace_id = EXCLUDED.workspace_id;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 0 THEN
        RAISE EXCEPTION 'draft_lineage_record: draft id belongs to another workspace'
          USING ERRCODE = '42501';
      END IF;
      v_head_rev := 1;
    END IF;
  END IF;

  v_next := v_head_rev + 1;
  INSERT INTO public.draft_lineage
    (workspace_id, inbox_id, line_id, draft_id, revision, written_by, written_at)
  VALUES
    (p_workspace_id, p_inbox_id, v_line, p_draft_id, v_next, p_written_by, v_at)
  ON CONFLICT (inbox_id, draft_id) DO UPDATE
    SET line_id = EXCLUDED.line_id,
        revision = EXCLUDED.revision,
        written_by = EXCLUDED.written_by,
        written_at = EXCLUDED.written_at,
        closed_at = NULL,
        closed_reason = NULL
    WHERE public.draft_lineage.workspace_id = EXCLUDED.workspace_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'draft_lineage_record: draft id belongs to another workspace'
      USING ERRCODE = '42501';
  END IF;

  recorded_line_id := v_line;
  recorded_revision := v_next;
  contended := v_contended;
  RETURN NEXT;
END;
$fn$;

COMMENT ON FUNCTION public.draft_lineage_record(uuid, uuid, text, text, uuid, integer, text, boolean, timestamptz) IS
  'Record one draft write in draft_lineage atomically (per-inbox advisory lock; revision = line max + 1). Returns the line, the revision and whether the line had moved since the caller read it. Service role only.';

REVOKE ALL ON FUNCTION public.draft_lineage_record(uuid, uuid, text, text, uuid, integer, text, boolean, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.draft_lineage_record(uuid, uuid, text, text, uuid, integer, text, boolean, timestamptz)
  TO service_role;
