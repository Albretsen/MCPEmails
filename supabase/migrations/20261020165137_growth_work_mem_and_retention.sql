-- ============================================================
-- MCPEmails - growth dashboard work_mem + operational retention
-- 20261020165137_growth_work_mem_and_retention
-- ============================================================
--
-- ── 1. work_mem for the growth dashboard functions ────────────────────────
-- The server default is 5 MB. These read-only analytics functions sort and
-- hash a month of activity_log and spilled to disk on every dashboard load:
-- about 26,800 temp blocks (210 MB) per load across the seven below. At
-- 64 MB none of them spills (32 MB still spilled for five of them). Scoped to
-- the functions, so nothing else on the server gets more memory per node.
-- Latency is unchanged (the temp files were served from page cache); what
-- goes away is the disk write traffic.
--
-- A later CREATE OR REPLACE of any of these functions resets its SET list:
-- carry `SET work_mem = '64MB'` into the new definition.

ALTER FUNCTION public.growth_daily_metrics(integer)                 SET work_mem = '64MB';
ALTER FUNCTION public.growth_lifecycle_counts()                     SET work_mem = '64MB';
ALTER FUNCTION public.growth_engagement_bands(integer)              SET work_mem = '64MB';
ALTER FUNCTION public.growth_error_breakdown(integer)               SET work_mem = '64MB';
ALTER FUNCTION public.growth_active_workspaces(integer)             SET work_mem = '64MB';
ALTER FUNCTION public.growth_usage_volume(integer, integer)         SET work_mem = '64MB';
ALTER FUNCTION public.growth_acquisition_channels(integer)          SET work_mem = '64MB';
ALTER FUNCTION public.growth_user_directory(integer, integer, uuid) SET work_mem = '64MB';

-- ── 2. Retention for three operational tables ─────────────────────────────
-- None of these had a retention job, so each only grew:
--
--   triage_runs + triage_run_items   90 days, matching triage_seen_messages
--     and activity_log. Items go first so each run delete cascades nothing.
--   oauth_refresh_tokens             rows revoked more than 30 days ago.
--     Every refresh inserts a new row and revokes the old one, so 99% of the
--     table is dead rows. Nothing reads a revoked row back: the token
--     endpoint looks up `revoked_at IS NULL` only (a rotated token is simply
--     invalid_grant, there is no reuse detection keyed on old rows), the
--     dormant-grant sweep reads live rows only, and the triage engine treats
--     an api key with no chain rows as expiring on its own expires_at, which
--     for an OAuth key is an hour after its last refresh, so a chain dead for
--     30 days fails closed either way.
--   synthetic_monitor_runs           35 days. The public status page reads a
--     30-day window starting at 00:00 UTC 29 days ago, so 35 leaves margin.
--     Two kinds of row are kept: the oldest read run, because the status page
--     prints "monitoring since" from it, and any run an incident still points
--     at (the FK is ON DELETE SET NULL and would silently blank it).
--
-- Deletes run in batches of 5,000 so no single statement holds many row
-- locks or writes a large WAL burst. Runs daily at 04:50 UTC, clear of the
-- other nightly jobs (02:00 to 04:30).

CREATE OR REPLACE FUNCTION public.purge_operational_history()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  c_batch   constant integer := 5000;
  v_n       integer;
  v_items   integer := 0;
  v_runs    integer := 0;
  v_tokens  integer := 0;
  v_monitor integer := 0;
  v_first_monitor_run uuid;
BEGIN
  LOOP
    DELETE FROM public.triage_run_items
    WHERE id IN (
      SELECT i.id
      FROM public.triage_run_items i
      JOIN public.triage_runs r ON r.id = i.run_id
      WHERE r.started_at < now() - INTERVAL '90 days'
      LIMIT c_batch
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_items := v_items + v_n;
    EXIT WHEN v_n < c_batch;
  END LOOP;

  LOOP
    DELETE FROM public.triage_runs
    WHERE id IN (
      SELECT id FROM public.triage_runs
      WHERE started_at < now() - INTERVAL '90 days'
      LIMIT c_batch
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_runs := v_runs + v_n;
    EXIT WHEN v_n < c_batch;
  END LOOP;

  LOOP
    DELETE FROM public.oauth_refresh_tokens
    WHERE id IN (
      SELECT id FROM public.oauth_refresh_tokens
      WHERE revoked_at IS NOT NULL
        AND revoked_at < now() - INTERVAL '30 days'
      LIMIT c_batch
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_tokens := v_tokens + v_n;
    EXIT WHEN v_n < c_batch;
  END LOOP;

  SELECT id INTO v_first_monitor_run
  FROM public.synthetic_monitor_runs
  WHERE mode = 'read'
  ORDER BY started_at ASC
  LIMIT 1;

  LOOP
    DELETE FROM public.synthetic_monitor_runs
    WHERE id IN (
      SELECT r.id FROM public.synthetic_monitor_runs r
      WHERE r.started_at < now() - INTERVAL '35 days'
        AND r.id IS DISTINCT FROM v_first_monitor_run
        AND NOT EXISTS (
          SELECT 1 FROM public.synthetic_monitor_incidents x WHERE x.last_run_id = r.id
        )
      LIMIT c_batch
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_monitor := v_monitor + v_n;
    EXIT WHEN v_n < c_batch;
  END LOOP;

  RETURN jsonb_build_object(
    'triage_run_items', v_items,
    'triage_runs', v_runs,
    'oauth_refresh_tokens', v_tokens,
    'synthetic_monitor_runs', v_monitor
  );
END;
$$;

-- Internal maintenance only: never callable through PostgREST.
REVOKE ALL ON FUNCTION public.purge_operational_history() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule(
  'operational-history-retention',
  '50 4 * * *',
  $$SELECT public.purge_operational_history()$$
);
