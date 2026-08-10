-- Phase 0 approved query revision: 1
-- READ ONLY. Run only after the Phase 1 action_usage ledger is validated.
-- Required bind parameter:
--   :shadow_end :: timestamptz  -- the exclusive end of the 30-day shadow period
--
-- Required Phase 1 ledger columns:
--   workspace_id uuid, occurred_at timestamptz, billable boolean,
--   quantity integer, meter_version integer
--
-- This query intentionally excludes legacy comped users. Append those from the
-- separately verified legacy input using the same CSV schema with
-- eligibility_basis = 'verified_legacy_comped'. Do not infer them from names.
WITH parameters AS (
  SELECT :shadow_end::timestamptz AS shadow_end
),
owned_workspaces AS (
  SELECT w.owner_id AS user_id, w.id AS workspace_id, w.plan
  FROM public.workspaces w
  WHERE w.deleted_at IS NULL
),
normal_plans AS (
  SELECT
    ow.user_id,
    CASE
      WHEN bool_or(ow.plan = 'pro') OR bool_or(ub.plan = 'pro') THEN 'pro'
      WHEN bool_or(ow.plan = 'solo') OR bool_or(ub.plan = 'solo') THEN 'solo'
      ELSE 'free'
    END AS normal_plan
  FROM owned_workspaces ow
  LEFT JOIN public.user_billing ub ON ub.user_id = ow.user_id
  GROUP BY ow.user_id
),
usage AS (
  SELECT
    ow.user_id,
    COALESCE(SUM(au.quantity) FILTER (
      WHERE au.occurred_at >= p.shadow_end - INTERVAL '14 days'
        AND au.occurred_at < p.shadow_end
    ), 0)::bigint AS final_14_day_actions,
    COALESCE(SUM(au.quantity) FILTER (
      WHERE au.occurred_at >= p.shadow_end - INTERVAL '30 days'
        AND au.occurred_at < p.shadow_end
    ), 0)::bigint AS rolling_30_day_actions,
    COALESCE(SUM(au.quantity) FILTER (
      WHERE au.occurred_at >= p.shadow_end - INTERVAL '60 days'
        AND au.occurred_at < p.shadow_end - INTERVAL '30 days'
    ), 0)::bigint AS prior_complete_30_day_actions
  FROM owned_workspaces ow
  CROSS JOIN parameters p
  LEFT JOIN public.action_usage au
    ON au.workspace_id = ow.workspace_id
   AND au.billable = true
   AND au.meter_version = 1
   AND au.occurred_at >= p.shadow_end - INTERVAL '60 days'
   AND au.occurred_at < p.shadow_end
  GROUP BY ow.user_id
),
candidates AS (
  SELECT
    np.user_id,
    np.normal_plan,
    u.final_14_day_actions,
    u.rolling_30_day_actions,
    u.prior_complete_30_day_actions,
    GREATEST(u.rolling_30_day_actions, u.prior_complete_30_day_actions) AS qualifying_actions,
    CASE np.normal_plan
      WHEN 'free' THEN 2500
      WHEN 'solo' THEN 50000
      WHEN 'pro' THEN 300000
    END::bigint AS normal_plan_cap
  FROM normal_plans np
  JOIN usage u USING (user_id)
)
SELECT
  c.user_id,
  c.normal_plan,
  c.normal_plan_cap,
  c.final_14_day_actions,
  c.rolling_30_day_actions,
  c.prior_complete_30_day_actions,
  c.qualifying_actions,
  'shadow_usage_over_cap'::text AS eligibility_basis,
  p.shadow_end,
  NULL::text AS review_status,
  NULL::uuid AS reviewed_by,
  NULL::timestamptz AS reviewed_at,
  NULL::text AS review_note
FROM candidates c
CROSS JOIN parameters p
WHERE c.final_14_day_actions > 0
  AND c.qualifying_actions > c.normal_plan_cap
ORDER BY c.user_id;
