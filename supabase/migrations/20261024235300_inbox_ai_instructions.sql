-- ============================================================================
-- public.inboxes.ai_instructions: the owner's standing instructions per inbox.
-- ============================================================================
--
-- WHAT. Plain text the workspace writes once per inbox, for example
--   "This is the support inbox. Sign as the Support Team. Never reply to
--    invoices; move them to Finance."
-- Every AI client sees it: inbox_list returns it on the inbox, and the
-- drafting and sending tools (draft create/reply, email_compose) add it to
-- their result as a labelled note. A Pro feature (`inbox_instructions`,
-- 20261024235100_pro_features_gate.sql): nothing is served, and the dashboard
-- shows no field, until the workspace is in the rollout or the launch switch
-- is on, and then only on Pro or Business.
--
-- NULL, the default for every existing row, means no instructions: exactly the
-- behaviour before this column existed.
--
-- WHO READS AND WRITES IT.
--   write: PUT /api/inboxes/[id]/instructions, on the service-role client,
--          after canManageInboxes and the Pro gate (allowed).
--   read:  that route's GET (service role) and mcp-server (service role, in
--          its own query, so a missing column only disables this feature).
--          The dashboard reads it through the route, never in its shared
--          inbox select.
--
-- THE CHECK. Trimmed, 1 to 2000 characters, or NULL. The route trims, maps
-- empty to NULL and refuses longer text; the server also trims and caps on
-- read (supabase/functions/mcp-server/inbox-instructions.ts).
--
-- RLS. Row access is the existing inboxes policies, unchanged. Column grants
-- do not extend to new columns (20261016160200), so authenticated gets SELECT
-- on both explicitly, like every other non-secret column (the pgTAP test
-- inboxes_user_access.sql requires it). There is still no user write grant on
-- inboxes.
--
-- Forward-only, idempotent: IF NOT EXISTS, constraint added only once.
-- ============================================================================

ALTER TABLE public.inboxes
  ADD COLUMN IF NOT EXISTS ai_instructions text,
  ADD COLUMN IF NOT EXISTS ai_instructions_updated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.inboxes'::regclass
       AND conname = 'inboxes_ai_instructions_check'
  ) THEN
    ALTER TABLE public.inboxes
      ADD CONSTRAINT inboxes_ai_instructions_check
      CHECK (
        ai_instructions IS NULL
        OR (char_length(ai_instructions) BETWEEN 1 AND 2000
            AND ai_instructions = btrim(ai_instructions, E' \t\r\n'))
      );
  END IF;
END $$;

COMMENT ON COLUMN public.inboxes.ai_instructions IS
  'Owner-written standing instructions for AI clients on this inbox (Pro feature '
  'inbox_instructions). Trimmed, at most 2000 characters; NULL = none. Written only '
  'by PUT /api/inboxes/[id]/instructions.';
COMMENT ON COLUMN public.inboxes.ai_instructions_updated_at IS
  'When ai_instructions was last saved or cleared.';

GRANT SELECT (ai_instructions, ai_instructions_updated_at) ON public.inboxes TO authenticated;
