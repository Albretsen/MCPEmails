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
-- or a delete. No subject, recipient, body or hash of one: mail content is not
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
-- Forward-only, re-runnable: CREATE TABLE / INDEX IF NOT EXISTS, no
-- policies to re-create, idempotent REVOKEs. NOT APPLIED BY THE AGENT THAT WROTE IT. Apply with
-- the normal migration workflow (never `db push`).
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
  closed_reason text CHECK (closed_reason IS NULL OR closed_reason IN ('sent', 'deleted')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT draft_lineage_closed_together
    CHECK ((closed_at IS NULL) = (closed_reason IS NULL)),
  -- One row per id per mailbox. The edge function upserts on exactly these
  -- columns (`onConflict: "inbox_id,draft_id"`): a provider that keeps the id
  -- (Gmail, Outlook) bumps its one row, and an id that turns up again starts
  -- over as an open row.
  CONSTRAINT draft_lineage_inbox_draft_key UNIQUE (inbox_id, draft_id)
);

-- "The head of a line": the highest revision for (inbox, line).
CREATE INDEX IF NOT EXISTS draft_lineage_line_idx
  ON public.draft_lineage (inbox_id, line_id, revision DESC);

-- Workspace deletes cascade through this column.
CREATE INDEX IF NOT EXISTS draft_lineage_workspace_idx
  ON public.draft_lineage (workspace_id);

COMMENT ON TABLE public.draft_lineage IS
  'Draft id lineage for the mcp-server draft tools: every id one draft has had (IMAP gives a draft a new id on every save), so an older id resolves to the current one. Provider ids, a revision, who wrote last and when, and how the line closed (sent / deleted). No mail content. Service-role only; no policies on purpose.';

ALTER TABLE public.draft_lineage ENABLE ROW LEVEL SECURITY;

-- Belt and braces beside RLS with no policies: a browser session never reads
-- or writes this table.
REVOKE ALL ON public.draft_lineage FROM anon, authenticated;
