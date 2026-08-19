-- ===========================================================================
-- Inventory RPCs for /admin/growth: provider mix, client mix, cap utilization
-- and billable volume.
--
-- WHY THIS FILE EXISTS
-- `growth-inventory.ts` computed these four panels in Node from raw PostgREST
-- selects, on the stated reasoning that "at ~116 workspaces the row counts are
-- trivial". The row counts were not trivial. PostgREST caps a response at 1,000
-- rows and reports no error when it truncates, so
--
--   .from('action_usage').select('workspace_id, quantity').eq('billable', true)
--
-- silently returned 1,000 of 33,946 rows. Every workspace was bucketed from
-- about a thirtieth of the ledger, the largest survivor landed at 22.2% of the
-- free cap, and the chart therefore reported all 161 workspaces in the 0-24%
-- band while one was at 188% and another at 85%. The billing funnel reads the
-- top two bands as "could have been asked to pay", so it inherited the same
-- zero.
--
-- Moving the aggregation into SQL removes the failure mode rather than raising
-- the ceiling: these functions return at most a handful of rows no matter how
-- large the estate grows, so there is no row count left for a future page cap
-- to truncate. The two mix functions are here for the same reason even though
-- their inputs (161 workspaces, 141 inboxes) are under the limit today: they
-- were the same unpaginated pattern waiting for the estate to grow into it.
--
-- CAP UTILIZATION IS MEASURED OVER THE BILLING PERIOD, NOT THE PAGE WINDOW
-- The old code divided usage in the page's trailing N-day window by a
-- per-billing-period cap, so the same workspace looked fine at 7 days and over
-- cap at 90. A share of an allowance is only meaningful over the period the
-- allowance is granted for, so `growth_utilization_bands` ignores the page
-- window and uses each workspace's own current billing period, resolved
-- exactly as the MCP edge function resolves it when enforcing: the stored
-- Stripe period for a paid plan, the UTC calendar month for Free and as the
-- fallback for a paid workspace whose Stripe period is missing or stale.
--
-- WHERE THE NUMBERS COME FROM
-- Caps are NOT written here. They are passed in as `p_caps` from
-- `apps/web/src/lib/stripe/plans.ts`, which is the canonical plan table the
-- product bills from, so a pricing change moves this chart automatically and a
-- copy of the numbers can never drift out of step with it. What IS defined
-- here, and nowhere else, is the set of band boundaries.
--
-- An account that cannot hit a cap gets no ratio: a comped entitlement and an
-- active workspace exemption both mean unlimited actions, matching the two
-- checks `actionLimitResponse()` makes before it will reject a call. Those
-- workspaces are counted in the lowest band rather than dropped, so the bands
-- still total every non-deleted workspace.
--
-- SECURITY
-- Same posture as 20260813140000: SECURITY INVOKER, EXECUTE revoked from
-- PUBLIC (which anon and authenticated inherit through) and granted to
-- service_role only. No function here returns an email address, workspace name,
-- workspace id, or any free-text user content; output is counts and bounded
-- server-authored category strings.
--
-- CONTRACT
-- `apps/web/src/lib/analytics/growth-types.ts` binds these OUT columns by name
-- and order. Changing one here without changing that file breaks the page
-- silently, because generated database types do not cover functions.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- growth_provider_mix()
--
-- Active inboxes by mail provider. Every app-password connection is stored as
-- provider 'imap', which says nothing useful on its own, so a recorded service
-- name is reported instead wherever there is one. Identical rule to the
-- inbox rollup in growth_active_workspaces.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_provider_mix()
RETURNS TABLE (
  provider text,
  inboxes int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    CASE WHEN i.provider = 'imap' AND i.service IS NOT NULL AND i.service <> 'generic'
      THEN i.service ELSE i.provider END AS provider,
    count(*)::int AS inboxes
  FROM public.inboxes i
  WHERE i.deleted_at IS NULL
    AND i.status = 'active'
  GROUP BY 1
  ORDER BY 2 DESC, 1;
$$;

-- ---------------------------------------------------------------------------
-- growth_client_mix()
--
-- Workspaces by the MCP client recorded with their first successful tool call.
-- Workspaces that have never made one carry no client and are left out, so
-- these counts deliberately do not total the estate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_client_mix()
RETURNS TABLE (
  client text,
  workspaces int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    w.analytics_first_tool_client AS client,
    count(*)::int AS workspaces
  FROM public.workspaces w
  WHERE w.deleted_at IS NULL
    AND nullif(w.analytics_first_tool_client, '') IS NOT NULL
  GROUP BY 1
  ORDER BY 2 DESC, 1;
$$;

-- ---------------------------------------------------------------------------
-- growth_utilization_bands(p_caps jsonb, p_meter_version int)
--
-- Non-deleted workspaces bucketed by the share of their plan's action
-- allowance used in their own current billing period.
--
-- `p_caps` maps a plan id to its billable-action cap, e.g.
-- {"free": 2500, "solo": 50000, "pro": 300000}. A plan absent from the map
-- falls back to the free cap rather than to unlimited: an unknown plan id is a
-- bug, and silently parking those workspaces in the bottom band is how this
-- panel would hide the next one.
--
-- Always returns all five bands, including empty ones, so the caller renders a
-- stable chart instead of a shrinking one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_utilization_bands(
  p_caps jsonb,
  p_meter_version int DEFAULT 1
)
RETURNS TABLE (
  band text,
  workspaces int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH month AS (
    SELECT
      date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc' AS starts,
      (date_trunc('month', now() AT TIME ZONE 'utc') + interval '1 month') AT TIME ZONE 'utc' AS ends
  ),
  -- Unlimited entitlements. A comp is granted per owner, an exemption per
  -- workspace, and either one means no cap can be reached: the same two
  -- escapes the edge function checks before rejecting a billable call.
  scoped AS (
    SELECT
      w.id,
      coalesce(w.plan, 'free') AS plan,
      w.owner_id,
      -- coalesce, not a bare comparison: the LEFT JOIN leaves e.kind NULL for
      -- every account that is not comped, and `NULL = 'comped_scale'` is NULL
      -- rather than false, which would make the OR below inherit the NULL.
      coalesce(e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now()), false)
        OR x.workspace_id IS NOT NULL AS unlimited
    FROM public.workspaces w
    LEFT JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
    LEFT JOIN (
      SELECT DISTINCT ex.workspace_id
      FROM public.workspace_usage_exemptions ex
      WHERE ex.revoked_at IS NULL
        AND (ex.expires_at IS NULL OR ex.expires_at > now())
    ) x ON x.workspace_id = w.id
    WHERE w.deleted_at IS NULL
  ),
  -- The workspace's own current cycle. Free is defined as the calendar month;
  -- a paid plan uses its stored Stripe period, and falls back to the calendar
  -- month when that period is absent or no longer covers now() (a legacy row
  -- waiting on its next webhook sync).
  windowed AS (
    SELECT
      s.id,
      s.plan,
      s.unlimited,
      CASE WHEN s.plan <> 'free'
            AND b.current_period_start IS NOT NULL
            AND b.current_period_end IS NOT NULL
            AND b.current_period_start <= now()
            AND now() < b.current_period_end
        THEN b.current_period_start ELSE m.starts END AS period_start,
      CASE WHEN s.plan <> 'free'
            AND b.current_period_start IS NOT NULL
            AND b.current_period_end IS NOT NULL
            AND b.current_period_start <= now()
            AND now() < b.current_period_end
        THEN b.current_period_end ELSE m.ends END AS period_end
    FROM scoped s
    CROSS JOIN month m
    LEFT JOIN public.user_billing b ON b.user_id = s.owner_id
  ),
  used AS (
    SELECT
      wd.id,
      wd.plan,
      wd.unlimited,
      coalesce(sum(a.quantity), 0)::numeric AS actions
    FROM windowed wd
    LEFT JOIN public.action_usage a
      ON a.workspace_id = wd.id
     AND a.billable
     AND a.meter_version = p_meter_version
     AND a.occurred_at >= wd.period_start
     AND a.occurred_at < wd.period_end
    GROUP BY wd.id, wd.plan, wd.unlimited
  ),
  rated AS (
    SELECT
      u.actions,
      CASE WHEN u.unlimited THEN NULL
        ELSE coalesce((p_caps ->> u.plan)::numeric, (p_caps ->> 'free')::numeric) END AS cap
    FROM used u
  ),
  assigned AS (
    SELECT
      CASE
        WHEN r.cap IS NULL OR r.cap <= 0 THEN 1
        WHEN r.actions / r.cap >= 1 THEN 5
        WHEN r.actions / r.cap >= 0.8 THEN 4
        WHEN r.actions / r.cap >= 0.5 THEN 3
        WHEN r.actions / r.cap >= 0.25 THEN 2
        ELSE 1
      END AS band_order
    FROM rated r
  ),
  bands (band_order, label) AS (
    VALUES (1, '0-24%'), (2, '25-49%'), (3, '50-79%'), (4, '80-99%'), (5, '100%+')
  )
  SELECT
    b.label AS band,
    count(a.band_order)::int AS workspaces
  FROM bands b
  LEFT JOIN assigned a ON a.band_order = b.band_order
  GROUP BY b.band_order, b.label
  ORDER BY b.band_order;
$$;

-- ---------------------------------------------------------------------------
-- growth_usage_volume(p_days int, p_meter_version int)
--
-- Billable volume and cap rejections over the page's trailing window, plus the
-- estate size. Windowed rather than per-billing-period on purpose: these are
-- "how much did the product get used lately" counters, not a share of an
-- allowance, and the cards name the window they cover.
--
-- Returns exactly one row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_usage_volume(
  p_days int DEFAULT 28,
  p_meter_version int DEFAULT 1
)
RETURNS TABLE (
  billable_actions bigint,
  billable_workspaces int,
  cap_hit_workspaces int,
  cap_rejections int,
  total_workspaces int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT now() - make_interval(days => greatest(coalesce(p_days, 28), 1)) AS since
  ),
  actions AS (
    SELECT
      coalesce(sum(a.quantity), 0)::bigint AS billable_actions,
      count(DISTINCT a.workspace_id)::int AS billable_workspaces
    FROM public.action_usage a, bounds b
    WHERE a.billable
      AND a.meter_version = p_meter_version
      AND a.occurred_at >= b.since
  ),
  rejections AS (
    SELECT
      count(DISTINCT l.workspace_id)::int AS cap_hit_workspaces,
      count(*)::int AS cap_rejections
    FROM public.usage_limit_events l, bounds b
    WHERE l.occurred_at >= b.since
  ),
  estate AS (
    SELECT count(*)::int AS total_workspaces
    FROM public.workspaces w
    WHERE w.deleted_at IS NULL
  )
  SELECT
    actions.billable_actions,
    actions.billable_workspaces,
    rejections.cap_hit_workspaces,
    rejections.cap_rejections,
    estate.total_workspaces
  FROM actions, rejections, estate;
$$;

-- ---------------------------------------------------------------------------
-- Execution rights. PUBLIC is revoked first because anon and authenticated
-- inherit the default grant through it, so naming those two alone would leave
-- it in place.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.growth_provider_mix() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_client_mix() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_utilization_bands(jsonb, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_usage_volume(int, int) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.growth_provider_mix() TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_client_mix() TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_utilization_bands(jsonb, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_usage_volume(int, int) TO service_role;
