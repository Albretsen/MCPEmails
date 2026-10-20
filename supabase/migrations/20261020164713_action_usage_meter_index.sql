-- ============================================================
-- MCPEmails - covering index for the action meter
-- 20261020164713_action_usage_meter_index
-- ============================================================
--
-- workspace_action_allowance() runs on every MCP tool call, and
-- reserve_action_usage(), workspace_usage_summary() and
-- growth_usage_cap_states() count the same rows:
--
--   WHERE workspace_id = $1 AND billable AND meter_version = $2
--     AND occurred_at >= $3 AND occurred_at < $4
--
-- The only index that matched was (workspace_id, occurred_at DESC) WHERE
-- billable, which lacks meter_version, so every count visited the heap for
-- each row in the window (5,068 buffers for the busiest workspace's month).
-- This index holds every column the predicate names, so the count is an
-- index-only scan.
--
-- meter_version is a key column, not part of the WHERE: the callers pass it
-- as a parameter (plpgsql variables are parameters too), and a cached generic
-- plan cannot prove `meter_version = $2` implies a partial-index predicate of
-- `meter_version = 1`.
--
-- action_usage_workspace_meter_occurred_idx (no billable filter) stays:
-- system-notify counts and reads a workspace's rows without `billable`, and
-- without that index those reads scan the whole table.
--
-- ALREADY LIVE IN PRODUCTION, built there with CREATE INDEX CONCURRENTLY
-- (which cannot run inside a migration transaction). This file holds the
-- plain, re-runnable equivalent: a no-op on prod, the same end state on a
-- fresh database.

CREATE INDEX IF NOT EXISTS action_usage_billable_ws_meter_occurred_idx
  ON public.action_usage (workspace_id, meter_version, occurred_at)
  WHERE billable;
