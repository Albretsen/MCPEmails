-- Approval applies to every outbound MCP delivery route. Keep this separate
-- from the original table migration so already-provisioned production
-- databases receive the expanded constraint as well.
ALTER TABLE public.send_approvals
  DROP CONSTRAINT IF EXISTS send_approvals_operation_check;

ALTER TABLE public.send_approvals
  ADD CONSTRAINT send_approvals_operation_check
  CHECK (operation IN (
    'email_send',
    'email_reply',
    'email_forward',
    'draft_send',
    'schedule_create'
  ));
