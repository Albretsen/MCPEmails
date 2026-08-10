-- Phase 5: privacy-safe operational record of enforced action-cap responses.
-- This is intentionally separate from action_usage: the ledger records
-- successful tool calls, while this table records each rejected new call.
-- No email data, API arguments, API-key identifier, or end-user identity is
-- retained beyond the workspace needed for members to inspect their own use.

CREATE TABLE public.usage_limit_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  effective_plan text NOT NULL,
  used_actions   integer NOT NULL CHECK (used_actions >= 0),
  cap            integer NOT NULL CHECK (cap > 0),
  meter_version  integer NOT NULL DEFAULT 1 CHECK (meter_version > 0),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX usage_limit_events_workspace_occurred_idx
  ON public.usage_limit_events (workspace_id, occurred_at DESC);
CREATE INDEX usage_limit_events_occurred_idx
  ON public.usage_limit_events (occurred_at DESC);

COMMENT ON TABLE public.usage_limit_events IS
  'Privacy-safe record of MCP action-cap rejections, used for aggregate cap-hit and support-burden reporting.';

ALTER TABLE public.usage_limit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "usage_limit_events_select_members"
  ON public.usage_limit_events FOR SELECT TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

-- Writes are service-role only (the MCP edge function). No user INSERT,
-- UPDATE, or DELETE policy is intentionally provided.
