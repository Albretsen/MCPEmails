-- Link a refresh-token chain to the single access-token row it rotates.
--
-- Previously each refresh_token grant inserted a brand-new api_keys row and left
-- the old one to expire, so the dashboard filled with hundreds of dead
-- "OAuth: <client>" rows and revoking a row never killed the underlying
-- connection (the refresh token kept minting new rows).
--
-- With this column, one connection == one api_keys row (rotated in place) plus a
-- chain of refresh tokens that all point back to that row. Revoking the row can
-- now cascade to its refresh tokens, and refresh can refuse to resurrect a
-- soft-deleted row.
--
-- Nullable for backwards compatibility: refresh tokens issued before this
-- migration have api_key_id IS NULL and are migrated to the new model on their
-- next refresh.
ALTER TABLE public.oauth_refresh_tokens
  ADD COLUMN IF NOT EXISTS api_key_id uuid REFERENCES public.api_keys(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_api_key_id_idx
  ON public.oauth_refresh_tokens (api_key_id);
