-- ===========================================================================
-- The draft editor card for every workspace.
-- 20261027160000_draft_editor_for_everyone
--
-- Until now `workspaces.draft_editor_enabled` was true only for our own
-- workspaces (20260916140000). This turns it on for every workspace, and for
-- every workspace created from now on. The customer's own switches,
-- `workspaces.draft_editor_hidden` and `inboxes.draft_editor_hidden`, are not
-- touched: anyone who hides the card keeps it hidden.
--
-- STALE LISTINGS. A client caches `tools/list` at connect, and the `draft`
-- tool only carries `_meta.ui` in an enabled workspace, so every connected
-- client holds a listing without the card. Marking every live key 'stale'
-- (CARD_LISTING_STALE, card-build-notify.ts) makes the next card-bearing call
-- send notifications/tools/list_changed, exactly as a preference change does.
-- Hosts that ignore it mid-chat show the card from the next new chat, so
-- every key not already listed with the card gets card_listed = false: until
-- its next tools/list, a draft result says the card may not show in this chat
-- rather than that it is on screen (20261027140000).
--
-- ROLLBACK: `UPDATE public.workspaces SET draft_editor_enabled = false WHERE
-- NOT public.growth_is_internal_email((SELECT email FROM public.users WHERE id
-- = owner_id));`, reset the default to false, and mark keys stale again.
--
-- When this runs, set DRAFT_CARD_RELEASE_AT in
-- apps/web/src/lib/analytics/draft-card.ts to the time it ran.
--
-- Forward-only, re-runnable. Apply after 20261027150000 and after the
-- mcp-server deploy that reads card_listed, with `db query --linked -f` and
-- `migration repair` (never db push). No function deploy is needed for the
-- flip itself: the gate is read per request.
-- ===========================================================================

ALTER TABLE public.workspaces ALTER COLUMN draft_editor_enabled SET DEFAULT true;

COMMENT ON COLUMN public.workspaces.draft_editor_enabled IS
  'MCP App draft editor (contract §8). On for every workspace since 2026-10-27 (20261027130000); the customer opts out with draft_editor_hidden. False = the draft tool behaves exactly as it did before the editor existed, in both channels and at tools/list.';

UPDATE public.workspaces
SET draft_editor_enabled = true
WHERE deleted_at IS NULL
  AND draft_editor_enabled IS DISTINCT FROM true;

UPDATE public.api_keys
SET card_build_notified = 'stale'
WHERE deleted_at IS NULL
  AND card_build_notified IS DISTINCT FROM 'stale';

UPDATE public.api_keys
SET card_listed = false
WHERE deleted_at IS NULL
  AND card_listed IS DISTINCT FROM true;
