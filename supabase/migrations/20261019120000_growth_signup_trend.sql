-- ---------------------------------------------------------------------------
-- growth_signup_trend(p_weeks, p_internal_emails, p_internal_domains)
--
-- The data behind the "Is signup growth over?" tile on /admin/growth.
--
-- One row per Mon-Sun UTC week, oldest first, the current week included and
-- last, gapless. A week is p_weeks completed weeks plus the one being lived.
--
--   workspaces  every workspace created that week (for the current week: so
--               far). Soft-deleted workspaces are COUNTED, so a week's number
--               never shrinks after the fact when someone deletes theirs. A
--               trend line that rewrites its own history cannot raise an alarm
--               anyone should trust.
--   by_now      the part of that week created before the same offset into the
--               week as `as_of`. For the current week it equals `workspaces`;
--               for earlier weeks it is "where that week stood at this point",
--               which is the only fair comparison for a partial week.
--   as_of       the instant the offset was taken, so a cached result still
--               says which point in the week `by_now` describes.
--
-- Workspaces, not people: this is the weekly series the founder reads, and it
-- is the unit of the activation ladder beside it. Internal accounts are
-- excluded with the same 3-arg helper as growth_signup_pace. The LEFT JOIN
-- keeps a workspace whose owner row is gone, counted as external, which is the
-- safe direction everywhere else in this schema.
--
-- Re-runnable: CREATE OR REPLACE only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_signup_trend(
  p_weeks int DEFAULT 12,
  p_internal_emails text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
RETURNS TABLE (
  week_start date,
  workspaces int,
  by_now int,
  as_of timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH span AS (
    SELECT
      now() AS as_of,
      date_trunc('week', now() AT TIME ZONE 'utc') AS this_week,
      (now() AT TIME ZONE 'utc') - date_trunc('week', now() AT TIME ZONE 'utc') AS into_week
  ),
  weeks AS (
    SELECT generate_series(
      s.this_week - make_interval(weeks => least(greatest(coalesce(p_weeks, 12), 1), 52)),
      s.this_week,
      interval '1 week'
    ) AS week_start
    FROM span s
  ),
  created AS (
    SELECT w.created_at AT TIME ZONE 'utc' AS created_utc
    FROM public.workspaces w
    LEFT JOIN public.users u ON u.id = w.owner_id
    CROSS JOIN span s
    WHERE w.created_at >= ((s.this_week - make_interval(weeks => 52)) AT TIME ZONE 'utc')
      AND NOT public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains)
  )
  SELECT
    wk.week_start::date,
    count(c.created_utc)::int,
    count(c.created_utc) FILTER (WHERE c.created_utc < wk.week_start + s.into_week)::int,
    s.as_of
  FROM weeks wk
  CROSS JOIN span s
  LEFT JOIN created c
    ON c.created_utc >= wk.week_start
   AND c.created_utc < wk.week_start + interval '1 week'
  GROUP BY wk.week_start, s.as_of
  ORDER BY wk.week_start;
$$;

COMMENT ON FUNCTION public.growth_signup_trend(int, text[], text[]) IS
  'New workspaces per Mon-Sun UTC week (soft-deleted included, internal excluded), current week last, with each week''s count at the same offset into the week as now. Feeds the signup trend tile on /admin/growth.';

REVOKE ALL ON FUNCTION public.growth_signup_trend(int, text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_signup_trend(int, text[], text[]) TO service_role;
