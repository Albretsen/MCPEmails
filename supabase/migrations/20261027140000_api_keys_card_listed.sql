-- ===========================================================================
-- api_keys.card_listed: did the last tool list this key was served carry the
-- draft editor card?
-- 20261027140000_api_keys_card_listed
--
-- WHY. A draft result in a card-on workspace says "The user is shown this
-- draft in an editable card in this chat now" (DRAFT_CARD_NOTICE). A host only
-- draws the card when the tool list IT CACHED carries `_meta.ui` on the draft
-- tools, and hosts cache that list per chat: Claude ignores
-- notifications/tools/list_changed mid-chat, ChatGPT until tools are reloaded.
-- When the card goes on for a workspace (the release, or a customer turning it
-- back on), every open chat holds a list without it, and the model would tell
-- the user about a card they cannot see.
--
-- WHAT. Written by mcp-server on every tools/list, fire and forget, to whether
-- that list carried the draft card (the `drafts` gate). Read when a draft
-- result is built: `false` swaps the notice for one that says this chat may
-- not show a card and a new chat will (DRAFT_CARD_UNLISTED_NOTICE).
--   true   the last list carried the card
--   false  it did not
--   NULL   never recorded; treated as true (the behaviour before this column)
--
-- BACKFILL. Used keys in workspaces where the card is on and not hidden were
-- served the card (it has been on there since 2026-09-16): true. Everyone else stays NULL until their next
-- tools/list. The rollout migration sets false on every key not true.
--
-- Additive. APPLY BEFORE DEPLOYING mcp-server: the key lookup selects this
-- column. With `db query --linked -f` and `migration repair` (never db push).
-- ===========================================================================

ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS card_listed boolean;

COMMENT ON COLUMN public.api_keys.card_listed IS
  'Whether the last tools/list served to this key carried the draft editor card (_meta.ui on the draft tools). Written by mcp-server on tools/list; false makes draft results say the card may not show in this chat. NULL = never recorded, treated as true.';

UPDATE public.api_keys k
SET card_listed = true
FROM public.workspaces w
WHERE w.id = k.workspace_id
  AND k.deleted_at IS NULL
  AND k.card_listed IS NULL
  AND k.last_used_at IS NOT NULL
  AND w.draft_editor_enabled
  AND NOT w.draft_editor_hidden;
