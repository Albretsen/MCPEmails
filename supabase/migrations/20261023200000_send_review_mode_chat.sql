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

-- ---------------------------------------------------------------------------
-- workspaces.chat_send_confirm_enabled: OUR rollout gate for the mode above.
--
-- Internal only at launch. The dashboard offers 'chat' only where this is
-- true, PATCH /api/inboxes/[id] refuses a change to 'chat' without it, and
-- mcp-server treats a 'chat' inbox in a workspace without it as 'off'.
-- Its own column, like `card_diagnostics`, so widening this rollout never
-- moves the draft editor's.
--
-- DEFAULT FALSE: the pre-feature behaviour, not a degraded mode.
-- ---------------------------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS chat_send_confirm_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.workspaces.chat_send_confirm_enabled IS
  'Rollout gate for the "Confirm in chat" send review mode (inboxes.send_review_mode = ''chat''). Internal only at launch.';

-- Seed: our own workspaces, identified by OWNER through
-- growth_is_internal_email, exactly as 20260917120000_card_diagnostics_flag.sql
-- does it (a workspace one of us was invited into belongs to a customer).
-- Idempotent.
UPDATE public.workspaces w
SET chat_send_confirm_enabled = true
FROM public.users u
WHERE u.id = w.owner_id
  AND w.deleted_at IS NULL
  AND w.chat_send_confirm_enabled IS DISTINCT FROM true
  AND public.growth_is_internal_email(u.email);
