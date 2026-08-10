-- Phase 1: privacy-safe, append-only shadow usage ledger.
-- One row represents one completed MCP tools/call classification. It stores no
-- email content, recipient, API arguments, API key, or inbox identifier.

CREATE TABLE public.action_usage (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  tool_name      text NOT NULL,
  billable       boolean NOT NULL,
  quantity       integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  meter_version  integer NOT NULL DEFAULT 1 CHECK (meter_version > 0),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT action_usage_billable_quantity_check
    CHECK ((billable AND quantity > 0) OR (NOT billable AND quantity = 0))
);

CREATE INDEX action_usage_workspace_meter_occurred_idx
  ON public.action_usage (workspace_id, meter_version, occurred_at DESC);
CREATE INDEX action_usage_billable_workspace_occurred_idx
  ON public.action_usage (workspace_id, occurred_at DESC)
  WHERE billable;

COMMENT ON TABLE public.action_usage IS
  'Phase-1 shadow-meter ledger. Successful classified MCP tools/call operations only; no email content, recipients, arguments, API keys, or inbox IDs.';

ALTER TABLE public.action_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "action_usage_select_members"
  ON public.action_usage FOR SELECT TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

-- Writes are service-role only (the MCP edge function). No user INSERT,
-- UPDATE, or DELETE policy is intentionally provided.
