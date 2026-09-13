-- ---------------------------------------------------------------------------
-- growth_utilization_bands: respect the Free action allowance rules.
--
-- 20260912200000 gave Free a sold allowance (150 email actions per calendar
-- month, first 7 days after workspace creation uncounted) and exempted every
-- workspace that existed at launch (`workspaces.free_action_cap_exempt`). The
-- web caller of this RPC builds `p_caps` from `resolvePlanLimits(plan)`, so the
-- free denominator moved from 5,000 to 150 the moment plans.ts changed. Without
-- this change every early-member workspace with 150+ actions this month would be
-- banded at "100%+" although nothing meters it, and a brand-new workspace's
-- trial-week burst would be divided by a cap it is not yet subject to.
--
-- Two changes to the original body (20260819090000_growth_inventory_rpcs.sql):
--   1. `unlimited` also covers `plan = 'free' AND free_action_cap_exempt`.
--   2. A metered Free workspace's period starts at
--      greatest(month start, created_at + 7 days), the same rule as
--      workspace_action_allowance(); a workspace still inside its trial week
--      is treated as unlimited for this period (no denominator applies yet).
-- Everything else is unchanged. These rules MUST stay in step with
-- public.workspace_action_allowance in 20260912200000.
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
  scoped AS (
    SELECT
      w.id,
      coalesce(w.plan, 'free') AS plan,
      w.owner_id,
      w.created_at + interval '7 days' AS grace_ends_at,
      coalesce(e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now()), false)
        OR x.workspace_id IS NOT NULL
        OR (coalesce(w.plan, 'free') = 'free' AND w.free_action_cap_exempt)
        OR (coalesce(w.plan, 'free') = 'free' AND now() < w.created_at + interval '7 days') AS unlimited
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
        THEN b.current_period_start
        WHEN s.plan = 'free' THEN least(greatest(m.starts, s.grace_ends_at), m.ends)
        ELSE m.starts END AS period_start,
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

REVOKE ALL ON FUNCTION public.growth_utilization_bands(jsonb, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_utilization_bands(jsonb, int) TO service_role;
