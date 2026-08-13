-- ===========================================================================
-- Active-workspace roster for /admin/growth, and an honest paying count.
--
-- WHY THIS FILE EXISTS
-- The growth page could describe the shape of the user base but never say who
-- was in it. Answering "which accounts are actually using this, and how much"
-- meant leaving the page and writing SQL by hand, which is how the 2026-07-28
-- and 2026-08-13 audits were done. At roughly a hundred accounts the roster
-- fits on one screen and is the most directly useful view the operator has.
--
-- PRIVACY: THIS IS A DELIBERATE CHANGE
-- Every other function in 20260813140000 returns aggregates only, and the page
-- said so in its header. `growth_active_workspaces` returns the owner's email
-- address and the workspace name, on purpose, at the product owner's request.
-- The page header has been updated to state this rather than keeping a promise
-- the page no longer honours. Nothing here returns credentials, tokens,
-- message content, subjects, recipients, IP addresses or user agents: it is
-- account identity plus usage counts.
--
-- COMPED IS NOT PAID
-- `workspaces.plan` reads 'pro' for comped accounts, because the entitlement
-- path and the purchase path both land on the same column. Reporting that as
-- revenue is worse than reporting nothing: on 2026-08-13 the page showed "5
-- paid workspaces" when the true number of paying customers was zero. An
-- account is comped when its owner holds an unexpired `comped_scale` row in
-- `user_usage_entitlements`, and paying means a paid plan WITHOUT one.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- growth_active_workspaces(p_days)
--
-- One row per workspace with at least one successful tool call in the window,
-- newest activity first. Sessions use the same 30 minute inactivity boundary
-- as growth_engagement_bands and buildSessions().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_active_workspaces(p_days int)
RETURNS TABLE (
  workspace_id uuid,
  workspace_name text,
  owner_email text,
  plan text,
  is_comped boolean,
  created_at timestamptz,
  value_activated_at timestamptz,
  last_active_at timestamptz,
  active_days int,
  sessions int,
  calls int,
  successes int,
  errors int,
  inboxes int,
  providers text,
  client text
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
  activity AS (
    SELECT a.workspace_id, a.status, a.created_at
    FROM public.activity_log a, bounds b
    WHERE a.created_at >= ((b.first_day)::timestamp AT TIME ZONE 'utc')
      AND a.created_at < ((b.last_day + 1)::timestamp AT TIME ZONE 'utc')
  ),
  -- A new session starts whenever the gap from the previous successful call
  -- by the same workspace reaches 30 minutes.
  session_starts AS (
    SELECT
      s.workspace_id,
      CASE
        WHEN lag(s.created_at) OVER (PARTITION BY s.workspace_id ORDER BY s.created_at) IS NULL
          OR s.created_at - lag(s.created_at) OVER (PARTITION BY s.workspace_id ORDER BY s.created_at)
             >= interval '30 minutes'
        THEN 1 ELSE 0
      END AS starts_session
    FROM activity s
    WHERE s.status = 'success'
  ),
  usage AS (
    SELECT
      act.workspace_id,
      max(act.created_at) FILTER (WHERE act.status = 'success') AS last_active_at,
      count(DISTINCT (act.created_at AT TIME ZONE 'utc')::date)
        FILTER (WHERE act.status = 'success') AS active_days,
      count(*) AS calls,
      count(*) FILTER (WHERE act.status = 'success') AS successes,
      count(*) FILTER (WHERE act.status <> 'success') AS errors
    FROM activity act
    GROUP BY act.workspace_id
    HAVING count(*) FILTER (WHERE act.status = 'success') > 0
  ),
  session_counts AS (
    SELECT ss.workspace_id, sum(ss.starts_session)::int AS sessions
    FROM session_starts ss
    GROUP BY ss.workspace_id
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
    -- every account that is NOT comped, and `NULL = 'comped_scale'` is NULL,
    -- not false. Without this the flag reads NULL for the overwhelming
    -- majority of rows and every `NOT is_comped` filter silently drops them.
    coalesce(e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now()), false) AS is_comped,
    w.created_at,
    w.onboarding_value_activated_at AS value_activated_at,
    usage.last_active_at,
    usage.active_days::int,
    coalesce(session_counts.sessions, 0) AS sessions,
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
  LEFT JOIN session_counts ON session_counts.workspace_id = usage.workspace_id
  LEFT JOIN inbox_rollup ON inbox_rollup.workspace_id = usage.workspace_id
  ORDER BY usage.last_active_at DESC;
$$;

-- ---------------------------------------------------------------------------
-- growth_revenue_counts()
--
-- The headline billing numbers, with comped accounts kept out of the paying
-- figure. Returned as one row so the card cannot show a paying count computed
-- one way beside a comped count computed another.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_revenue_counts()
RETURNS TABLE (
  paying_workspaces int,
  paying_owners int,
  comped_workspaces int,
  comped_owners int,
  free_workspaces int,
  paying_solo int,
  paying_scale int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH scoped AS (
    SELECT
      w.id,
      w.owner_id,
      coalesce(w.plan, 'free') AS plan,
      -- See the note on growth_active_workspaces: a NULL here would make every
      -- `NOT is_comped` filter below drop the account instead of counting it.
      coalesce(e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now()), false) AS is_comped
    FROM public.workspaces w
    LEFT JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
    WHERE w.deleted_at IS NULL
  )
  SELECT
    count(*) FILTER (WHERE plan IN ('solo', 'pro') AND NOT is_comped)::int AS paying_workspaces,
    count(DISTINCT owner_id) FILTER (WHERE plan IN ('solo', 'pro') AND NOT is_comped)::int AS paying_owners,
    count(*) FILTER (WHERE is_comped)::int AS comped_workspaces,
    count(DISTINCT owner_id) FILTER (WHERE is_comped)::int AS comped_owners,
    count(*) FILTER (WHERE plan = 'free' AND NOT is_comped)::int AS free_workspaces,
    count(*) FILTER (WHERE plan = 'solo' AND NOT is_comped)::int AS paying_solo,
    count(*) FILTER (WHERE plan = 'pro' AND NOT is_comped)::int AS paying_scale
  FROM scoped;
$$;

-- Same posture as 20260813140000: SECURITY INVOKER, service-role only. These
-- read `users` and `user_usage_entitlements`, so an accidental grant here would
-- expose the customer list.
REVOKE ALL ON FUNCTION public.growth_active_workspaces(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_revenue_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_active_workspaces(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_revenue_counts() TO service_role;
