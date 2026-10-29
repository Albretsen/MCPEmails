-- ============================================================
-- MCPEmails - growth board reads a daily activity rollup
-- 20261028120000_growth_activity_daily_rollup
-- ============================================================
--
-- WHY. The growth board and the People directory call their RPCs through
-- PostgREST, whose role has statement_timeout = 8s. Nine of those RPCs
-- re-aggregated up to 90 days of activity_log (about a million rows in
-- October 2026) on every cold cache read, at 1.5 to 2 s each alone, and the
-- board fires them all at once. Under that contention they ran into the 8 s
-- cap and the section showed its error box; the People directory alone took
-- 3 to 10 s. activity_log grows with traffic, so this only got worse.
--
-- WHAT. Two small tables hold the per-day aggregates those RPCs need:
--
--   growth_activity_daily  one row per (UTC day, workspace)
--   growth_tool_daily      one row per (UTC day, tool, status, error code)
--
-- and the RPCs read them instead of activity_log. Their signatures and their
-- results are unchanged: every figure below is exact, not an approximation.
-- In particular a "session" (a run of successful calls with gaps under 30
-- minutes) is counted with its full history, and the window correction in
-- growth_window_sessions() reproduces the old rule that the first successful
-- call inside a window always starts a session.
--
-- FRESHNESS. `growth-activity-rollup` recomputes from an hour before midnight
-- UTC today every five minutes, so the board's activity figures are at most
-- five minutes behind (they were already cached for ten). `growth-activity-
-- rollup-rebuild` rebuilds everything at 02:10 UTC, after the 02:00 per-plan
-- activity_log purge, so the rollup never remembers a call the log has
-- forgotten and all-time figures keep matching the log.
--
-- Not moved: growth_usage_cap_overview and growth_draft_card_stats compare
-- activity_log against per-workspace timestamps (an anchor plus seven days),
-- which a day grain cannot answer exactly. They use the
-- (workspace_id, created_at) index and are not the slow part.

-- ── 1. Tables ─────────────────────────────────────────────────────────────

CREATE TABLE public.growth_activity_daily (
  day                    date        NOT NULL,
  workspace_id           uuid        NOT NULL,
  calls                  integer     NOT NULL,
  successes              integer     NOT NULL,
  errors                 integer     NOT NULL,  -- status = 'error'
  rate_limited           integer     NOT NULL,  -- status = 'rate_limited'
  -- A success that touched a mailbox, the value-activation definition:
  -- inbox_id IS NOT NULL AND tool_name <> 'inbox_list'.
  value_successes        integer     NOT NULL,
  -- Successes that start a session: no earlier success by the workspace
  -- within 30 minutes, looking back across midnight.
  session_starts         integer     NOT NULL,
  -- Whether the day's first success was one of those starts. NULL on a day
  -- with no success.
  first_success_starts   boolean,
  first_success_at       timestamptz,
  last_success_at        timestamptz,
  last_value_success_at  timestamptz,
  last_call_at           timestamptz NOT NULL,
  PRIMARY KEY (day, workspace_id)
);

CREATE INDEX growth_activity_daily_workspace_day
  ON public.growth_activity_daily (workspace_id, day);

CREATE TABLE public.growth_tool_daily (
  day         date    NOT NULL,
  tool_name   text    NOT NULL,
  status      text    NOT NULL,
  error_code  text,
  calls       integer NOT NULL
);

CREATE INDEX growth_tool_daily_day ON public.growth_tool_daily (day);

-- Aggregates only, read by SECURITY INVOKER functions under service_role.
ALTER TABLE public.growth_activity_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.growth_tool_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.growth_activity_daily FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.growth_tool_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.growth_activity_daily TO service_role;
GRANT SELECT ON public.growth_tool_daily TO service_role;

-- ── 2. Refresh ────────────────────────────────────────────────────────────

