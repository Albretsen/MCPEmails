-- Tracks which review-card build each API key's client has been told about.
--
-- Background: the MCP Apps host caches the UI resource by URI, and the URI now
-- carries a build fingerprint, so a card deploy is only picked up when the
-- client re-reads `tools/list`. Until now that meant reconnecting the connector
-- by hand after every card deploy.
--
-- MCP already has the mechanism for this: a server that declares
-- `tools.listChanged` SHOULD send `notifications/tools/list_changed`, and the
-- client re-fetches `tools/list` in response (spec 2025-06-18, Tools §
-- "List Changed Notification"). The server is stateless, so it has no memory of
-- what any client has seen — this column is that memory, and the smallest
-- possible form of it: the card build id the key was last served or notified
-- about.
--
-- NULL means "never served a tools/list", which is the correct starting point:
-- such a client has no cached listing to invalidate.
alter table public.api_keys
  add column if not exists card_build_notified text;

comment on column public.api_keys.card_build_notified is
  'Review-card build id (REVIEW_CARD_BUILD_ID) this key''s client last received in a tools/list, or was last sent notifications/tools/list_changed for. Set on tools/list, compared on tools/call. NULL until the first tools/list.';
