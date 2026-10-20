-- ============================================================
-- MCPEmails - disk IO relief
-- 20261013050000_disk_io_relief
-- ============================================================
--
-- WHY
-- ---
-- On 2026-10-13 Supabase warned that the project was depleting its Disk IO
-- budget. Three things in the database were feeding it:
--
--   1. activity_log had no index led by created_at. The kiosk health poll
--      (kiosk-health.ts, every 45 seconds) asks for the newest row and for
--      counts over a recent window; without this index the newest-row read
--      walked every partition's primary key, about 99,000 buffers a call.
--      With it the same read is 19.
--   2. net._http_response was 164 MB holding 928 rows. pg_net's worker
--      inserts and expires rows without autovacuum ever noticing, so the
--      heap only grew.
--   3. cron.job_run_details kept every run since the project was created
--      (318,000 rows). pg_cron never prunes it.
--
-- ALREADY LIVE IN PRODUCTION. On prod the index was built per partition with
-- CREATE INDEX CONCURRENTLY and attached to the parent, and both tables were
-- rewritten once with VACUUM FULL. Neither can run inside a migration
-- transaction, so this file holds the plain, re-runnable equivalents: every
-- statement here is a no-op on prod and builds the same end state on a fresh
-- database.

-- ── 1. created_at index on the partitioned activity log ───────────────────
-- Created on the parent, so partitions that ensure_activity_log_partitions()
-- adds later get it automatically.
CREATE INDEX IF NOT EXISTS activity_log_created_at_idx
  ON public.activity_log (created_at DESC);

-- ── 2. Keep pg_net's response table from bloating again ───────────────────
-- A plain VACUUM (no lock that blocks the worker) is enough once the table is
-- small: it lets each hour's expired rows be reused by the next hour's.
SELECT cron.schedule(
  'pg-net-response-vacuum',
  '7 * * * *',
  $$VACUUM net._http_response$$
);

-- ── 3. Retention for pg_cron's own run history ────────────────────────────
SELECT cron.schedule(
  'cron-run-details-retention',
  '30 4 * * *',
  $$DELETE FROM cron.job_run_details WHERE end_time < now() - INTERVAL '7 days'$$
);
