-- ===========================================================================
-- Growth reporting RPCs for the internal /admin/growth page.
--
-- WHY THIS FILE EXISTS
-- The admin growth page computed every metric in Node. To do that it pulled
-- 180 days of `activity_log` over PostgREST: at the time of writing that is
-- 103,841 rows fetched in 104 sequential 1,000-row pages, on every single page
-- load, only to be reduced to a few dozen numbers. That is slow now and gets
-- linearly worse with usage, and it burns egress on data the page never shows.
-- Worse, the aggregation logic lived only in the renderer, so the definitions
-- of "active", "activated" and "retained" could silently drift away from the
-- durable columns the product itself writes.
--
-- These functions push the aggregation into Postgres, where the data already
-- is. Each returns tens of rows instead of a hundred thousand.
--
-- CONTRACT
-- `apps/web/src/lib/analytics/growth-types.ts` is the binding contract for the
-- OUT columns below: same names, same order, snake_case. Changing a column
-- here without changing that file breaks the page silently, because generated
-- database types do not cover functions.
--
-- SHARED DEFINITIONS (kept identical across every function here)
--   technical activation : first successful MCP tool call of any kind.
--   value activation     : status = 'success' AND inbox_id IS NOT NULL
--                          AND tool_name <> 'inbox_list'. Copied verbatim from
--                          the backfill in 20260805010000 so these functions
--                          can never disagree with the durable
--                          `workspaces.onboarding_value_activated_at` column.
--   session              : successful calls by one workspace, split whenever
--                          the gap from the previous successful call is at
--                          least 30 minutes. Defined here and nowhere else:
--                          the earlier TypeScript implementation was deleted
--                          once this file became the only consumer, so there
--                          is no second copy to keep in step.
--   day                  : UTC calendar day. now() is converted explicitly so
--                          results never depend on the server's timezone.
--
-- ACTIVITY RETENTION CAVEAT
-- A pg_cron job deletes `activity_log` rows older than 90 days. Anything
-- derived from raw activity is therefore only trustworthy inside that window.
-- Cohort membership and activation timestamps are read from the permanent
-- `workspaces.onboarding_*_at` columns instead, so denominators stay stable
-- after the detail ages out. Numerators that must inspect what a workspace
-- actually did (retention, cohort heatmap) can only see the last 90 days, and
-- will read as zero for older cohorts. That is a property of the data, not a
-- bug in these queries.
--
-- SECURITY
-- Every function is SECURITY INVOKER (the default) on purpose. The tables read
-- here have RLS enabled with no browser-facing policy, and the only intended
-- caller is the service-role client, which already bypasses RLS. Marking them
-- SECURITY DEFINER would turn each one into a permanent hole through which any
-- authenticated session could read other workspaces' data. EXECUTE is revoked
-- from PUBLIC (which is what anon and authenticated actually inherit it
-- through) and granted to service_role only.
--
-- No function here returns an email address, workspace name, user id, or any
-- free-text user content. Output is counts, dates, and bounded server-authored
-- strings (tool names, error codes, provider and stage categories).
--
-- This migration is additive only: new function definitions and one new table.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Hand-entered Google Cloud Console figures.
--
-- Google's 100-user cap on a published-but-unverified OAuth client counts a
-- grant the moment consent is given. We can only see grants that got far
-- enough to write an inbox row, so our own number is a floor. The true figure
-- is visible only in the Cloud Console and has to be transcribed by hand;
-- this table is where it lands, so the admin page can show both side by side.
--
-- Same convention as product_funnel_events: RLS on, no policy, service role
-- only. Nothing here is user content.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_oauth_cap_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  google_reported_users int NOT NULL CHECK (google_reported_users >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  note text
);

CREATE INDEX IF NOT EXISTS admin_oauth_cap_snapshots_provider_recorded_idx
  ON public.admin_oauth_cap_snapshots (provider, recorded_at DESC);

ALTER TABLE public.admin_oauth_cap_snapshots ENABLE ROW LEVEL SECURITY;
-- No policy by design: only trusted server code reads or writes these rows.

REVOKE ALL ON TABLE public.admin_oauth_cap_snapshots FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.admin_oauth_cap_snapshots TO service_role;

