-- ============================================================
-- MCPEmails - drop a duplicate index on oauth_refresh_tokens
-- 20261020164829_drop_duplicate_refresh_hash_index
-- ============================================================
--
-- oauth_refresh_tokens_refresh_hash_idx is btree (refresh_hash), the same
-- definition as oauth_refresh_tokens_refresh_hash_key, the index behind the
-- UNIQUE (refresh_hash) constraint. Every token insert maintained both (13 MB
-- each). Lookups by refresh_hash now use the constraint's index.
--
-- ALREADY LIVE IN PRODUCTION, dropped there with DROP INDEX CONCURRENTLY
-- (which cannot run inside a migration transaction). This file holds the
-- plain, re-runnable equivalent.

DROP INDEX IF EXISTS public.oauth_refresh_tokens_refresh_hash_idx;
