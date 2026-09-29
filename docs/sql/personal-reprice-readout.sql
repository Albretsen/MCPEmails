-- Personal $5 -> $9 read-out. Read-only. See docs/PLAN-personal-reprice-900.md.
--
-- Unit: a WORKSPACE, assigned to a period by its FIRST paywall_reached.
-- Each workspace gets the same fixed window (14 days) after that first paywall
-- to start and complete a checkout, so the "after" cohort is only read once
-- its window has closed. Revenue is new MRR at the price in force when the
-- sale completed (annual counted as /12), so a "before" workspace that buys
-- after the cutover is priced at $9, which is what it paid.
--
-- Set the three constants, then run once. Never run this in parallel with
-- another production query.
WITH params AS (
  SELECT
    timestamptz '2026-09-30 00:00:00+00' AS cutover,   -- the deploy that flipped the price
    interval '28 days'                   AS period,    -- length of each cohort window
    interval '14 days'                   AS attribution
),
ev AS (
  SELECT e.workspace_id, e.stage, e.outcome, e.category, e.occurred_at
  FROM public.product_funnel_events e
  JOIN public.workspaces w ON w.id = e.workspace_id
  JOIN auth.users u ON u.id = w.owner_id
  WHERE e.stage IN ('paywall_reached', 'checkout_started', 'checkout_completed')
    AND NOT public.growth_is_internal_email(u.email)
    -- Paid traffic starts inside the "after" window only (Google Ads test,
    -- docs/PLAN-google-ads-test-20260929.md). Keep both cohorts organic.
    AND w.acquisition_source IS DISTINCT FROM 'google_ads'
),
first_paywall AS (
  SELECT workspace_id, min(occurred_at) AS at
  FROM ev WHERE stage = 'paywall_reached'
  GROUP BY workspace_id
),
cohort AS (
  SELECT f.workspace_id, f.at,
         CASE WHEN f.at <  p.cutover THEN 'before' ELSE 'after' END AS period
  FROM first_paywall f, params p
  WHERE f.at >= p.cutover - p.period
    AND f.at <  p.cutover + p.period
    -- only cohorts whose attribution window has fully closed
    AND f.at + p.attribution <= now()
),
outcome AS (
  SELECT c.workspace_id, c.period,
    bool_or(e.stage = 'checkout_started'   AND e.outcome = 'success' AND e.category LIKE 'personal_%') AS started_personal,
    bool_or(e.stage = 'checkout_started'   AND e.outcome = 'success')                               AS started_any,
    bool_or(e.stage = 'checkout_completed' AND e.category LIKE 'personal_%')                         AS paid_personal,
    bool_or(e.stage = 'checkout_completed')                                                          AS paid_any,
    -- New MRR in cents from the first completed sale in the window.
    (array_agg(
       CASE e.category
         WHEN 'personal_month' THEN CASE WHEN e.occurred_at < p.cutover THEN 500 ELSE 900 END
         WHEN 'personal_year'  THEN CASE WHEN e.occurred_at < p.cutover THEN 400 ELSE 720 END
         WHEN 'solo_month'     THEN 1500
         WHEN 'solo_year'      THEN 1200
         WHEN 'pro_month'      THEN 7900
         WHEN 'pro_year'       THEN 6300
       END ORDER BY e.occurred_at)
     FILTER (WHERE e.stage = 'checkout_completed'))[1] AS new_mrr_cents
  FROM cohort c
  CROSS JOIN params p
  LEFT JOIN ev e
    ON e.workspace_id = c.workspace_id
   AND e.stage IN ('checkout_started', 'checkout_completed')
   AND e.occurred_at >= c.at
   AND e.occurred_at <  c.at + p.attribution
  GROUP BY c.workspace_id, c.period
)
SELECT
  period,
  count(*)                                              AS paywall_workspaces,
  count(*) FILTER (WHERE started_personal)              AS started_personal,
  count(*) FILTER (WHERE paid_personal)                 AS paid_personal,
  count(*) FILTER (WHERE paid_any)                      AS paid_any,
  round(100.0 * count(*) FILTER (WHERE started_personal) / nullif(count(*), 0), 1) AS pct_start_personal,
  round(100.0 * count(*) FILTER (WHERE paid_personal) / nullif(count(*) FILTER (WHERE started_personal), 0), 1) AS pct_complete_personal,
  round(100.0 * count(*) FILTER (WHERE paid_any) / nullif(count(*), 0), 1) AS pct_paid_any,
  round(coalesce(sum(new_mrr_cents), 0) / 100.0, 2)     AS new_mrr_usd,
  round(coalesce(sum(new_mrr_cents), 0) / 100.0 / nullif(count(*), 0), 3) AS new_mrr_per_paywall_workspace
FROM outcome
GROUP BY period
ORDER BY period DESC;
