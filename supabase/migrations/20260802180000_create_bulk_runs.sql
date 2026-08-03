-- MCPEmails — observable, cancellable bulk inbox work
--
-- This table deliberately records operational metadata only. It must never
-- contain message subjects, bodies, attachments, message IDs, or search terms.

CREATE TABLE IF NOT EXISTS public.bulk_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  api_key_id            uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  inbox_id              uuid NOT NULL REFERENCES public.inboxes(id) ON DELETE CASCADE,
  operation             text NOT NULL CHECK (operation IN ('move_batch', 'flag', 'search_and_move')),
  status                text NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'cancelling', 'completed', 'completed_with_errors', 'cancelled_partial', 'failed')),
  total                 integer NOT NULL CHECK (total >= 0),
  processed             integer NOT NULL DEFAULT 0 CHECK (processed >= 0),
  succeeded             integer NOT NULL DEFAULT 0 CHECK (succeeded >= 0),
  failed                integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  cancel_requested_at   timestamptz,
  completed_at          timestamptz,
  error_code            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bulk_runs_counts_valid CHECK (processed = succeeded + failed AND processed <= total)
);

CREATE INDEX IF NOT EXISTS bulk_runs_workspace_created_idx
  ON public.bulk_runs (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bulk_runs_running_inbox_idx
  ON public.bulk_runs (inbox_id, created_at DESC)
  WHERE status IN ('running', 'cancelling');

CREATE TRIGGER bulk_runs_updated_at
  BEFORE UPDATE ON public.bulk_runs
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

ALTER TABLE public.bulk_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bulk_runs_select_members"
  ON public.bulk_runs FOR SELECT TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

-- Dashboard users may request a stop but cannot alter results, ownership, or
-- status directly. The MCP server is the only writer of execution progress.
-- Updates are deliberately service-role only. The authenticated dashboard uses
-- a server route that verifies workspace membership before requesting a stop;
-- a permissive UPDATE policy would let a browser forge result counters.

COMMENT ON TABLE public.bulk_runs IS
  'Short-lived operational metadata for visible/cancellable bulk inbox operations. No email content or message identifiers are stored.';
