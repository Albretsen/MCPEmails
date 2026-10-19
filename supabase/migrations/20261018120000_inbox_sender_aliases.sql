-- ============================================================================
-- public.inbox_sender_aliases: Send As addresses for IMAP inboxes
-- ============================================================================
--
-- WHY. Send As (`from` on email_send / email_reply / email_forward) worked only
-- for Gmail OAuth inboxes, whose aliases Google lists for us. An IMAP inbox
-- (iCloud, Yahoo, Gmail by app password, any SMTP host) has no such list, so a
-- customer whose iCloud account also owns an alias could not send from it: the
-- alias is not a valid IMAP login, and connecting the primary login twice is
-- refused by the login-collision guard (apps/web/src/lib/email/
-- imap-login-collision.ts). activity_log held 8 `sender_identity_unsupported_
-- provider` refusals across ~6 workspaces, all IMAP.
--
-- WHAT A ROW MEANS. "This inbox may put `email_address` in From". The SMTP
-- login, host and password stay the inbox's own; only the From address and
-- name change. A row is usable only once `verified_at` is set.
--
-- WHY VERIFICATION. Many generic SMTP hosts accept any From for an
-- authenticated login, so an unverified row would let a workspace member send
-- as any address at all. Verification mails a one-time code TO the alias and
-- the user pastes it back, which proves mail for the alias reaches them. Only
-- a SHA-256 of the code is stored (code_hash), and it is never readable by
-- authenticated users.
--
-- WHO WRITES. Only service-role server code: apps/web/app/api/inboxes/[id]/
-- send-as (role-checked, rate-limited). The MCP server only reads. Members
-- may SELECT the non-secret columns of rows in their own workspaces.
--
-- RATE LIMITS live in the route, in rate_limit_buckets keyed by workspace and
-- by destination address, so deleting and re-adding an alias does not reset
-- them.
--
-- Idempotent: IF NOT EXISTS everywhere, policies dropped before create.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.inbox_sender_aliases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id         uuid NOT NULL REFERENCES public.inboxes(id) ON DELETE CASCADE,
  -- Always the inbox's workspace: set by the trigger below, never trusted from
  -- the writer. Denormalised so RLS and the MCP lookup need no join.
  workspace_id     uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  email_address    text NOT NULL
                     CHECK (length(email_address) <= 254
                            AND email_address ~ '^[^[:space:][:cntrl:]<>(),;:"\[\]\\@]+@[^[:space:][:cntrl:]<>(),;:"\[\]\\@]+\.[^[:space:][:cntrl:]<>(),;:"\[\]\\@]+$'),
  -- Header-safe sender name; NULL falls back to the inbox's display_name.
  display_name     text CHECK (display_name IS NULL
                               OR (length(display_name) BETWEEN 1 AND 100
                                   AND display_name !~ '[[:cntrl:]<>]')),
  verified_at      timestamptz,
  -- Pending verification. Cleared on success.
  code_hash        text,
  code_expires_at  timestamptz,
  code_attempts    integer NOT NULL DEFAULT 0 CHECK (code_attempts >= 0),
  code_sent_at     timestamptz,
  created_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS inbox_sender_aliases_inbox_address_key
  ON public.inbox_sender_aliases (inbox_id, lower(email_address));

CREATE INDEX IF NOT EXISTS inbox_sender_aliases_workspace_idx
  ON public.inbox_sender_aliases (workspace_id);

-- workspace_id follows the inbox, whatever the writer sent.
CREATE OR REPLACE FUNCTION public.inbox_sender_aliases_set_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  SELECT i.workspace_id INTO NEW.workspace_id
    FROM public.inboxes i
   WHERE i.id = NEW.inbox_id;
  IF NEW.workspace_id IS NULL THEN
    RAISE EXCEPTION 'inbox % not found', NEW.inbox_id USING ERRCODE = '23503';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.inbox_sender_aliases_set_workspace() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS inbox_sender_aliases_set_workspace ON public.inbox_sender_aliases;
CREATE TRIGGER inbox_sender_aliases_set_workspace
  BEFORE INSERT OR UPDATE ON public.inbox_sender_aliases
  FOR EACH ROW EXECUTE FUNCTION public.inbox_sender_aliases_set_workspace();

ALTER TABLE public.inbox_sender_aliases ENABLE ROW LEVEL SECURITY;

-- No user writes. REVOKE ALL also removes TRUNCATE, REFERENCES and TRIGGER.
REVOKE ALL ON TABLE public.inbox_sender_aliases FROM anon, authenticated;

-- Members read their workspaces' aliases, minus the code columns.
GRANT SELECT (id, inbox_id, workspace_id, email_address, display_name, verified_at,
              code_expires_at, code_sent_at, created_at, updated_at)
  ON public.inbox_sender_aliases TO authenticated;

DROP POLICY IF EXISTS "inbox_sender_aliases_select_members" ON public.inbox_sender_aliases;
CREATE POLICY "inbox_sender_aliases_select_members"
  ON public.inbox_sender_aliases FOR SELECT
  TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

GRANT ALL ON TABLE public.inbox_sender_aliases TO service_role;

COMMENT ON TABLE public.inbox_sender_aliases IS
  'Send As addresses for IMAP inboxes. Usable only when verified_at is set. '
  'Written ONLY by service-role code (POST/DELETE /api/inboxes/[id]/send-as); '
  'authenticated may SELECT every column except code_hash / code_attempts.';