-- ---------------------------------------------------------------------------
-- 1. growth_daily_metrics(p_days)
--
-- One row per UTC day: signups, activations, rolling active counts, and call
-- outcomes. The rolling 7 and 28 day counts are the reason this belongs in
-- SQL: computing them in the app required every raw row.
--
-- The rolling counts are built from a distinct (workspace_id, day) set, which
-- is at most a few thousand rows, joined against a generated day series. The
-- naive alternative (re-scanning the raw table once per day in the window)
-- would read 100k rows 90 times over.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_daily_metrics(p_days int)
RETURNS TABLE (
  day date,
  new_workspaces int,
  technical_activations int,
  value_activations int,
  active_7d int,
  active_28d int,
  calls int,
  successes int,
  errors int,
  rate_limited int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
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
    SELECT
      a.workspace_id,
      a.status,
      (a.created_at AT TIME ZONE 'utc')::date AS day
    FROM public.activity_log a, bounds b
    WHERE a.created_at >= ((b.first_day - 27)::timestamp AT TIME ZONE 'utc')
      AND a.created_at < ((b.last_day + 1)::timestamp AT TIME ZONE 'utc')
  ),
  call_totals AS (
    SELECT
      act.day AS day,
      count(*) AS calls,
      count(*) FILTER (WHERE act.status = 'success') AS successes,
      count(*) FILTER (WHERE act.status = 'error') AS errors,
      count(*) FILTER (WHERE act.status = 'rate_limited') AS rate_limited
    FROM activity act, bounds b
    WHERE act.day >= b.first_day
    GROUP BY act.day
  ),
  active_days AS (
    SELECT DISTINCT act.workspace_id, act.day
    FROM activity act
    WHERE act.status = 'success'
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
$$;

-- ---------------------------------------------------------------------------
-- 2. growth_engagement_bands(p_days)
--
-- How often an active workspace actually comes back, as a distribution rather
-- than an average. Two metrics: distinct active UTC days, and sessions.
--
-- Band labels use EN DASHES (U+2013) and must match the literals the renderer
-- keys on in `src/lib/analytics/growth-types.ts`. A hyphen here would produce
-- bands the renderer cannot key on.
--
-- All eight metric/band combinations are always returned, including empty
-- ones, so the table has a stable shape and a zero reads as a real zero.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_engagement_bands(p_days int)
RETURNS TABLE (
  metric text,
  band text,
  workspaces int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT
      ((now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 28), 1) - 1))::timestamp
        AT TIME ZONE 'utc' AS window_start,
      (((now() AT TIME ZONE 'utc')::date + 1)::timestamp) AT TIME ZONE 'utc' AS window_end
  ),
  succeeded AS (
    SELECT a.workspace_id, a.created_at
    FROM public.activity_log a, bounds b
    WHERE a.status = 'success'
      AND a.created_at >= b.window_start
      AND a.created_at < b.window_end
  ),
  -- A session boundary is a gap of at least 30 minutes from the immediately
  -- preceding successful call. See the SHARED DEFINITIONS header above.
  gaps AS (
    SELECT
      sc.workspace_id,
      sc.created_at,
      lag(sc.created_at) OVER (PARTITION BY sc.workspace_id ORDER BY sc.created_at) AS previous_at
    FROM succeeded sc
  ),
  per_workspace AS (
    SELECT
      g.workspace_id,
      count(DISTINCT (g.created_at AT TIME ZONE 'utc')::date) AS active_days,
      count(*) FILTER (
        WHERE g.previous_at IS NULL OR g.created_at - g.previous_at >= interval '30 minutes'
      ) AS sessions
    FROM gaps g
    GROUP BY g.workspace_id
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
$$;

-- ---------------------------------------------------------------------------
-- 3. growth_retention_curve(p_weeks)
--
-- Did a workspace that once got value from a mailbox come BACK and get value
-- again? Week N covers days [1 + (N-1)*7, 1 + N*7) counted from the value
-- activation day, so week 1 is days 1 to 7 after activation.
--
-- THE ACTIVATION DAY ITSELF IS DELIBERATELY EXCLUDED. A window starting at
-- day 0 would contain the very event that defines the cohort, so week 1 would
-- report 100% retention by construction and the first and most important
-- point on the curve would carry no information at all. Offsetting by one day
-- also matches rollingReturn(first, activity, 1, 7, ...) as the admin page
-- calls it, and the "days 1-7" wording in growth-types.ts.
--
-- A workspace only enters `eligible` once its whole week has elapsed, so a
-- cohort is never punished for not having had the chance yet. This mirrors
-- rollingReturn(), which skips any window whose end is in the future.
--
-- Cohort membership uses the permanent onboarding column; the return check
-- must read activity_log and therefore cannot see beyond the 90-day retention
-- horizon. For weeks that fall entirely outside that horizon, `retained`
-- reads zero.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_retention_curve(p_weeks int)
RETURNS TABLE (
  week_index int,
  eligible int,
  retained int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT (now() AT TIME ZONE 'utc')::date AS today
  ),
  cohort AS (
    SELECT
      w.id AS workspace_id,
      (w.onboarding_value_activated_at AT TIME ZONE 'utc')::date AS cohort_day
    FROM public.workspaces w
    WHERE w.deleted_at IS NULL
      AND w.onboarding_value_activated_at IS NOT NULL
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
    FROM public.activity_log a
    WHERE a.workspace_id = c.workspace_id
      AND a.status = 'success'
      AND a.inbox_id IS NOT NULL
      AND a.tool_name <> 'inbox_list'
      AND a.created_at >= ((c.cohort_day + 1 + ((wk.week_index - 1) * 7))::timestamp AT TIME ZONE 'utc')
      AND a.created_at < ((c.cohort_day + 1 + (wk.week_index * 7))::timestamp AT TIME ZONE 'utc')
    LIMIT 1
  ) hit ON true
  GROUP BY wk.week_index
  ORDER BY wk.week_index;
$$;

-- ---------------------------------------------------------------------------
-- 4. growth_cohort_retention(p_weeks)
--
-- Signup-week cohort heatmap. Cohorts are the last p_weeks signup weeks;
-- date_trunc('week', ...) means weeks start on Monday. week_index 0 is the
-- signup week itself, and a cohort only emits cells for weeks that have
-- already started, which is what gives the heatmap its triangular shape.
--
-- Unlike growth_retention_curve, week 0 here INCLUDES the signup day, and that
-- is intended. The cohort is defined by signing up, not by being active, so
-- "was this workspace active during the calendar week it signed up" is a real
-- question with a real answer: it is the share that got anywhere at all
-- before losing interest, and it comes back well under 100% in practice. The
-- windows are whole calendar weeks, so week 0 is shorter in elapsed hours for
-- someone who signed up on a Sunday than for someone who signed up on a
-- Monday; that is inherent to calendar cohorts and is why week 0 should be
-- read as a floor.
--
-- Retention is measured against distinct (workspace, week) successful
-- activity, computed once, rather than re-scanning activity_log per cell.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_cohort_retention(p_weeks int)
RETURNS TABLE (
  cohort_week date,
  cohort_size int,
  week_index int,
  retained int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
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
      a.workspace_id,
      date_trunc('week', (a.created_at AT TIME ZONE 'utc'))::date AS week
    FROM public.activity_log a, bounds b
    WHERE a.status = 'success'
      AND a.created_at >= (b.earliest_week::timestamp AT TIME ZONE 'utc')
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
$$;

-- ---------------------------------------------------------------------------
-- 5. growth_lifecycle_counts()
--
-- Five blunt numbers, all-time, one row. Ratios hide small denominators; these
-- answer "did anyone keep using it" without arithmetic.
--
-- "one and done" and "at risk" both count DISTINCT ACTIVE DAYS rather than
-- calls, because a single burst of twenty calls in one sitting is still one
-- day of usage and should not read as a returning user. `one_and_done`
-- requires the single active day to be in the past, so a workspace that
-- activated today is not condemned before the day is over.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_lifecycle_counts()
RETURNS TABLE (
  value_activated int,
  one_and_done int,
  at_risk int,
  active_7d int,
  active_28d int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT
      (now() AT TIME ZONE 'utc')::date AS today,
      (((now() AT TIME ZONE 'utc')::date - 6)::timestamp) AT TIME ZONE 'utc' AS since_7d,
      (((now() AT TIME ZONE 'utc')::date - 27)::timestamp) AT TIME ZONE 'utc' AS since_28d
  ),
  value_activity AS (
    SELECT
      a.workspace_id,
      count(DISTINCT (a.created_at AT TIME ZONE 'utc')::date) AS active_day_count,
      max((a.created_at AT TIME ZONE 'utc')::date) AS last_active_day,
      max(a.created_at) AS last_active_at
    FROM public.activity_log a
    WHERE a.status = 'success'
      AND a.inbox_id IS NOT NULL
      AND a.tool_name <> 'inbox_list'
    GROUP BY a.workspace_id
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
      count(DISTINCT a.workspace_id) FILTER (WHERE a.created_at >= b.since_7d) AS in_7d,
      count(DISTINCT a.workspace_id) AS in_28d
    FROM public.activity_log a, bounds b
    WHERE a.status = 'success'
      AND a.created_at >= b.since_28d
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
$$;

-- ---------------------------------------------------------------------------
-- 6. growth_activation_funnel(p_days)
--
-- True signup cohort funnel: the window is on workspaces.created_at, so every
-- stage counts the same population and a later stage can never legitimately
-- exceed an earlier one.
--
-- It can still happen in the data. Several onboarding timestamps were
-- backfilled from older analytics columns in 20260805010000, which could set a
-- late stage on a workspace that has no timestamp for an earlier one. Rather
-- than showing an impossible funnel, each stage counts workspaces that reached
-- THAT stage OR ANY LATER ONE, which makes the series monotonically
-- non-increasing by construction. This slightly over-counts early stages
-- rather than under-counting them, which is the safer error for a funnel used
-- to find drop-off.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_activation_funnel(p_days int)
RETURNS TABLE (
  stage_index int,
  stage text,
  workspaces int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT ((((now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 28), 1) - 1))::timestamp)
      AT TIME ZONE 'utc') AS window_start
  ),
  cohort AS (
    SELECT
      w.onboarding_client_selected_at AS client_selected_at,
      w.onboarding_inbox_connected_at AS inbox_connected_at,
      w.onboarding_connection_verified_at AS connection_verified_at,
      w.onboarding_credential_issued_at AS credential_issued_at,
      w.onboarding_technical_activated_at AS technical_activated_at,
      w.onboarding_value_activated_at AS value_activated_at
    FROM public.workspaces w, bounds b
    WHERE w.deleted_at IS NULL
      AND w.created_at >= b.window_start
  ),
  counted AS (
    SELECT
      count(*)::int AS signup,
      count(*) FILTER (WHERE coalesce(
        c.client_selected_at, c.inbox_connected_at, c.connection_verified_at,
        c.credential_issued_at, c.technical_activated_at, c.value_activated_at
      ) IS NOT NULL)::int AS client_selected,
      count(*) FILTER (WHERE coalesce(
        c.inbox_connected_at, c.connection_verified_at,
        c.credential_issued_at, c.technical_activated_at, c.value_activated_at
      ) IS NOT NULL)::int AS inbox_connected,
      count(*) FILTER (WHERE coalesce(
        c.connection_verified_at, c.credential_issued_at,
        c.technical_activated_at, c.value_activated_at
      ) IS NOT NULL)::int AS connection_verified,
      count(*) FILTER (WHERE coalesce(
        c.credential_issued_at, c.technical_activated_at, c.value_activated_at
      ) IS NOT NULL)::int AS credential_issued,
      count(*) FILTER (WHERE coalesce(
        c.technical_activated_at, c.value_activated_at
      ) IS NOT NULL)::int AS technical_activation,
      count(*) FILTER (WHERE c.value_activated_at IS NOT NULL)::int AS value_activation
    FROM cohort c
  )
  -- stage_index is 1-based and exists so the renderer never has to rely on
  -- row order surviving a round trip through JSON.
  SELECT ordered.stage_index, ordered.stage, ordered.workspaces
  FROM counted cn
  CROSS JOIN LATERAL (
    VALUES
      (1, 'signup'::text, cn.signup),
      (2, 'client_selected'::text, cn.client_selected),
      (3, 'inbox_connected'::text, cn.inbox_connected),
      (4, 'connection_verified'::text, cn.connection_verified),
      (5, 'credential_issued'::text, cn.credential_issued),
      (6, 'technical_activation'::text, cn.technical_activation),
      (7, 'value_activation'::text, cn.value_activation)
  ) AS ordered(stage_index, stage, workspaces)
  ORDER BY ordered.stage_index;
$$;

-- ---------------------------------------------------------------------------
-- 7. growth_provider_funnel(p_days)
--
-- Where mailbox connection attempts die, per provider. Attempt/success/failure
-- are raw event counts; the workspace counts are the deduplicated version and
-- are what drop-off should actually be read from, because one determined user
-- retrying eight times is not eight users.
--
-- The rate is deliberately not computed here: the UI decides how to present a
-- ratio with a denominator of three.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_provider_funnel(p_days int)
RETURNS TABLE (
  provider text,
  workspaces_attempted int,
  workspaces_connected int,
  attempts int,
  successes int,
  failures int,
  top_error text
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT ((((now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 28), 1) - 1))::timestamp)
      AT TIME ZONE 'utc') AS window_start
  ),
  events AS (
    SELECT e.category, e.outcome, e.error_category, e.workspace_id
    FROM public.product_funnel_events e, bounds b
    WHERE e.stage = 'inbox_connection'
      AND e.occurred_at >= b.window_start
  )
  SELECT
    ev.category,
    count(DISTINCT ev.workspace_id)::int,
    count(DISTINCT ev.workspace_id) FILTER (WHERE ev.outcome = 'success')::int,
    count(*)::int,
    count(*) FILTER (WHERE ev.outcome = 'success')::int,
    count(*) FILTER (WHERE ev.outcome = 'failure')::int,
    mode() WITHIN GROUP (ORDER BY ev.error_category)
      FILTER (WHERE ev.outcome = 'failure' AND ev.error_category IS NOT NULL)
  FROM events ev
  GROUP BY ev.category
  ORDER BY count(*) DESC, ev.category;