-- Recompute every day from p_from (UTC) onward; NULL rebuilds everything.
-- One transaction, so readers see either the old rows or the new ones.
CREATE OR REPLACE FUNCTION public.growth_activity_rollup_refresh(p_from date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
SET work_mem = '64MB'
AS $$
DECLARE
  v_from timestamptz := CASE
    WHEN p_from IS NULL THEN '-infinity'::timestamptz
    ELSE (p_from::timestamp AT TIME ZONE 'utc')
  END;
  v_rows integer;
BEGIN
  -- The five-minute job and the nightly rebuild must not interleave.
  PERFORM pg_advisory_xact_lock(hashtext('growth_activity_rollup'));

  DELETE FROM public.growth_activity_daily WHERE p_from IS NULL OR day >= p_from;
  DELETE FROM public.growth_tool_daily WHERE p_from IS NULL OR day >= p_from;

  INSERT INTO public.growth_activity_daily (
    day, workspace_id, calls, successes, errors, rate_limited, value_successes,
    session_starts, first_success_starts, first_success_at, last_success_at,
    last_value_success_at, last_call_at
  )
  WITH src AS (
    -- 30 minutes before p_from, so the first success after it still sees
    -- the success that may precede it within the session gap.
    SELECT a.workspace_id, a.status, a.inbox_id, a.tool_name, a.created_at
    FROM public.activity_log a
    WHERE a.created_at >= v_from - interval '30 minutes'
  ),
  starts AS (
    SELECT
      s.workspace_id,
      s.created_at,
      lag(s.created_at) OVER (PARTITION BY s.workspace_id ORDER BY s.created_at) AS previous_at
    FROM src s
    WHERE s.status = 'success'
  ),
  start_days AS (
    SELECT
      st.workspace_id,
      (st.created_at AT TIME ZONE 'utc')::date AS day,
      count(*) AS session_starts,
      min(st.created_at) AS first_start_at
    FROM starts st
    WHERE st.created_at >= v_from
      AND (st.previous_at IS NULL OR st.created_at - st.previous_at >= interval '30 minutes')
    GROUP BY 1, 2
  ),
  days AS (
    SELECT
      s.workspace_id,
      (s.created_at AT TIME ZONE 'utc')::date AS day,
      count(*) AS calls,
      count(*) FILTER (WHERE s.status = 'success') AS successes,
      count(*) FILTER (WHERE s.status = 'error') AS errors,
      count(*) FILTER (WHERE s.status = 'rate_limited') AS rate_limited,
      count(*) FILTER (
        WHERE s.status = 'success' AND s.inbox_id IS NOT NULL AND s.tool_name <> 'inbox_list'
      ) AS value_successes,
      min(s.created_at) FILTER (WHERE s.status = 'success') AS first_success_at,
      max(s.created_at) FILTER (WHERE s.status = 'success') AS last_success_at,
      max(s.created_at) FILTER (
        WHERE s.status = 'success' AND s.inbox_id IS NOT NULL AND s.tool_name <> 'inbox_list'
      ) AS last_value_success_at,
      max(s.created_at) AS last_call_at
    FROM src s
    WHERE s.created_at >= v_from
    GROUP BY 1, 2
  )
  SELECT
    d.day,
    d.workspace_id,
    d.calls,
    d.successes,
    d.errors,
    d.rate_limited,
    d.value_successes,
    coalesce(sd.session_starts, 0),
    -- The first success starts a session exactly when the earliest start of
    -- the day is that success.
    CASE WHEN d.first_success_at IS NULL THEN NULL
         ELSE sd.first_start_at IS NOT DISTINCT FROM d.first_success_at END,
    d.first_success_at,
    d.last_success_at,
    d.last_value_success_at,
    d.last_call_at
  FROM days d
  LEFT JOIN start_days sd ON sd.workspace_id = d.workspace_id AND sd.day = d.day;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  INSERT INTO public.growth_tool_daily (day, tool_name, status, error_code, calls)
  SELECT (a.created_at AT TIME ZONE 'utc')::date, a.tool_name, a.status, a.error_code, count(*)
  FROM public.activity_log a
  WHERE a.created_at >= v_from
  GROUP BY 1, 2, 3, 4;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.growth_activity_rollup_refresh(date) FROM PUBLIC, anon, authenticated;

-- Sessions in a window, from rollup rows already filtered to that window and
-- to days with a success. Inside a window the first success always opens a
-- session, so add one when the window's first active day began mid-session.
CREATE OR REPLACE FUNCTION public.growth_window_sessions(p_starts integer[], p_first_starts boolean[])
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT (SELECT coalesce(sum(s), 0) FROM unnest(p_starts) AS s)::int
       + CASE WHEN p_first_starts[1] IS FALSE THEN 1 ELSE 0 END;
$$;

REVOKE ALL ON FUNCTION public.growth_window_sessions(integer[], boolean[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_window_sessions(integer[], boolean[]) TO service_role;

-- ── 3. The RPCs, reading the rollup ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.growth_daily_metrics(p_days integer)
 RETURNS TABLE(day date, new_workspaces integer, technical_activations integer, value_activations integer, active_7d integer, active_28d integer, calls integer, successes integer, errors integer, rate_limited integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET work_mem TO '64MB'
AS $function$
  WITH bounds AS (
    SELECT
      (now() AT TIME ZONE 'utc')::date AS last_day,
      (now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 28), 1) - 1) AS first_day
  ),
  series AS (
    SELECT b.first_day + offsets.n AS day
    FROM bounds b,
         generate_series(0, greatest(coalesce(p_days, 28), 1) - 1) AS offsets(n)
  ),
  -- Read 27 days further back than the window so the 28-day rolling count is
  -- already complete on the window's first day rather than ramping up.
  activity AS (
    SELECT d.workspace_id, d.day, d.calls, d.successes, d.errors, d.rate_limited
    FROM public.growth_activity_daily d, bounds b
    WHERE d.day >= b.first_day - 27
      AND d.day <= b.last_day
  ),
  call_totals AS (
    SELECT
      act.day AS day,
      sum(act.calls) AS calls,
      sum(act.successes) AS successes,
      sum(act.errors) AS errors,
      sum(act.rate_limited) AS rate_limited
    FROM activity act, bounds b
    WHERE act.day >= b.first_day
    GROUP BY act.day
  ),
  active_days AS (
    SELECT act.workspace_id, act.day
    FROM activity act
    WHERE act.successes > 0
  ),
  rolling AS (
    SELECT
      s.day AS day,
      count(DISTINCT ad.workspace_id) FILTER (WHERE ad.day >= s.day - 6) AS active_7d,
      count(DISTINCT ad.workspace_id) AS active_28d
    FROM series s
    LEFT JOIN active_days ad ON ad.day BETWEEN s.day - 27 AND s.day
    GROUP BY s.day
  ),
  signups AS (
    SELECT (w.created_at AT TIME ZONE 'utc')::date AS day, count(*) AS n
    FROM public.workspaces w
    WHERE w.deleted_at IS NULL
    GROUP BY 1
  ),
  -- Activation days come from the durable onboarding columns, not from
  -- re-deriving a first call out of activity_log, which is purged at 90 days.
  technical AS (
    SELECT (w.onboarding_technical_activated_at AT TIME ZONE 'utc')::date AS day, count(*) AS n
    FROM public.workspaces w
    WHERE w.deleted_at IS NULL AND w.onboarding_technical_activated_at IS NOT NULL
    GROUP BY 1
  ),
  value_act AS (
    SELECT (w.onboarding_value_activated_at AT TIME ZONE 'utc')::date AS day, count(*) AS n
    FROM public.workspaces w
    WHERE w.deleted_at IS NULL AND w.onboarding_value_activated_at IS NOT NULL
    GROUP BY 1
  )
  SELECT
    s.day,
    coalesce(sg.n, 0)::int,
    coalesce(tech.n, 0)::int,
    coalesce(val.n, 0)::int,
    coalesce(r.active_7d, 0)::int,
    coalesce(r.active_28d, 0)::int,
    coalesce(ct.calls, 0)::int,
    coalesce(ct.successes, 0)::int,
    coalesce(ct.errors, 0)::int,
    coalesce(ct.rate_limited, 0)::int
  FROM series s
  LEFT JOIN rolling r ON r.day = s.day
  LEFT JOIN call_totals ct ON ct.day = s.day
  LEFT JOIN signups sg ON sg.day = s.day
  LEFT JOIN technical tech ON tech.day = s.day
  LEFT JOIN value_act val ON val.day = s.day
  ORDER BY s.day;
$function$;

CREATE OR REPLACE FUNCTION public.growth_engagement_bands(p_days integer)
 RETURNS TABLE(metric text, band text, workspaces integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET work_mem TO '64MB'
AS $function$
  WITH bounds AS (
    SELECT
      (now() AT TIME ZONE 'utc')::date AS last_day,
      (now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 28), 1) - 1) AS first_day
  ),
  -- A session boundary is a gap of at least 30 minutes from the immediately
  -- preceding successful call, which is exactly what buildSessions() does.
  per_workspace AS (
    SELECT
      d.workspace_id,
      count(*) AS active_days,
      public.growth_window_sessions(
        array_agg(d.session_starts ORDER BY d.day),
        array_agg(d.first_success_starts ORDER BY d.day)
      ) AS sessions
    FROM public.growth_activity_daily d, bounds b
    WHERE d.successes > 0
      AND d.day >= b.first_day
      AND d.day <= b.last_day
    GROUP BY d.workspace_id
  ),
  banded AS (
    SELECT
      pair.metric AS metric,
      CASE
        WHEN pair.value <= 1 THEN '1'
        WHEN pair.value <= 3 THEN '2–3'
        WHEN pair.value <= 7 THEN '4–7'
        ELSE '8+'
      END AS band
    FROM per_workspace pw
    CROSS JOIN LATERAL (
      VALUES ('active_days'::text, pw.active_days), ('sessions'::text, pw.sessions)
    ) AS pair(metric, value)
  ),
  metric_list AS (
    SELECT * FROM (VALUES (1, 'active_days'::text), (2, 'sessions'::text)) AS m(ordinal, metric)
  ),
  band_list AS (
    SELECT * FROM (
      VALUES (1, '1'::text), (2, '2–3'::text), (3, '4–7'::text), (4, '8+'::text)
    ) AS bl(ordinal, band)
  )
  SELECT
    m.metric,
    bl.band,
    count(bd.metric)::int
  FROM metric_list m
  CROSS JOIN band_list bl
  LEFT JOIN banded bd ON bd.metric = m.metric AND bd.band = bl.band
  GROUP BY m.ordinal, m.metric, bl.ordinal, bl.band
  ORDER BY m.ordinal, bl.ordinal;
$function$;

CREATE OR REPLACE FUNCTION public.growth_active_workspaces(p_days integer)
 RETURNS TABLE(workspace_id uuid, workspace_name text, owner_email text, plan text, is_comped boolean, created_at timestamp with time zone, value_activated_at timestamp with time zone, last_active_at timestamp with time zone, active_days integer, sessions integer, calls integer, successes integer, errors integer, inboxes integer, providers text, client text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET work_mem TO '64MB'
AS $function$
  WITH bounds AS (
    SELECT
      (now() AT TIME ZONE 'utc')::date AS last_day,
      (now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 28), 1) - 1) AS first_day
  ),
  usage AS (
    SELECT
      d.workspace_id,
      max(d.last_success_at) AS last_active_at,
      count(*) FILTER (WHERE d.successes > 0) AS active_days,
      sum(d.calls) AS calls,
      sum(d.successes) AS successes,
      sum(d.calls - d.successes) AS errors,
      -- A new session starts whenever the gap from the previous successful
      -- call by the same workspace reaches 30 minutes.
      public.growth_window_sessions(
        array_agg(d.session_starts ORDER BY d.day) FILTER (WHERE d.successes > 0),
        array_agg(d.first_success_starts ORDER BY d.day) FILTER (WHERE d.successes > 0)
      ) AS sessions
    FROM public.growth_activity_daily d, bounds b
    WHERE d.day >= b.first_day
      AND d.day <= b.last_day
    GROUP BY d.workspace_id
    HAVING sum(d.successes) > 0
  ),
  -- Connected mailboxes, named by service where the provider alone would say
  -- nothing useful (every app-password connection is stored as 'imap').
  inbox_rollup AS (
    SELECT
      i.workspace_id,
      count(*)::int AS inboxes,
      string_agg(DISTINCT
        CASE WHEN i.provider = 'imap' AND i.service IS NOT NULL AND i.service <> 'generic'
          THEN i.service ELSE i.provider END, ', ' ORDER BY
        CASE WHEN i.provider = 'imap' AND i.service IS NOT NULL AND i.service <> 'generic'
          THEN i.service ELSE i.provider END) AS providers
    FROM public.inboxes i
    WHERE i.deleted_at IS NULL AND i.status = 'active'
    GROUP BY i.workspace_id
  )
  SELECT
    w.id AS workspace_id,
    coalesce(nullif(w.display_name, ''), w.slug, 'unnamed') AS workspace_name,
    u.email AS owner_email,
    coalesce(w.plan, 'free') AS plan,
    -- coalesce, not a bare comparison: the LEFT JOIN leaves e.kind NULL for
    -- every account that is NOT comped, and `NULL = 'comped_scale'` is NULL.
    coalesce(e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now()), false) AS is_comped,
    w.created_at,
    w.onboarding_value_activated_at AS value_activated_at,
    usage.last_active_at,
    usage.active_days::int,
    usage.sessions,
    usage.calls::int,
    usage.successes::int,
    usage.errors::int,
    coalesce(inbox_rollup.inboxes, 0) AS inboxes,
    coalesce(inbox_rollup.providers, '') AS providers,
    coalesce(w.analytics_first_tool_client, 'unknown') AS client
  FROM usage
  JOIN public.workspaces w ON w.id = usage.workspace_id AND w.deleted_at IS NULL
  LEFT JOIN public.users u ON u.id = w.owner_id
  LEFT JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
  LEFT JOIN inbox_rollup ON inbox_rollup.workspace_id = usage.workspace_id
  ORDER BY usage.last_active_at DESC;
