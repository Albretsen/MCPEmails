-- ===========================================================================
-- Draft card activity: what the person did in the draft editor card, so the
-- server can tell the model in its next draft result.
-- 20261015220000_draft_card_activity
--
-- Read and written by the `mcp-server` edge function only
-- (supabase/functions/mcp-server/card-activity.ts and its store in index.ts).
-- Contract: docs/mcp-apps/contract.md §8, "Card activity notes".
--
-- WHY. The card reports a save or a send to the model through the MCP Apps
-- `ui/update-model-context` request, and in Claude the model never saw it
-- (QA 2026-10-15): after a save in the card Claude reported the old subject
-- and recipients, and after a send from the card it said it had never sent the
-- email. A tool RESULT is the one channel every host shows the model, so the
-- server records each card action here and the model's next draft result for
-- that inbox carries one note about it, once (`reported_at`).
--
-- WHAT IS STORED, AND WHAT IS NOT. A provider draft id, the lineage line and
-- revision, which action, when, the NAMES of the fields a save changed and
-- recipient COUNTS. No subject, address, body or hash of one: mail content is
-- not stored, the same promise draft_lineage keeps, and there is no column that
-- could hold it.
--
-- RETENTION. Rows older than 7 days are deleted by the edge function on the
-- next insert for the same inbox; workspace and inbox deletes cascade.
--
-- TENANCY. Service-role only: RLS on, no policies, and anon / authenticated
-- hold no privileges. Every statement filters on workspace_id AND inbox_id,
-- and the inbox comes from the calling key's workspace and inbox allowlist.
--
-- FAIL SOFT. The function tolerates this table being absent (nothing is
-- recorded and no note is written), so this migration and the function deploy
-- can go in either order.
--
-- Forward-only, re-runnable. NOT APPLIED BY THE AGENT THAT WROTE IT. Apply with
-- the normal migration workflow (never `db push`).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.draft_card_activity (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  inbox_id      uuid NOT NULL REFERENCES public.inboxes(id) ON DELETE CASCADE,
  draft_id      text NOT NULL CHECK (char_length(draft_id) BETWEEN 1 AND 1024),
  line_id       uuid,
  action        text NOT NULL CHECK (action IN ('saved', 'sent')),
  occurred_at   timestamptz NOT NULL,
  revision      integer CHECK (revision IS NULL OR revision >= 0),
  -- Field NAMES only ('to', 'cc', 'bcc', 'subject', 'body'), never values.
  fields        text[] NOT NULL DEFAULT '{}'
                CHECK (fields <@ ARRAY['to', 'cc', 'bcc', 'subject', 'body']::text[]),
  to_count      smallint CHECK (to_count IS NULL OR to_count >= 0),
  cc_count      smallint CHECK (cc_count IS NULL OR cc_count >= 0),
  bcc_count     smallint CHECK (bcc_count IS NULL OR bcc_count >= 0),
  reported_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- "The unreported actions for this inbox", which is every claim.
CREATE INDEX IF NOT EXISTS draft_card_activity_unreported_idx
  ON public.draft_card_activity (inbox_id, occurred_at)
  WHERE reported_at IS NULL;

-- "Did the card send this draft", for the already-sent refusal.
CREATE INDEX IF NOT EXISTS draft_card_activity_sent_idx
  ON public.draft_card_activity (inbox_id, line_id, draft_id)
  WHERE action = 'sent';

-- Workspace deletes cascade through this column.
CREATE INDEX IF NOT EXISTS draft_card_activity_workspace_idx
  ON public.draft_card_activity (workspace_id);

COMMENT ON TABLE public.draft_card_activity IS
  'Actions the person took in the MCP Apps draft editor card (save, send), so the mcp-server can state them in the model''s next draft result. Draft ids, a revision, field names and recipient counts; no mail content. Service-role only; no policies on purpose.';

ALTER TABLE public.draft_card_activity ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.draft_card_activity FROM anon, authenticated;