$$;

-- ---------------------------------------------------------------------------
-- 8. growth_oauth_abandonment()
--
-- Consent screens that were opened and never came back.
--
-- `oauth_states` rows are deleted on a successful callback and are never
-- cleaned up otherwise, so every surviving row is an abandoned or failed
-- consent attempt. This leak is invisible everywhere else: an abandoned
-- consent writes no product_funnel_events row at all, so without this the
-- users lost on Google's own screen simply do not appear in any funnel.
--
-- Restricted to providers that actually use OAuth, plus anything that has
-- somehow written a state row, so IMAP providers do not appear with a
-- meaningless zero. `connected` counts distinct addresses ever connected,
-- including soft-deleted ones, so it is comparable with the abandoned count.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_oauth_abandonment()
RETURNS TABLE (
  provider text,
  abandoned int,
  connected int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH abandoned_states AS (
    SELECT os.provider AS provider, count(*) AS abandoned
    FROM public.oauth_states os
    GROUP BY os.provider
  ),
  connected_inboxes AS (
    SELECT i.provider AS provider, count(DISTINCT lower(i.email_address)) AS connected
    FROM public.inboxes i
    WHERE i.provider IN ('gmail', 'outlook')
    GROUP BY i.provider
  )
  SELECT
    coalesce(a.provider, c.provider),
    coalesce(a.abandoned, 0)::int,
    coalesce(c.connected, 0)::int
  FROM abandoned_states a
  FULL OUTER JOIN connected_inboxes c ON c.provider = a.provider
  ORDER BY coalesce(a.abandoned, 0) DESC, 1;
$$;

-- ---------------------------------------------------------------------------
-- 9. gmail_oauth_cap_summary()
--
-- Google caps a published-but-unverified OAuth client with restricted Gmail
-- scopes at 100 users. Hitting it stops all new Gmail signups dead, so this is
-- a countdown, not a metric.
--
-- Soft-deleted inboxes are INCLUDED on purpose. Google's count is cumulative:
-- deleting an inbox, or the user revoking access, does not give the slot back.
-- Excluding deleted rows would make the remaining headroom look larger than it
-- is, which is the one error that matters here.
--
-- Even so, `distinct_ever` is only a floor. Google counts a grant at the
-- moment of consent, so anyone who consented and then failed before an inbox
-- row was written occupies a slot we cannot see. The authoritative number is
-- the hand-transcribed Cloud Console figure returned alongside it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gmail_oauth_cap_summary()
RETURNS TABLE (
  distinct_ever int,
  live int,
  active int,
  first_grant_at timestamptz,
  grants_last_30d int,
  grants_last_60d int,
  google_reported_users int,
  google_reported_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH grants AS (
    SELECT
      lower(i.email_address) AS address,
      min(i.created_at) AS first_at,
      bool_or(i.deleted_at IS NULL) AS is_live,
      bool_or(i.deleted_at IS NULL AND i.status = 'active') AS is_active
    FROM public.inboxes i
    WHERE i.provider = 'gmail'
    GROUP BY lower(i.email_address)
  ),
  snapshot AS (
    SELECT s.google_reported_users AS reported_users, s.recorded_at AS reported_at
    FROM public.admin_oauth_cap_snapshots s
    WHERE s.provider = 'gmail'
    ORDER BY s.recorded_at DESC, s.id DESC
    LIMIT 1
  )
  SELECT
    count(*)::int,
    count(*) FILTER (WHERE g.is_live)::int,
    count(*) FILTER (WHERE g.is_active)::int,
    min(g.first_at),
    count(*) FILTER (WHERE g.first_at >= now() - interval '30 days')::int,
    count(*) FILTER (WHERE g.first_at >= now() - interval '60 days')::int,
    (SELECT sn.reported_users FROM snapshot sn),
    (SELECT sn.reported_at FROM snapshot sn)
  FROM grants g;
$$;

-- ---------------------------------------------------------------------------
-- 10. gmail_oauth_grant_series()
--
-- Monthly Gmail grant history for the cap chart. Months are generated rather
-- than derived from the data so a month with no new grants shows as a flat
-- segment instead of vanishing, which would make the slope look steeper than
-- it is. Cumulative is the number that matters: it is the one Google compares
-- against 100.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gmail_oauth_grant_series()
RETURNS TABLE (
  month date,
  new_grants int,
  cumulative_grants int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH grants AS (
    SELECT
      lower(i.email_address) AS address,
      min(i.created_at) AS first_at
    FROM public.inboxes i
    WHERE i.provider = 'gmail'
    GROUP BY lower(i.email_address)
  ),
  per_month AS (
    SELECT
      date_trunc('month', (g.first_at AT TIME ZONE 'utc'))::date AS month,
      count(*) AS new_grants
    FROM grants g
    GROUP BY 1
  ),
  span AS (
    SELECT
      min(pm.month) AS first_month,
      date_trunc('month', (now() AT TIME ZONE 'utc'))::date AS last_month
    FROM per_month pm
  ),
  months AS (
    SELECT generated::date AS month
    FROM span sp,
         generate_series(sp.first_month::timestamp, sp.last_month::timestamp, interval '1 month') AS generated
  )
  SELECT
    m.month,
    coalesce(pm.new_grants, 0)::int,
    (sum(coalesce(pm.new_grants, 0)) OVER (ORDER BY m.month))::int
  FROM months m
  LEFT JOIN per_month pm ON pm.month = m.month
  ORDER BY m.month;
$$;

-- ---------------------------------------------------------------------------
-- 11. growth_error_breakdown(p_days)
--
-- Which tool/error pairs are actually failing, with that tool's total call
-- volume alongside so a scary-looking count can be read against its base. Both
-- columns are server-authored: tool names come from a fixed dispatch table and
-- error codes from a fixed vocabulary, so neither can leak user content.
--
-- Capped at 20 rows: this is a "what should I fix first" list, not an export.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_error_breakdown(p_days int)
RETURNS TABLE (
  tool_name text,
  error_code text,
  failures int,
  calls int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT ((((now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 28), 1) - 1))::timestamp)
      AT TIME ZONE 'utc') AS window_start
  ),
  windowed AS (
    SELECT a.tool_name, a.status, a.error_code
    FROM public.activity_log a, bounds b
    WHERE a.created_at >= b.window_start
  ),
  tool_totals AS (
    SELECT w.tool_name AS tool_name, count(*) AS calls
    FROM windowed w
    GROUP BY w.tool_name
  ),
  failures AS (
    SELECT w.tool_name AS tool_name, w.error_code AS error_code, count(*) AS failures
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
$$;

-- ---------------------------------------------------------------------------
-- Execution rights.
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default, and both
-- anon and authenticated inherit it that way, so revoking from those two roles
-- alone would leave the grant intact. PUBLIC is revoked first for that reason.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.growth_daily_metrics(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_engagement_bands(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_retention_curve(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_cohort_retention(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_lifecycle_counts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_activation_funnel(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_provider_funnel(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_oauth_abandonment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gmail_oauth_cap_summary() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gmail_oauth_grant_series() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_error_breakdown(int) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.growth_daily_metrics(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_engagement_bands(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_retention_curve(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_cohort_retention(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_lifecycle_counts() TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_activation_funnel(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_provider_funnel(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_oauth_abandonment() TO service_role;
GRANT EXECUTE ON FUNCTION public.gmail_oauth_cap_summary() TO service_role;
GRANT EXECUTE ON FUNCTION public.gmail_oauth_grant_series() TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_error_breakdown(int) TO service_role;
