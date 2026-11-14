-- How long a held send stays decidable, per workspace.
--
-- Until now every pending approval expired 24 hours after it was queued
-- (mcp-server APPROVAL_TTL_MS), so a send nobody looked at for a day was lost
-- and had to be composed again. The window is now a workspace setting on the
-- Approvals page, one of four fixed lengths. 24 stays the default, so nothing
-- changes for a workspace that never touches it.
--
-- Fixed choices rather than any number: the window is read on every held send,
-- and a bounded set keeps a stale approval from living for months. 14 days is
-- the ceiling because a held send is a frozen copy of what the agent wrote,
-- and the outbound_idempotency record of a held send is stretched to the same
-- deadline (mcp-server, stretchIdempotencyToApproval).
--
-- Only rows queued after a change get the new window; existing pending rows
-- keep the expires_at they were queued with.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS approval_window_hours integer NOT NULL DEFAULT 24;

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_approval_window_hours_check;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_approval_window_hours_check
  CHECK (approval_window_hours IN (24, 72, 168, 336));

COMMENT ON COLUMN public.workspaces.approval_window_hours IS
  'Hours a held send stays decidable after it is queued: 24, 72, 168 or 336. Set on the Approvals page by an owner or admin.';

-- Changes to the window are audited like the recipient rule.
ALTER TABLE public.workspace_audit_events
  DROP CONSTRAINT IF EXISTS workspace_audit_events_kind_check;
ALTER TABLE public.workspace_audit_events
  ADD CONSTRAINT workspace_audit_events_kind_check CHECK (kind IN (
    'invite_sent',
    'invite_cancelled',
    'invite_accepted',
    'member_removed',
    'member_left',
    'role_changed',
    'inbox_visibility_changed',
    'recipient_rule_changed',
    'approval_window_changed'
  ));