$function$;

CREATE OR REPLACE FUNCTION public.growth_error_breakdown(p_days integer)
 RETURNS TABLE(tool_name text, error_code text, failures integer, calls integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET work_mem TO '64MB'
AS $function$
  WITH bounds AS (
    SELECT (now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 28), 1) - 1) AS first_day
  ),
  windowed AS (
    SELECT public.growth_public_tool_name(t.tool_name) AS tool_name, t.status, t.error_code, t.calls
    FROM public.growth_tool_daily t, bounds b
    WHERE t.day >= b.first_day
  ),
  tool_totals AS (
    SELECT w.tool_name AS tool_name, sum(w.calls) AS calls
    FROM windowed w
    GROUP BY w.tool_name
  ),
  failures AS (
    SELECT w.tool_name AS tool_name, w.error_code AS error_code, sum(w.calls) AS failures
    FROM windowed w
    WHERE w.status <> 'success'
    GROUP BY w.tool_name, w.error_code
  )
  SELECT
    f.tool_name,
    f.error_code,
    f.failures::int,
    t.calls::int
  FROM failures f
  JOIN tool_totals t ON t.tool_name = f.tool_name
  ORDER BY f.failures DESC, f.tool_name, f.error_code
  LIMIT 20;
$function$;

CREATE OR REPLACE FUNCTION public.growth_lifecycle_counts()
 RETURNS TABLE(value_activated integer, one_and_done integer, at_risk integer, active_7d integer, active_28d integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET work_mem TO '64MB'
AS $function$
  WITH bounds AS (
    SELECT (now() AT TIME ZONE 'utc')::date AS today
  ),
  value_activity AS (
    SELECT
      d.workspace_id,
      count(*) AS active_day_count,
      max(d.day) AS last_active_day,
      max(d.last_value_success_at) AS last_active_at
    FROM public.growth_activity_daily d
    WHERE d.value_successes > 0
    GROUP BY d.workspace_id
  ),
  cohort AS (
    SELECT va.active_day_count, va.last_active_day, va.last_active_at
    FROM public.workspaces w
    LEFT JOIN value_activity va ON va.workspace_id = w.id
    WHERE w.deleted_at IS NULL
      AND w.onboarding_value_activated_at IS NOT NULL
  ),
  recent AS (
    SELECT
      count(DISTINCT d.workspace_id) FILTER (WHERE d.day >= b.today - 6) AS in_7d,
      count(DISTINCT d.workspace_id) AS in_28d
    FROM public.growth_activity_daily d, bounds b
    WHERE d.successes > 0
      AND d.day >= b.today - 27
  )
  SELECT
    count(*)::int,
    count(*) FILTER (
      WHERE c.active_day_count = 1 AND c.last_active_day < (SELECT b.today FROM bounds b)
    )::int,
    count(*) FILTER (
      WHERE c.active_day_count >= 2 AND c.last_active_at < now() - interval '14 days'
    )::int,
    (SELECT r.in_7d FROM recent r)::int,
    (SELECT r.in_28d FROM recent r)::int
  FROM cohort c;
$function$;

CREATE OR REPLACE FUNCTION public.growth_acquisition_channels(p_days integer DEFAULT 28)
 RETURNS TABLE(source text, signups integer, activated integer, returned integer, paying integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET work_mem TO '64MB'
AS $function$
  WITH cohort AS (
    SELECT
      w.id,
      COALESCE(nullif(w.acquisition_source, ''), 'unattributed') AS source,
      w.onboarding_value_activated_at IS NOT NULL AS activated,
      COALESCE(ub.plan, 'free') <> 'free'
        AND NOT COALESCE(
              e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now()),
              false
            ) AS paying
    FROM public.workspaces w
    LEFT JOIN public.user_billing ub ON ub.user_id = w.owner_id
    LEFT JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
    WHERE w.deleted_at IS NULL
      AND w.created_at >= (now() - make_interval(days => greatest(p_days, 1)))
  ),
  active_days AS (
    SELECT d.workspace_id, count(*) AS days
    FROM public.growth_activity_daily d
    WHERE d.successes > 0
      AND d.workspace_id IN (SELECT id FROM cohort)
    GROUP BY 1
  )
  SELECT
    cohort.source,
    count(*)::int,
    count(*) FILTER (WHERE cohort.activated)::int,
    count(*) FILTER (WHERE COALESCE(active_days.days, 0) > 1)::int,
    count(*) FILTER (WHERE cohort.paying)::int
  FROM cohort
  LEFT JOIN active_days ON active_days.workspace_id = cohort.id
  GROUP BY cohort.source
  ORDER BY 2 DESC, 1;
$function$;

CREATE OR REPLACE FUNCTION public.growth_people_counts(p_days integer DEFAULT 28, p_internal_emails text[] DEFAULT '{}'::text[], p_internal_domains text[] DEFAULT '{}'::text[])
 RETURNS TABLE(total_users integer, total_users_prior integer, new_users integer, prev_new_users integer, active_users integer, prev_active_users integer, active_users_7d integer, activated_users integer, internal_users integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH bounds AS (
    SELECT
      now() AS now_at,
      now() - make_interval(days => greatest(p_days, 1)) AS window_start,
      now() - make_interval(days => greatest(p_days, 1) * 2) AS prev_start,
      now() - interval '7 days' AS since_7d
  ),
  scoped AS (
    SELECT
      u.id,
      u.created_at,
      public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains) AS is_internal
    FROM public.users u
  ),
  external_users AS (
    SELECT s.id, s.created_at FROM scoped s WHERE NOT s.is_internal
  ),
  -- These windows end at now(), not at midnight, so a day row answers them
  -- through its first and last success: some success falls at or after T
  -- exactly when the last one does, and some falls before T exactly when the
  -- first one does. The previous window is at least a day wide, so no single
  -- day straddles both of its ends.
  owner_activity AS (
    SELECT
      w.owner_id,
      bool_or(d.last_success_at >= b.window_start) AS in_window,
      bool_or(d.first_success_at < b.window_start AND d.last_success_at >= b.prev_start) AS in_prev,
      bool_or(d.last_success_at >= b.since_7d) AS in_7d
    FROM public.growth_activity_daily d
    JOIN public.workspaces w ON w.id = d.workspace_id
    CROSS JOIN bounds b
    WHERE d.successes > 0
      AND d.day >= (b.prev_start AT TIME ZONE 'utc')::date
    GROUP BY w.owner_id
  ),
  activated AS (
    SELECT DISTINCT w.owner_id
    FROM public.workspaces w
    WHERE w.onboarding_value_activated_at IS NOT NULL
  )
  SELECT
    (SELECT count(*) FROM external_users)::int,
    (SELECT count(*) FROM external_users e, bounds b WHERE e.created_at < b.window_start)::int,
    (SELECT count(*) FROM external_users e, bounds b WHERE e.created_at >= b.window_start)::int,
    (SELECT count(*) FROM external_users e, bounds b
      WHERE e.created_at >= b.prev_start AND e.created_at < b.window_start)::int,
    (SELECT count(*) FROM owner_activity oa JOIN external_users e ON e.id = oa.owner_id
      WHERE oa.in_window)::int,
    (SELECT count(*) FROM owner_activity oa JOIN external_users e ON e.id = oa.owner_id
      WHERE oa.in_prev)::int,
    (SELECT count(*) FROM owner_activity oa JOIN external_users e ON e.id = oa.owner_id
      WHERE oa.in_7d)::int,
    (SELECT count(*) FROM activated ac JOIN external_users e ON e.id = ac.owner_id)::int,
    (SELECT count(*) FROM scoped s WHERE s.is_internal)::int;
$function$;

CREATE OR REPLACE FUNCTION public.growth_cohort_retention(p_weeks integer)
 RETURNS TABLE(cohort_week date, cohort_size integer, week_index integer, retained integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH bounds AS (
    SELECT
      date_trunc('week', (now() AT TIME ZONE 'utc'))::date AS current_week,
      date_trunc('week', (now() AT TIME ZONE 'utc'))::date
        - ((greatest(coalesce(p_weeks, 8), 1) - 1) * 7) AS earliest_week
  ),
  cohorts AS (
    SELECT
      date_trunc('week', (w.created_at AT TIME ZONE 'utc'))::date AS cohort_week,
      w.id AS workspace_id
    FROM public.workspaces w, bounds b
    WHERE w.deleted_at IS NULL
      AND date_trunc('week', (w.created_at AT TIME ZONE 'utc'))::date >= b.earliest_week
  ),
  sizes AS (
    SELECT co.cohort_week AS cohort_week, count(*) AS cohort_size
    FROM cohorts co
    GROUP BY co.cohort_week
  ),
  active_weeks AS (
    SELECT DISTINCT
      d.workspace_id,
      date_trunc('week', d.day)::date AS week
    FROM public.growth_activity_daily d, bounds b
    WHERE d.successes > 0
      AND d.day >= b.earliest_week
  ),
  cells AS (
    SELECT sz.cohort_week AS cohort_week, sz.cohort_size AS cohort_size, idx.week_index AS week_index
    FROM sizes sz, bounds b,
         LATERAL generate_series(0, ((b.current_week - sz.cohort_week) / 7)::int) AS idx(week_index)
  )
  SELECT
    cl.cohort_week,
    cl.cohort_size::int,
    cl.week_index::int,
    count(DISTINCT aw.workspace_id)::int
  FROM cells cl
  LEFT JOIN cohorts co ON co.cohort_week = cl.cohort_week
  LEFT JOIN active_weeks aw
    ON aw.workspace_id = co.workspace_id
   AND aw.week = cl.cohort_week + (cl.week_index * 7)
  GROUP BY cl.cohort_week, cl.cohort_size, cl.week_index
  ORDER BY cl.cohort_week, cl.week_index;
$function$;

CREATE OR REPLACE FUNCTION public.growth_retention_curve(p_weeks integer, p_internal_emails text[] DEFAULT '{}'::text[], p_internal_domains text[] DEFAULT '{}'::text[])
 RETURNS TABLE(week_index integer, eligible integer, retained integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH bounds AS (
    SELECT (now() AT TIME ZONE 'utc')::date AS today
  ),
  cohort AS (
    SELECT
      w.id AS workspace_id,
      (w.onboarding_value_activated_at AT TIME ZONE 'utc')::date AS cohort_day
    FROM public.workspaces w
    LEFT JOIN public.users u ON u.id = w.owner_id
    WHERE w.deleted_at IS NULL
      AND w.onboarding_value_activated_at IS NOT NULL
      -- Ours, not a customer's; an owner with no users row counts as
      -- external, matching isInternalAccount().
      AND NOT public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains)
  ),
  weeks AS (
    SELECT generate_series(1, greatest(coalesce(p_weeks, 8), 1)) AS week_index
  )
  SELECT
    wk.week_index::int,
    count(*)::int,
    count(hit.matched)::int
  FROM weeks wk
  JOIN cohort c ON true
  -- The +1 is the excluded activation day: the window ends one day later than
  -- a day-0 based window would, so eligibility waits for it too.
  JOIN bounds b ON (c.cohort_day + 1 + (wk.week_index * 7)) <= b.today
  LEFT JOIN LATERAL (
    SELECT 1 AS matched
    FROM public.growth_activity_daily d
    WHERE d.workspace_id = c.workspace_id
      AND d.value_successes > 0
      AND d.day >= c.cohort_day + 1 + ((wk.week_index - 1) * 7)
      AND d.day < c.cohort_day + 1 + (wk.week_index * 7)
    LIMIT 1
  ) hit ON true
  GROUP BY wk.week_index
  ORDER BY wk.week_index;
$function$;

CREATE OR REPLACE FUNCTION public.growth_user_directory(p_days integer, p_limit integer, p_user_id uuid)
 RETURNS TABLE(user_id uuid, email text, display_name text, avatar_url text, signed_up_at timestamp with time zone, is_internal boolean, unsubscribed_at timestamp with time zone, unsubscribed_categories text[], workspaces integer, memberships integer, primary_workspace_id uuid, primary_workspace_name text, primary_workspace_slug text, plan text, is_comped boolean, unlimited_inboxes boolean, grandfathered boolean, acquisition_source text, acquisition_utm_source text, acquisition_utm_medium text, acquisition_utm_campaign text, acquisition_landing_path text, acquisition_referrer text, acquisition_locale text, onboarding_stage text, onboarding_client text, first_inbox_connected_at timestamp with time zone, first_inbox_provider text, first_credential_created_at timestamp with time zone, first_credential_method text, first_tool_used_at timestamp with time zone, first_tool_name text, first_tool_client text, value_activated_at timestamp with time zone, inboxes integer, inboxes_broken integer, providers text, api_keys integer, key_last_used_at timestamp with time zone, calls integer, successes integer, active_days integer, last_active_at timestamp with time zone, paywall_hits integer, billing_plan text, subscription_status text, stripe_customer_id text, current_period_end timestamp with time zone, total_rows integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET work_mem TO '64MB'
AS $function$
  WITH bounds AS (
    SELECT
      ((((now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 90), 1) - 1))::timestamp)
        AT TIME ZONE 'utc') AS window_start
  ),
  -- The population. Filtering here rather than at the end keeps every rollup
  -- below scanning one person's rows when a detail page asks for one person.
  people AS (
    SELECT u.* FROM public.users u
    WHERE p_user_id IS NULL OR u.id = p_user_id
  ),
  -- Live workspaces only. A deleted workspace keeps its rows but stops being
  -- something the person has; the timeline is where a deletion shows up.
  owned AS (
    SELECT w.*
    FROM public.workspaces w
    JOIN people p ON p.id = w.owner_id
    WHERE w.deleted_at IS NULL
  ),
  -- The workspace created at signup, which is the one carrying the acquisition
  -- columns worth reading. Later workspaces are created from inside the product
  -- and their acquisition_* are all NULL by construction.
  primary_ws AS (
    SELECT DISTINCT ON (w.owner_id) w.*
    FROM owned w
    ORDER BY w.owner_id, w.created_at ASC
  ),
  -- Everything that is a max/min over ALL of a person's workspaces rather than
  -- over the first one: they can connect a mailbox in the second workspace.
  --
  -- THE ANALYTICS COLUMNS ARE NOT TRUSTED ON THEIR OWN, and the journey panel
  -- is what exposed it: for a customer who signed up in July they read 2 and 3
  -- September, six weeks after the mailbox and the key those dates are supposed
  -- to be about. They were only written from the day the funnel instrumentation
  -- shipped, so for everybody older they date the instrumentation and not the
  -- event, and a journey drawn from them reads as three steps taken out of
  -- order.
  --
  -- Each rung is therefore floored by something that PROVES the step happened,
  -- and by nothing else. Not by tidiness: every floor below is a definition.
  --   a mailbox row IS a connection      -> min(inboxes.created_at)
  --   an api key row IS a credential     -> min(api_keys.created_at)
  --   value activation IS a tool call, by its own definition, and so is
  --   technical activation               -> floors the first-call date
  -- Nothing is floored by a later rung in general, because that would invent an
  -- ordering rather than record one. What inconsistency survives is real, and
  -- the page prints it as out of order rather than hiding it.
  owned_rollup AS (
    SELECT
      w.owner_id,
      count(*)::int AS workspaces,
      bool_or(w.grandfathered) AS grandfathered,
      max(CASE w.plan
            WHEN 'enterprise' THEN 4 WHEN 'pro' THEN 3
            WHEN 'solo' THEN 2 WHEN 'personal' THEN 1 ELSE 0 END) AS plan_rank,
      least(
        min(w.analytics_first_inbox_connected_at),
        min(w.onboarding_inbox_connected_at),
        min(first_inbox.at)
      ) AS first_inbox_connected_at,
      least(
        min(w.analytics_first_credential_created_at),
        min(w.onboarding_credential_issued_at),
        min(first_key.at)
      ) AS first_credential_created_at,
      least(
        min(w.analytics_first_tool_used_at),
        min(w.onboarding_technical_activated_at),
        min(w.onboarding_value_activated_at)
      ) AS first_tool_used_at,
      min(w.onboarding_value_activated_at) AS value_activated_at
    FROM owned w
    -- Grouped once rather than a lateral per workspace: api_keys has no
    -- workspace index, and the lateral seq-scanned it ~1,800 times (1 s).
    LEFT JOIN (
      SELECT i.workspace_id, min(i.created_at) AS at FROM public.inboxes i GROUP BY i.workspace_id
    ) first_inbox ON first_inbox.workspace_id = w.id
    LEFT JOIN (
      SELECT k.workspace_id, min(k.created_at) AS at FROM public.api_keys k
      WHERE k.kind IS NULL GROUP BY k.workspace_id
    ) first_key ON first_key.workspace_id = w.id
    GROUP BY w.owner_id
  ),
  -- Seats on somebody else's workspace. Counted separately because none of the
  -- usage below can see them; see the header.
  memberships AS (
    SELECT m.user_id, count(*)::int AS memberships
    FROM public.workspace_members m
    JOIN public.workspaces w ON w.id = m.workspace_id
    JOIN people p ON p.id = m.user_id
    WHERE w.deleted_at IS NULL AND w.owner_id <> m.user_id
    GROUP BY m.user_id
  ),
  usage AS (
    SELECT
      w.owner_id AS user_id,
      sum(a.calls)::int AS calls,
      sum(a.successes)::int AS successes,
      count(*) FILTER (WHERE a.successes > 0)::int AS active_days,
      max(a.last_call_at) AS last_active_at
    FROM public.growth_activity_daily a
    JOIN owned w ON w.id = a.workspace_id
    CROSS JOIN bounds b
    WHERE a.day >= (b.window_start AT TIME ZONE 'utc')::date
    GROUP BY w.owner_id
  ),
  inbox_rollup AS (
    SELECT
      w.owner_id AS user_id,
      count(*) FILTER (WHERE i.status = 'active')::int AS inboxes,
      count(*) FILTER (WHERE i.status <> 'active')::int AS inboxes_broken,
      string_agg(DISTINCT public.growth_inbox_label(i.provider, i.service), ', '
        ORDER BY public.growth_inbox_label(i.provider, i.service)) AS providers
    FROM public.inboxes i
    JOIN owned w ON w.id = i.workspace_id
    WHERE i.deleted_at IS NULL
    GROUP BY w.owner_id
  ),
  key_rollup AS (
    SELECT w.owner_id AS user_id, count(*)::int AS api_keys, max(k.last_used_at) AS key_last_used_at
    FROM public.api_keys k
    JOIN owned w ON w.id = k.workspace_id
    WHERE k.deleted_at IS NULL
      AND k.kind IS NULL
    GROUP BY w.owner_id
  ),
  -- All-time, not windowed: a cap rejection is the single most decision-shaped
  -- event in this schema and there are few enough of them to count forever.
  paywall AS (
    SELECT w.owner_id AS user_id, count(*)::int AS paywall_hits
    FROM public.usage_limit_events e
    JOIN owned w ON w.id = e.workspace_id
    GROUP BY w.owner_id
  ),
  entitlement AS (
    SELECT
      e.user_id,
      coalesce(e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now()), false) AS is_comped,
      coalesce(e.unlimited_inboxes, false) AS unlimited_inboxes
    FROM public.user_usage_entitlements e
    JOIN people p ON p.id = e.user_id
  )
  SELECT
    u.id,
    u.email,
    nullif(u.display_name, ''),
    u.avatar_url,
    u.created_at,
    public.growth_is_internal_email(u.email),
    u.unsubscribed_at,
    u.unsubscribed_categories,

    coalesce(o.workspaces, 0),
    coalesce(m.memberships, 0),
    pw.id,
    coalesce(nullif(pw.display_name, ''), pw.slug),
    pw.slug,
    CASE coalesce(o.plan_rank, 0)
      WHEN 4 THEN 'enterprise' WHEN 3 THEN 'pro'
      WHEN 2 THEN 'solo' WHEN 1 THEN 'personal' ELSE 'free' END,
    coalesce(ent.is_comped, false),
    coalesce(ent.unlimited_inboxes, false),
    coalesce(o.grandfathered, false),

    pw.acquisition_source,
    pw.acquisition_utm_source,
    pw.acquisition_utm_medium,
    pw.acquisition_utm_campaign,
    pw.acquisition_landing_path,
    pw.acquisition_referrer,
    pw.acquisition_locale,

    pw.onboarding_stage,
    coalesce(pw.onboarding_client, pw.analytics_first_tool_client),
    o.first_inbox_connected_at,
    pw.analytics_first_inbox_provider,
    o.first_credential_created_at,
    pw.analytics_first_credential_method,
    o.first_tool_used_at,
    pw.analytics_first_tool_name,
    pw.analytics_first_tool_client,
    o.value_activated_at,

    coalesce(ib.inboxes, 0),
    coalesce(ib.inboxes_broken, 0),
    ib.providers,
    coalesce(k.api_keys, 0),
    k.key_last_used_at,

    coalesce(us.calls, 0),
    coalesce(us.successes, 0),
    coalesce(us.active_days, 0),
    us.last_active_at,
    coalesce(pay.paywall_hits, 0),

    b.plan,
    b.subscription_status,
    b.stripe_customer_id,
    b.current_period_end,

    count(*) OVER ()::int
  FROM people u
  LEFT JOIN owned_rollup o ON o.owner_id = u.id
  LEFT JOIN memberships m ON m.user_id = u.id
  LEFT JOIN primary_ws pw ON pw.owner_id = u.id
  LEFT JOIN inbox_rollup ib ON ib.user_id = u.id
  LEFT JOIN key_rollup k ON k.user_id = u.id
  LEFT JOIN usage us ON us.user_id = u.id
  LEFT JOIN paywall pay ON pay.user_id = u.id
  LEFT JOIN entitlement ent ON ent.user_id = u.id
  LEFT JOIN public.user_billing b ON b.user_id = u.id
  ORDER BY u.created_at DESC
  LIMIT greatest(coalesce(p_limit, 2000), 1);
$function$;

-- ── 4. Fill it, then keep it current ──────────────────────────────────────

SELECT public.growth_activity_rollup_refresh(NULL);

SELECT cron.schedule(
  'growth-activity-rollup',
  '*/5 * * * *',
  $$SELECT public.growth_activity_rollup_refresh(((now() - interval '1 hour') AT TIME ZONE 'utc')::date)$$
);

SELECT cron.schedule(
  'growth-activity-rollup-rebuild',
  '10 2 * * *',
  $$SELECT public.growth_activity_rollup_refresh(NULL)$$
);
