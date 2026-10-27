-- ===========================================================================
-- The bulk result card with Undo (mcp-server/mcp-app-undo.ts).
-- 20261027201500_bulk_undo_card
--
-- After a bulk move or delete (email_organize move_batch / search_and_move,
-- email_delete delete_batch / search_and_delete) the MCP Apps card shows one
-- line and an Undo button. An Undo is stored as a bulk plan the server wrote:
-- "move exactly these ids back to exactly this folder, once, within 24 hours",
-- run by the existing app-only bulk_execute tool with all of its guards.
--
-- bulk_plans.scope_kind  gains 'undo' for those rows, so bulk_execute can word
--             its answers ("Undone.", "Undo expired.") without decrypting the
--             scope, and so undo rows are never counted as previews. Undo rows
--             a week past expiry are pruned by mcp-server on the next insert in
--             that workspace.
--
-- workspaces.bulk_undo_hidden  the customer's opt-out, read per call: true
--             leaves the bulk result without the envelope, so the card shows
--             its one plain line. Default false: on for every workspace.
--
-- Additive. APPLY BEFORE DEPLOYING mcp-server: until the constraint allows
-- 'undo', the insert fails and the card simply has no Undo button.
-- Production: `npx supabase db query --linked -f` + `migration repair`, never
-- db push.
-- ===========================================================================

ALTER TABLE public.bulk_plans DROP CONSTRAINT IF EXISTS bulk_plans_scope_kind_check;
ALTER TABLE public.bulk_plans ADD CONSTRAINT bulk_plans_scope_kind_check
  CHECK (scope_kind IN ('explicit_ids', 'search', 'undo'));

COMMENT ON COLUMN public.bulk_plans.scope_kind IS
  'explicit_ids | search: a preview awaiting Execute (bulk_review_mode = plan). undo: written by mcp-server after a bulk move or delete so the result card can put the messages back (24 h, single use).';

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS bulk_undo_hidden boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.workspaces.bulk_undo_hidden IS
  'Customer opt-out for the bulk result card with Undo (MCP Apps). True: bulk move/delete results carry no card envelope, so the card shows one plain line. Read per call by mcp-server.';
