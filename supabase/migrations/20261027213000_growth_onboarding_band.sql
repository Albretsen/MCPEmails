-- ============================================================================
-- /admin/growth "Onboarding" band: the read-out for the onb_flow x onb_convert
-- test (plan section 8, Documents/plans/onboarding-research-20261026.md).
--
--   growth_onboarding_arms    one row per arm (flow, convert) of the ENROLLED
--                             customer workspaces: the outcomes the test is
--                             judged on, each with its own matured denominator
--   growth_onboarding_steps   (flow, convert, stage, category, workspaces) for
--                             the setup dialog's steps and Flow B's moments
--   growth_onboarding_daily   per day: new customer workspaces and how many of
--                             them were enrolled, by arm (sample ratio and
--                             assignment coverage)
--
-- An enrolled workspace has an experiment_assignments row for onb_flow or
-- onb_convert; subject = the workspace uuid without dashes. Internal accounts
-- are never enrolled (apps/web/src/lib/onboarding/variant.ts) and are filtered
-- again here. Read-only, service_role only. mcp-server calls none of these, so
-- self-host/db/00-schema.sql is unchanged.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- growth_onboarding_arms
--
--   mature_1d / value_1d     created 24 h+ ago / a successful call on a real
--                            inbox (onboarding_value_activated_at) within 24 h.
--                            The test's primary metric for onb_flow.
--   inbox_1d                 an inbox connected within 24 h
--   mature_3d / draft_3d     created 3 days+ ago / a draft within 3 days
--   mature_7d / habit_7d     created 7 days+ ago / successful calls on 2+
--                            distinct UTC days in the first 7 (automation runs
--                            excluded: they are not the person coming back)
--   mature_30d / paid_30d    created 30 days+ ago / a completed subscription or
--                            pass checkout within 30 days. The primary metric
--                            for onb_convert.
--   paid_any                 paid at any time so far (early signal, immature)
--   connect_ws / connect_failed_ws   workspaces that tried to connect an inbox /
--                            of those, ones whose every attempt failed
--   completed                finished the setup dialog
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_onboarding_arms(
  p_internal_emails  text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
RETURNS TABLE (
  flow              text,
  convert           text,
  assigned          bigint,
  first_assigned_at timestamptz,
  mature_1d         bigint,
  inbox_1d          bigint,
  value_1d          bigint,
  mature_3d         bigint,
  draft_3d          bigint,
  mature_7d         bigint,
  habit_7d          bigint,
  mature_30d        bigint,
  paid_30d          bigint,
  paid_any          bigint,
  connect_ws        bigint,
  connect_failed_ws bigint,
  completed         bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH enrolled AS (
    SELECT w.id, w.created_at, w.onboarding_value_activated_at, w.onboarding_completed_at,
           COALESCE(f.variant_id, 'control') AS flow,
           COALESCE(c.variant_id, 'off') AS convert,
           LEAST(f.first_assigned_at, c.first_assigned_at) AS assigned_at
    FROM public.workspaces w
    LEFT JOIN public.users u ON u.id = w.owner_id
    LEFT JOIN public.experiment_assignments f
      ON f.experiment_key = 'onb_flow' AND f.subject_id = replace(w.id::text, '-', '')
    LEFT JOIN public.experiment_assignments c
      ON c.experiment_key = 'onb_convert' AND c.subject_id = replace(w.id::text, '-', '')
    WHERE (f.subject_id IS NOT NULL OR c.subject_id IS NOT NULL)
      AND NOT public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains)
  ),
  facts AS (
    SELECT e.*,
      (SELECT min(i.created_at) FROM public.inboxes i WHERE i.workspace_id = e.id) AS first_inbox_at,
      (SELECT min(d.occurred_at) FROM public.draft_events d
        WHERE d.workspace_id = e.id AND d.event = 'drafted') AS first_draft_at,
      (SELECT count(DISTINCT (a.created_at AT TIME ZONE 'UTC')::date)
         FROM public.activity_log a
        WHERE a.workspace_id = e.id
          AND a.status = 'success'
          AND a.created_at >= e.created_at
          AND a.created_at < e.created_at + interval '7 days'
          AND a.user_agent IS DISTINCT FROM 'mcp-emails-triage-runner') AS active_days_7,
      (SELECT min(p.occurred_at) FROM public.product_funnel_events p
        WHERE p.workspace_id = e.id AND p.outcome = 'success'
          AND p.stage IN ('checkout_completed', 'pass_checkout_completed')) AS first_paid_at,
      (SELECT count(*) FROM public.product_funnel_events p
        WHERE p.workspace_id = e.id AND p.stage = 'inbox_connection') AS connect_attempts,
      (SELECT count(*) FROM public.product_funnel_events p
        WHERE p.workspace_id = e.id AND p.stage = 'inbox_connection' AND p.outcome = 'success') AS connect_ok
    FROM enrolled e
  )
  SELECT
    flow, convert,
    count(*),
    min(assigned_at),
    count(*) FILTER (WHERE created_at <= now() - interval '1 day'),
    count(*) FILTER (WHERE created_at <= now() - interval '1 day'
                       AND first_inbox_at < created_at + interval '1 day'),
    count(*) FILTER (WHERE created_at <= now() - interval '1 day'
                       AND onboarding_value_activated_at < created_at + interval '1 day'),
    count(*) FILTER (WHERE created_at <= now() - interval '3 days'),
    count(*) FILTER (WHERE created_at <= now() - interval '3 days'
                       AND first_draft_at < created_at + interval '3 days'),
    count(*) FILTER (WHERE created_at <= now() - interval '7 days'),
    count(*) FILTER (WHERE created_at <= now() - interval '7 days' AND active_days_7 >= 2),
    count(*) FILTER (WHERE created_at <= now() - interval '30 days'),
    count(*) FILTER (WHERE created_at <= now() - interval '30 days'
                       AND first_paid_at < created_at + interval '30 days'),
    count(*) FILTER (WHERE first_paid_at IS NOT NULL),
    count(*) FILTER (WHERE connect_attempts > 0),
    count(*) FILTER (WHERE connect_attempts > 0 AND connect_ok = 0),
    count(*) FILTER (WHERE onboarding_completed_at IS NOT NULL)
  FROM facts
  GROUP BY flow, convert
  ORDER BY flow, convert;
$$;

-- ---------------------------------------------------------------------------
-- growth_onboarding_steps: distinct enrolled customer workspaces per arm that
-- recorded each setup-dialog and Flow B stage at least once. Each stage also
-- gets a row with category NULL: its distinct workspaces over every category.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_onboarding_steps(
  p_internal_emails  text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
RETURNS TABLE (
  flow       text,
  convert    text,
  stage      text,
  category   text,
  workspaces bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH enrolled AS (
    SELECT w.id,
           COALESCE(f.variant_id, 'control') AS flow,
           COALESCE(c.variant_id, 'off') AS convert
    FROM public.workspaces w
    LEFT JOIN public.users u ON u.id = w.owner_id
    LEFT JOIN public.experiment_assignments f
      ON f.experiment_key = 'onb_flow' AND f.subject_id = replace(w.id::text, '-', '')
    LEFT JOIN public.experiment_assignments c
      ON c.experiment_key = 'onb_convert' AND c.subject_id = replace(w.id::text, '-', '')
    WHERE (f.subject_id IS NOT NULL OR c.subject_id IS NOT NULL)
      AND NOT public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains)
  )
  SELECT e.flow, e.convert, p.stage, p.category, count(DISTINCT p.workspace_id)
  FROM enrolled e
  JOIN public.product_funnel_events p ON p.workspace_id = e.id
  WHERE p.stage IN (
    'onboarding_step_viewed', 'onboarding_completed',
    'second_inbox_prompt_shown', 'second_inbox_prompt_clicked',
    'plan_summary_shown', 'plan_summary_dismissed', 'plan_summary_clicked',
    'usage_meter_shown', 'grace_end_note_shown'
  )
  GROUP BY GROUPING SETS ((e.flow, e.convert, p.stage, p.category), (e.flow, e.convert, p.stage))
  ORDER BY 1, 2, 3, 4 NULLS FIRST;
$$;

-- ---------------------------------------------------------------------------
-- growth_onboarding_daily: one row per UTC day of the last p_days (at most
-- 120), oldest first. created = new customer workspaces; flow_* / convert_*
-- are the ones among them that hold an onb_flow / onb_convert assignment.
-- mature_1d / value_1d are every customer workspace, enrolled or not: the
-- baseline for the primary metric (a call on a real inbox within 24 h).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.growth_onboarding_daily(integer, text[], text[]);
CREATE FUNCTION public.growth_onboarding_daily(
  p_days             integer,
  p_internal_emails  text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
RETURNS TABLE (
  day          date,
  created      bigint,
  flow_control bigint,
  flow_new     bigint,
  convert_off  bigint,
  convert_on   bigint,
  mature_1d    bigint,
  value_1d     bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH days AS (
    SELECT generate_series(
      (now() AT TIME ZONE 'UTC')::date - (GREATEST(LEAST(p_days, 120), 1) - 1),
      (now() AT TIME ZONE 'UTC')::date,
      interval '1 day'
    )::date AS day
  ),
  ws AS (
    SELECT (w.created_at AT TIME ZONE 'UTC')::date AS day, f.variant_id AS flow, c.variant_id AS convert,
           w.created_at <= now() - interval '1 day' AS mature,
           w.onboarding_value_activated_at < w.created_at + interval '1 day' AS value_1d
    FROM public.workspaces w
    LEFT JOIN public.users u ON u.id = w.owner_id
    LEFT JOIN public.experiment_assignments f
      ON f.experiment_key = 'onb_flow' AND f.subject_id = replace(w.id::text, '-', '')
    LEFT JOIN public.experiment_assignments c
      ON c.experiment_key = 'onb_convert' AND c.subject_id = replace(w.id::text, '-', '')
    WHERE w.created_at >= now() - make_interval(days => GREATEST(LEAST(p_days, 120), 1) + 1)
      AND NOT public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains)
  )
  SELECT d.day,
         count(ws.day),
         count(*) FILTER (WHERE ws.flow = 'control'),
         count(*) FILTER (WHERE ws.flow = 'new'),
         count(*) FILTER (WHERE ws.convert = 'off'),
         count(*) FILTER (WHERE ws.convert = 'on'),
         count(*) FILTER (WHERE ws.mature),
         count(*) FILTER (WHERE ws.mature AND ws.value_1d)
  FROM days d
  LEFT JOIN ws ON ws.day = d.day
  GROUP BY d.day
  ORDER BY d.day;
$$;

REVOKE ALL ON FUNCTION public.growth_onboarding_arms(text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_onboarding_arms(text[], text[]) TO service_role;
REVOKE ALL ON FUNCTION public.growth_onboarding_steps(text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_onboarding_steps(text[], text[]) TO service_role;
REVOKE ALL ON FUNCTION public.growth_onboarding_daily(integer, text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_onboarding_daily(integer, text[], text[]) TO service_role;
