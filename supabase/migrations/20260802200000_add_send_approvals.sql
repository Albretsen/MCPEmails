-- Opt-in human approval for outbound MCP sends. Disabled for every existing
-- and new inbox unless a workspace owner enables it explicitly.
ALTER TABLE public.inboxes
  ADD COLUMN IF NOT EXISTS send_approval_required boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.send_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  inbox_id uuid NOT NULL REFERENCES public.inboxes(id) ON DELETE CASCADE,
  api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  operation text NOT NULL CHECK (operation IN ('email_send', 'schedule_create')),
  payload jsonb NOT NULL,
  payload_encrypted boolean NOT NULL DEFAULT true,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  send_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  decision_note text
);

CREATE INDEX IF NOT EXISTS send_approvals_workspace_pending_idx
  ON public.send_approvals (workspace_id, created_at DESC) WHERE status = 'pending';

ALTER TABLE public.send_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "send_approvals_select_members" ON public.send_approvals FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.workspace_id = send_approvals.workspace_id AND wm.user_id = auth.uid()));

ALTER TABLE public.send_approvals DROP CONSTRAINT IF EXISTS send_approvals_operation_check;
ALTER TABLE public.send_approvals ADD CONSTRAINT send_approvals_operation_check
  CHECK (operation IN ('email_send', 'email_reply', 'email_forward', 'draft_send', 'schedule_create'));

COMMENT ON TABLE public.send_approvals IS 'Encrypted outbound messages awaiting a human dashboard decision.';
