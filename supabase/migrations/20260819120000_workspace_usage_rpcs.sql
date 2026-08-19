-- ===========================================================================
-- Customer-facing usage aggregates for the dashboard.
--
-- WHY THIS FILE EXISTS
-- The dashboard's Usage page and inbox list aggregated raw rows in Node:
--
--   .from('activity_log').select('tool_name, inbox_id, created_at')
--     .eq('workspace_id', ...).gte('created_at', ...30d...)
--
-- then counted the array. This project runs PostgREST with db-max-rows = 1000,
-- which truncates a response at 1,000 rows and reports NO error, so every one
-- of those numbers was capped. Measured on production the day this was written:
-- the busiest workspace made 33,292 calls and consumed 26,611 billable actions
-- in 30 days, and the page told its owner 1,000 and 1,000.
--
-- Worse than the cap, the reads carried no ORDER BY. The 1,000 rows PostgREST
-- returns are then an arbitrary physical slice rather than the newest, so the
-- daily chart was a biased sample rather than a truncated tail, and "last
-- successful call" per inbox was the maximum of a random subset: a healthy
-- inbox could render as having had no successful call in 30 days.
--
-- The same class of bug was found and fixed on /admin/growth the same day
-- (20260819090000). The rule both fixes leave behind: if a number is an
-- aggregate, Postgres computes it. Never fetch rows in order to count them.
--
-- SECURITY
-- SECURITY INVOKER (the default), and granted to `authenticated` because the
-- caller here is the signed-in user's own RLS client, not the service role.
-- That is the whole safety argument: `activity_log` and `action_usage` both
-- carry a `workspace_id = ANY (my_workspace_ids())` SELECT policy, and an
-- invoker-rights function is subject to it, so passing another workspace's id
-- returns zeroes rather than someone else's usage. Marking either function
-- SECURITY DEFINER would turn `p_workspace_id` into a read of any workspace in
-- the system.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- workspace_usage_summary(p_workspace_id uuid, p_days int, p_meter_version int)
--
-- Everything the Usage page needs, as ONE jsonb row: there is no row count
-- here for a response cap to truncate, whatever the workspace's volume.
--
--   total_calls       int      - activity_log rows in the window
--   daily             [{date, count}]  - one entry per UTC day, zeros included,
--                                        oldest first
--   by_tool           [{tool, count}]  - descending
--   by_inbox          [{inbox_id, count}] - descending, inbox-attributed only
--   billable_actions  int      - the meter: SUM(quantity), not a row count
--   last_billable     [{tool, occurred_at}] - 30 most recent, newest first
--
-- `billable_actions` sums `quantity` rather than counting rows so it stays
-- correct if a future meter version bills an operation as more than one action.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.workspace_usage_summary(
  p_workspace_id uuid,
  p_days int DEFAULT 30,
  p_meter_version int DEFAULT 1
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT
      greatest(coalesce(p_days, 30), 1) AS days,
      (now() AT TIME ZONE 'utc')::date AS today
  ),
  -- Every day in the window, so a quiet day reads as a zero rather than as a
  -- missing bar. Built here rather than in the caller so the series and the
  -- counts can never disagree about which days the window covers.
  calendar AS (
    SELECT (b.today - offsets.n)::date AS day
    FROM bounds b, generate_series(0, (SELECT days FROM bounds) - 1) AS offsets(n)
  ),
  scoped AS (
    SELECT
      a.tool_name,
      a.inbox_id,
      (a.created_at AT TIME ZONE 'utc')::date AS day
    FROM public.activity_log a, bounds b
    WHERE a.workspace_id = p_workspace_id
      AND a.created_at >= ((b.today - (b.days - 1))::timestamp AT TIME ZONE 'utc')
  ),
  actions AS (
    SELECT au.tool_name, au.quantity, au.occurred_at
    FROM public.action_usage au, bounds b
    WHERE au.workspace_id = p_workspace_id
      AND au.billable
      AND au.meter_version = p_meter_version
      AND au.occurred_at >= ((b.today - (b.days - 1))::timestamp AT TIME ZONE 'utc')
  ),
  daily AS (
    SELECT c.day, count(s.day)::int AS calls
    FROM calendar c
    LEFT JOIN scoped s ON s.day = c.day
    GROUP BY c.day
  ),
  by_tool AS (
    SELECT s.tool_name, count(*)::int AS calls
    FROM scoped s
    WHERE s.tool_name IS NOT NULL
    GROUP BY s.tool_name
  ),
  by_inbox AS (
    SELECT s.inbox_id, count(*)::int AS calls
    FROM scoped s
    WHERE s.inbox_id IS NOT NULL
    GROUP BY s.inbox_id
  ),
  recent AS (
    SELECT a.tool_name, a.occurred_at
    FROM actions a
    ORDER BY a.occurred_at DESC
    LIMIT 30
  )
  SELECT jsonb_build_object(
    'total_calls', (SELECT count(*)::int FROM scoped),
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object('date', to_char(d.day, 'YYYY-MM-DD'), 'count', d.calls) ORDER BY d.day)
      FROM daily d
    ), '[]'::jsonb),
    'by_tool', coalesce((
      SELECT jsonb_agg(jsonb_build_object('tool', t.tool_name, 'count', t.calls) ORDER BY t.calls DESC, t.tool_name)
      FROM by_tool t
    ), '[]'::jsonb),
    'by_inbox', coalesce((
      SELECT jsonb_agg(jsonb_build_object('inbox_id', i.inbox_id, 'count', i.calls) ORDER BY i.calls DESC)
      FROM by_inbox i
    ), '[]'::jsonb),
    'billable_actions', (SELECT coalesce(sum(a.quantity), 0)::int FROM actions a),
    'last_billable', coalesce((
      SELECT jsonb_agg(jsonb_build_object('tool', r.tool_name, 'occurred_at', r.occurred_at) ORDER BY r.occurred_at DESC)
      FROM recent r
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- workspace_inbox_activity(p_workspace_id uuid, p_days int)
--
-- Per-inbox call count and last successful call, for the inbox list's health
-- column. One row per inbox that was used in the window, so this is bounded by
-- the workspace's own inbox count rather than by its call volume.
--
-- `last_success_at` is a real MAX over the window. The previous version took
-- the maximum of whatever 1,000 unordered rows came back, which is why a busy
-- inbox could claim it had not succeeded in 30 days.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.workspace_inbox_activity(
  p_workspace_id uuid,
  p_days int DEFAULT 30
)
RETURNS TABLE (
  inbox_id uuid,
  calls int,
  last_success_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    a.inbox_id,
    count(*)::int AS calls,
    max(a.created_at) FILTER (WHERE a.status = 'success') AS last_success_at
  FROM public.activity_log a
  WHERE a.workspace_id = p_workspace_id
    AND a.inbox_id IS NOT NULL
    AND a.created_at >= now() - make_interval(days => greatest(coalesce(p_days, 30), 1))
  GROUP BY a.inbox_id;
$$;

-- ---------------------------------------------------------------------------
-- Execution rights. Unlike the /admin/growth reporting functions, these are
-- called by the signed-in user, so `authenticated` needs EXECUTE. RLS on the
-- underlying tables is what scopes the result, and it applies because both
-- functions are SECURITY INVOKER. anon gets nothing.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.workspace_usage_summary(uuid, int, int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.workspace_inbox_activity(uuid, int) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.workspace_usage_summary(uuid, int, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workspace_inbox_activity(uuid, int) TO authenticated, service_role;
