-- ===========================================================================
-- Draft card activity: what was saved or sent through the draft editor, so
-- the server can say so in the next draft result on the same API key.
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
-- server records each editor action here and the next MCP draft result on the
-- SAME API key and inbox carries one note about it, once (`reported_at`).
--
-- PER KEY. `api_key_id` is the key the editor call (draft_editor_save, or a
-- send with base_revision) came in on, and only that key's calls claim the
-- row: a save in Claude's card is not news to ChatGPT on another key. ON
-- DELETE CASCADE, like outbound_idempotency and send_approvals: a row is
-- useless once its key is gone, because nothing can claim it.
--
-- WHAT IS STORED, AND WHAT IS NOT. A provider draft id, the lineage line and
-- revision, which action, when, the NAMES of the fields a save changed and
-- recipient COUNTS. No subject, address, body or hash of one: mail content is
-- not stored, the same promise draft_lineage keeps, and there is no column that
-- could hold it.
--
-- RETENTION. Every insert, in any workspace, also deletes every row older than
-- 7 days (draft_card_activity_occurred_idx). Because it runs on every insert,
-- the backlog it meets is only what expired since the previous insert.
-- Workspace, inbox and key deletes cascade.
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
  api_key_id    uuid NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
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

-- "The unreported actions for this key and inbox", which is every claim.
CREATE INDEX IF NOT EXISTS draft_card_activity_unreported_idx
  ON public.draft_card_activity (api_key_id, inbox_id, occurred_at)
  WHERE reported_at IS NULL;

-- Retention: "every row older than 7 days".
CREATE INDEX IF NOT EXISTS draft_card_activity_occurred_idx
  ON public.draft_card_activity (occurred_at);

-- Workspace deletes cascade through this column.
CREATE INDEX IF NOT EXISTS draft_card_activity_workspace_idx
  ON public.draft_card_activity (workspace_id);

COMMENT ON TABLE public.draft_card_activity IS
  'Saves and sends made through the MCP Apps draft editor, so the mcp-server can state them in the next draft result on the same API key. Draft ids, a revision, field names and recipient counts; no mail content. Service-role only; no policies on purpose.';

ALTER TABLE public.draft_card_activity ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.draft_card_activity FROM anon, authenticated;
