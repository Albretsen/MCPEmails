-- ===========================================================================
-- Give workspace_usage_summary() an explicit billing window for the meter.
--
-- 20260819120000 counted billable actions over the same trailing N-day window
-- as the activity chart. Those are two different questions. The chart really is
-- "the last 30 days"; the meter is "this billing period", which is the window
-- the cap applies over and the window enforcement counts. Measured on a
-- workspace whose Stripe period began 2026-08-03: /api/usage said 107 actions
-- used, a trailing 30 days said 109, same workspace, same day.
--
-- The caller now passes the period it resolved, using the single web-side
-- definition in `src/lib/usage/billing-window.ts`, which mirrors the edge
-- function's `resolveUsageBillingWindow()`. Passing it in rather than deriving
-- it here keeps one definition of a Stripe cycle instead of adding a fourth.
--
-- The previous signature is dropped rather than left as an overload: it was
-- applied hours earlier and no deployed code ever called it, and leaving a
-- same-named function that silently measures the wrong window is exactly the
-- kind of thing someone reaches for later.
-- ===========================================================================

DROP FUNCTION IF EXISTS public.workspace_usage_summary(uuid, int, int);

CREATE OR REPLACE FUNCTION public.workspace_usage_summary(
  p_workspace_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
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
  -- Every day in the activity window, so a quiet day reads as a zero rather
  -- than as a missing bar. Built here rather than in the caller so the series
  -- and the counts can never disagree about which days the window covers.
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
  -- The meter, over the billing period rather than the chart's window.
  actions AS (
    SELECT au.tool_name, au.quantity, au.occurred_at
    FROM public.action_usage au
    WHERE au.workspace_id = p_workspace_id
      AND au.billable
      AND au.meter_version = p_meter_version
      AND au.occurred_at >= p_period_start
      AND au.occurred_at < p_period_end
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

REVOKE ALL ON FUNCTION public.workspace_usage_summary(uuid, timestamptz, timestamptz, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.workspace_usage_summary(uuid, timestamptz, timestamptz, int, int) TO authenticated, service_role;
