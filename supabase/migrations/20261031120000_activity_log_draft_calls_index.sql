-- ============================================================
-- MCPEmails - covering index for the draft card band
-- 20261031120000_activity_log_draft_calls_index
-- ============================================================
--
-- growth_draft_card_stats() counts draft tool calls per workspace:
--
--   WHERE created_at >= $1 AND created_at < $2 AND tool_name LIKE 'draft%'
--
-- LIKE cannot use (tool_name, created_at) under the database's collation, so
-- it walked the created_at index and visited every row in the window: about
-- 400,000 rows and 700,000 buffers, to keep 28,000. That was 800 ms of the
-- function's 1.2 s when warm, and over 9 s when those pages were cold, past
-- PostgREST's 8 s statement_timeout. The Draft card band on /admin/growth
-- showed "canceling statement due to statement timeout".
--
-- This index holds only draft calls and every column the function reads, so
-- the same read is an index-only scan of about 3 MB, and it grows with draft
-- calls rather than with all traffic.
--
-- ALREADY LIVE IN PRODUCTION. On prod the index was built per partition with
-- CREATE INDEX CONCURRENTLY, which cannot run inside a migration transaction,
-- and this statement attached those to the parent. This file holds the plain,
-- re-runnable equivalent: a no-op on prod, the same end state on a fresh
-- database. Created on the parent, so partitions that
-- ensure_activity_log_partitions() adds later get it automatically.

CREATE INDEX IF NOT EXISTS activity_log_draft_calls_idx
  ON public.activity_log (created_at)
  INCLUDE (workspace_id, api_key_id, tool_name, status, error_code)
  WHERE tool_name LIKE 'draft%';
