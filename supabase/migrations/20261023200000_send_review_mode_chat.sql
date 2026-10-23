-- "Confirm in chat": a fourth send review mode (2026-10-23).
--
-- 'chat' asks the assistant to show the user every message and get a yes in
-- the conversation before sending; mcp-server refuses a send without a
-- confirmation code it issued for that exact message (chat-confirm.ts). It is
-- a guardrail, not a human approval: `send_approval_required` stays false for
-- it, so nothing is held and the approval queue is not involved.
ALTER TABLE public.inboxes DROP CONSTRAINT IF EXISTS inboxes_send_review_mode_check;
ALTER TABLE public.inboxes ADD CONSTRAINT inboxes_send_review_mode_check
  CHECK (send_review_mode IN ('off', 'chat', 'inline', 'dashboard'));
