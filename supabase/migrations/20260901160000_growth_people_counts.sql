-- ===========================================================================
-- People, not workspaces.
--
-- WHY THIS FILE EXISTS
-- Every count on /admin/growth and on the kiosk board is a WORKSPACE count.
-- That was the right unit while the two were interchangeable, and today they
-- very nearly are (324 users own 325 workspaces), but they are not the same
-- question and the wall board is now asked the human one: how many people have
-- ever signed up, and how many of them used it this month. A workspace count
-- answers neither, and the day someone creates a second workspace it starts
-- answering them wrongly with no visible change.
--
-- Two functions, both service-role only, both taking the internal address list
-- as an argument the way growth_revenue_counts does. Neither writes anything
-- and neither returns an address: the kiosk is reachable with a shared token
-- and hangs on a wall, so a function it can reach must not be able to name a
-- customer.
--
-- WHY INTERNAL ACCOUNTS ARE EXCLUDED HERE AND NOT IN growth_daily_metrics.
-- The daily metrics feed engagement and reliability panels, where our own
-- traffic is real load and belongs in the denominator. These two feed the
-- headline "how many humans" numbers, where our own accounts are simply not
-- customers. The excluded count is returned rather than hidden, so the board
-- can say how many it dropped.
--
-- WINDOW SAFETY. `prev_active_users` reads activity_log across the window
-- before last, so at the kiosk's 28 days it reaches back 56. A pg_cron job
-- deletes activity_log past 90 days, so p_days is clamped at 45 by the caller
-- (see growth-queries.ts) rather than trusted; past that the previous-period
-- figure would silently be computed against a purged stretch and every trend
-- on the board would read as a miracle.
--
-- Forward-only. No previously applied migration file is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. growth_people_counts(p_days, p_internal_emails, p_internal_domains)
--
-- One row. Everything the board needs to say "N people have signed up, M of
-- them used it this month", with the previous period beside each so a trend
-- can be computed without a second call.
--
-- "Active" means a SUCCESSFUL call, which is the same definition
-- growth_lifecycle_counts uses for active_7d/active_28d. It deliberately does
-- NOT require the call to touch a mailbox: that stricter test is what "value
-- activation" means, and conflating the two would make an active-user count
-- fall every time somebody spent a session listing their inboxes.
--
-- The unit is the OWNER, not the member. Workspace membership exists but is
-- paid-only and barely used, and activity_log records a workspace rather than
-- the human who made the call, so an owner is the finest grain that is
-- honestly available. Stated here because the column is called active_users
-- and a reader is entitled to know whose activity it is.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_people_counts(
  p_days int DEFAULT 28,
  p_internal_emails text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
RETURNS TABLE (
  total_users int,
  -- Users who existed p_days ago. The denominator for the signup trend.
  total_users_prior int,
  new_users int,
  prev_new_users int,
  active_users int,
  prev_active_users int,
  active_users_7d int,
  -- Users who have ever reached a mailbox on any workspace they own.
  activated_users int,
  -- Ours, dropped from every column above rather than hidden.
  internal_users int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
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
  -- Owners with a successful call, bucketed into the two windows. A workspace
  -- deleted since is still evidence that a person used the product, so
  -- deleted_at is not filtered here: this is a usage question, not an
  -- inventory one.
  owner_activity AS (
    SELECT
      w.owner_id,
      bool_or(a.created_at >= b.window_start) AS in_window,
      bool_or(a.created_at >= b.prev_start AND a.created_at < b.window_start) AS in_prev,
      bool_or(a.created_at >= b.since_7d) AS in_7d
    FROM public.activity_log a
    JOIN public.workspaces w ON w.id = a.workspace_id
    CROSS JOIN bounds b
    WHERE a.status = 'success'
      AND a.created_at >= b.prev_start
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
$$;

COMMENT ON FUNCTION public.growth_people_counts(int, text[], text[]) IS
  'Signed-up, active and activated USER counts with the previous period beside each. Internal accounts excluded and reported separately. Active means a successful call by a workspace the user owns.';

REVOKE ALL ON FUNCTION public.growth_people_counts(int, text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_people_counts(int, text[], text[]) TO service_role;


-- ---------------------------------------------------------------------------
-- 2. growth_user_signup_days(p_days, p_internal_emails, p_internal_domains)
--
-- One row per UTC day for the window, gapless, so a quiet week is a run of
-- zeroes rather than a hole the renderer has to guess about.
--
-- `cumulative_users` counts every external user created UP TO AND INCLUDING
-- that day, not just the ones inside the window. That is what makes it usable
-- as the trend line under a cumulative headline: a running total that restarted
-- at the window's edge would draw a curve rising from zero every time the
-- window moved.
--
-- `activated_users` is the day a person FIRST reached a mailbox on any
-- workspace they own, taken from the durable `onboarding_value_activated_at`
-- column rather than from activity_log, so it survives the 90 day purge and a
-- 90 day window really does mean 90 days.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_user_signup_days(
  p_days int DEFAULT 90,
  p_internal_emails text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
RETURNS TABLE (
  day date,
  new_users int,
  activated_users int,
  cumulative_users int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH span AS (
    SELECT
      ((now() AT TIME ZONE 'utc')::date - (greatest(p_days, 1) - 1)) AS first_day,
      (now() AT TIME ZONE 'utc')::date AS last_day
  ),
  days AS (
    SELECT generate_series(s.first_day, s.last_day, interval '1 day')::date AS day
    FROM span s
  ),
  external_users AS (
    SELECT u.id, (u.created_at AT TIME ZONE 'utc')::date AS signed_up_on
    FROM public.users u
    WHERE NOT public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains)
  ),
  -- One row per person, on the day they first touched a mailbox anywhere.
  first_activation AS (
    SELECT w.owner_id, min((w.onboarding_value_activated_at AT TIME ZONE 'utc')::date) AS activated_on
    FROM public.workspaces w
    WHERE w.onboarding_value_activated_at IS NOT NULL
    GROUP BY w.owner_id
  )
  SELECT
    d.day,
    (SELECT count(*) FROM external_users e WHERE e.signed_up_on = d.day)::int,
    (SELECT count(*) FROM first_activation f
      JOIN external_users e ON e.id = f.owner_id
      WHERE f.activated_on = d.day)::int,
    (SELECT count(*) FROM external_users e WHERE e.signed_up_on <= d.day)::int
  FROM days d
  ORDER BY d.day;
$$;

COMMENT ON FUNCTION public.growth_user_signup_days(int, text[], text[]) IS
  'Daily external user signups and first mailbox activations, plus the all-time running total on each day. Gapless. Activation is read from workspaces.onboarding_value_activated_at, so it is not subject to the 90 day activity_log purge.';

REVOKE ALL ON FUNCTION public.growth_user_signup_days(int, text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_user_signup_days(int, text[], text[]) TO service_role;
