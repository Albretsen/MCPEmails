-- ============================================================================
-- public.inboxes.folder_overrides: the folder a user picked per role.
-- ============================================================================
--
-- WHAT. A nullable jsonb object, for example
--   {"sent": "INBOX.Éléments envoyés", "trash": "INBOX.Corbeille"}
-- set from the dashboard (Inboxes > inbox > Advanced > Folders) for IMAP
-- inboxes whose layout automatic role detection cannot resolve. NULL, the
-- default for every existing row, means automatic detection for every role:
-- exactly the behaviour before this column existed.
--
-- WHO READS AND WRITES IT.
--   write: PUT /api/inboxes/[id]/folders, on the service-role client, after
--          the canManageInboxes check and a live IMAP LIST (only a folder the
--          server listed may be stored).
--   read:  that route's GET (service role), mcp-server and client-api
--          (service role, in their own query, so a missing column can only
--          break this feature). The dashboard reads it through the route,
--          never in its shared inbox select.
--
-- THE CHECK. The rules the route enforces, restated here so no writer can
-- store a value that breaks them: an object; keys only sent, drafts, trash,
-- spam, archive; every value a string of 1 to 512 characters; never INBOX
-- (any case); never one folder for two roles. The servers also drop any value
-- that breaks these on read (supabase/functions/mcp-server/folder-overrides.ts).
--
-- RLS. Row access is the existing inboxes policies, unchanged. Column grants
-- do not extend to new columns (20261016160200), so authenticated gets SELECT
-- on this one explicitly, like every other non-secret column (the pgTAP test
-- inboxes_user_access.sql requires it). It holds folder names, not secrets.
-- There is still no user write grant on inboxes.
--
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE, constraint added only once.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.inbox_folder_overrides_valid(overrides jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT overrides IS NULL OR (
    jsonb_typeof(overrides) = 'object'
    AND (overrides - ARRAY['sent', 'drafts', 'trash', 'spam', 'archive']) = '{}'::jsonb
    AND NOT EXISTS (
      SELECT 1
        FROM jsonb_each(overrides) AS e(key, value)
       WHERE jsonb_typeof(e.value) <> 'string'
          OR char_length(e.value #>> '{}') NOT BETWEEN 1 AND 512
          OR upper(e.value #>> '{}') = 'INBOX'
    )
    AND (SELECT count(*) FROM jsonb_each(overrides))
      = (SELECT count(DISTINCT e.value) FROM jsonb_each(overrides) AS e(key, value))
  );
$$;

COMMENT ON FUNCTION public.inbox_folder_overrides_valid(jsonb) IS
  'CHECK for inboxes.folder_overrides: object, keys sent/drafts/trash/spam/archive, '
  'string values 1-512 chars, never INBOX, no folder for two roles (20261020230000).';

ALTER TABLE public.inboxes
  ADD COLUMN IF NOT EXISTS folder_overrides jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.inboxes'::regclass
       AND conname = 'inboxes_folder_overrides_check'
  ) THEN
    ALTER TABLE public.inboxes
      ADD CONSTRAINT inboxes_folder_overrides_check
      CHECK (public.inbox_folder_overrides_valid(folder_overrides));
  END IF;
END $$;

COMMENT ON COLUMN public.inboxes.folder_overrides IS
  'Per-role IMAP folder picked by the user, e.g. {"sent": "INBOX.Sent mail"}. '
  'NULL = automatic detection. Written only by PUT /api/inboxes/[id]/folders.';

GRANT SELECT (folder_overrides) ON public.inboxes TO authenticated;
