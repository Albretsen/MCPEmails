-- ---------------------------------------------------------------------------
-- growth_signup_pace(p_days, p_internal_emails, p_internal_domains)
--
-- What the kiosk needs to project today's signup total from a partial day.
--
-- One row per UTC day for the window, today included, gapless. `new_users` is
-- the whole day (for today: so far). `by_now` is the part of that day that
-- arrived before the current UTC time of day, so across the complete days
--   sum(by_now) / sum(new_users)
-- is the share of a typical day's signups that has usually arrived by this
-- hour. That share is shaped (signups bunch in the European and US afternoons),
-- which is why it is measured rather than assumed to be hours elapsed / 24.
--
-- `as_of` is the instant the cutoff was taken, so a cached result still says
-- which time of day its `by_now` column describes.
--
-- Internal accounts are excluded with the same 3-arg helper as
-- growth_user_signup_days, so the two never disagree about a day's count.
-- Re-runnable: CREATE OR REPLACE only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_signup_pace(
  p_days int DEFAULT 29,
  p_internal_emails text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
RETURNS TABLE (
  day date,
  new_users int,
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
      ((now() AT TIME ZONE 'utc')::date - (least(greatest(p_days, 1), 120) - 1)) AS first_day,
      (now() AT TIME ZONE 'utc')::date AS last_day,
      (now() AT TIME ZONE 'utc')::time AS cutoff
  ),
  days AS (
    SELECT generate_series(s.first_day, s.last_day, interval '1 day')::date AS day
    FROM span s
  ),
  external_signups AS (
    SELECT
      (u.created_at AT TIME ZONE 'utc')::date AS signed_up_on,
      (u.created_at AT TIME ZONE 'utc')::time AS signed_up_at
    FROM public.users u, span s
    WHERE u.created_at >= (s.first_day::timestamp AT TIME ZONE 'utc')
      AND NOT public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains)
  )
  SELECT
    d.day,
    count(e.signed_up_on)::int,
    count(e.signed_up_on) FILTER (WHERE e.signed_up_at < s.cutoff)::int,
    s.as_of
  FROM days d
  CROSS JOIN span s
  LEFT JOIN external_signups e ON e.signed_up_on = d.day
  GROUP BY d.day, s.as_of
  ORDER BY d.day;
$$;

COMMENT ON FUNCTION public.growth_signup_pace(int, text[], text[]) IS
  'Daily external signups (today so far included) and, per day, how many arrived before the current UTC time of day. Feeds the kiosk''s projection of today''s total. Gapless.';

REVOKE ALL ON FUNCTION public.growth_signup_pace(int, text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_signup_pace(int, text[], text[]) TO service_role;
