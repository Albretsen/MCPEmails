-- ============================================================
-- MCPEmails — Contacts table
-- 20260602000000_create_contacts
-- ============================================================
--
-- Phase 6 foundation: a derived contact list keyed by
-- (inbox_id, email_address).  Rows are upserted from message
-- headers seen during read_email, search_emails, and send_email —
-- no user action is required to populate the table.
--
-- Design notes:
--   • message_count / last_contacted_at are derived from traffic;
--     no provider address-book API call is needed.
--   • Soft-delete (deleted_at IS NOT NULL) hides rows from the
--     authenticated RLS policy; hard-DELETE is not permitted.
--   • All writes come from the service_role MCP Edge Function; no
--     authenticated INSERT/UPDATE/DELETE policies exist.
--   • Idempotent: TABLE and indexes use IF NOT EXISTS; policies are
--     guarded by a pg_policies existence check so re-running is safe.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.contacts (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  inbox_id          uuid        NOT NULL REFERENCES public.inboxes(id)    ON DELETE CASCADE,
  email_address     text        NOT NULL,
  display_name      text,
  message_count     integer     NOT NULL DEFAULT 1,
  last_contacted_at timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,

  CONSTRAINT contacts_email_nonempty    CHECK (email_address <> ''),
  CONSTRAINT contacts_message_count_pos CHECK (message_count >= 0)
);

-- Natural lookup: one record per address per inbox.
-- email_address is always stored lowercase (normalised by the Edge Function).
-- Non-partial so Supabase's onConflict="inbox_id,email_address" targeting
-- works correctly. Hard-DELETE is not permitted on this table, so duplicate
-- (inbox_id, email_address) rows never arise across soft-delete boundaries.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_inbox_email_uidx
  ON public.contacts (inbox_id, email_address);

-- Workspace-scoped list scan (used by search_contacts, Task 16).
CREATE INDEX IF NOT EXISTS contacts_workspace_idx
  ON public.contacts (workspace_id)
  WHERE deleted_at IS NULL;

-- Recency sort within an inbox.
CREATE INDEX IF NOT EXISTS contacts_last_contacted_idx
  ON public.contacts (inbox_id, last_contacted_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE  public.contacts IS
  'Derived contact list, auto-populated from email headers seen by the MCP Edge Function.';
COMMENT ON COLUMN public.contacts.message_count IS
  'Cumulative messages seen involving this address; incremented on each upsert.';
COMMENT ON COLUMN public.contacts.last_contacted_at IS
  'Timestamp of the most-recently-seen message involving this address.';
COMMENT ON COLUMN public.contacts.deleted_at IS
  'Soft-delete sentinel. NULL = active; non-NULL = hidden from authenticated queries.';

-- ── Row-Level Security ────────────────────────────────────────────────────
-- Mirrors the pattern used by inboxes and api_keys:
--   SELECT: authenticated workspace members see active (non-deleted) contacts.
--   INSERT / UPDATE / DELETE: no authenticated policies — all writes go
--     through the service_role MCP Edge Function.

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'contacts'
      AND policyname = 'contacts_select_members'
  ) THEN
    CREATE POLICY "contacts_select_members"
      ON public.contacts FOR SELECT
      TO authenticated
      USING (
        workspace_id = ANY(public.my_workspace_ids())
        AND deleted_at IS NULL
      );
  END IF;
END
$$;
