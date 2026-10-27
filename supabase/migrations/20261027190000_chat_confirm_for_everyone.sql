-- ===========================================================================
-- "Ask in the chat first" (send_review_mode = 'chat') for every workspace.
-- 20261027190000_chat_confirm_for_everyone
--
-- Until now `workspaces.chat_send_confirm_enabled` was true only for our own
-- workspaces (20261023200000). This turns it on for every workspace, and for
-- every workspace created from now on. Nothing changes for an inbox until its
-- owner picks the mode: every inbox keeps the send_review_mode it has.
--
-- No listing change: the `confirmation` argument is already advertised on
-- every send tool, so connected chats need no tools/list refetch.
--
-- ROLLBACK: `UPDATE public.workspaces SET chat_send_confirm_enabled = false
-- WHERE NOT public.growth_is_internal_email((SELECT email FROM public.users
-- WHERE id = owner_id));` and reset the default to false. An inbox already in
-- 'chat' then behaves as 'off' on the server and keeps its stored value.
--
-- Forward-only, re-runnable. Apply with `db query --linked -f` and
-- `migration repair` (never db push). No function deploy is needed: the flag
-- is read per request by mcp-server and the dashboard.
-- ===========================================================================

ALTER TABLE public.workspaces ALTER COLUMN chat_send_confirm_enabled SET DEFAULT true;

COMMENT ON COLUMN public.workspaces.chat_send_confirm_enabled IS
  'Rollout gate for the "Ask in the chat first" send review mode (inboxes.send_review_mode = ''chat''). On for every workspace since 2026-10-27 (20261027190000); false makes a ''chat'' inbox behave as ''off''.';

UPDATE public.workspaces
SET chat_send_confirm_enabled = true
WHERE chat_send_confirm_enabled IS DISTINCT FROM true;
