-- ===========================================================================
-- Three /admin/growth metrics that measured something other than their label.
--
-- All three were found by auditing the shipped RPCs against hand-written
-- queries on production, and each is a definition bug rather than a bad row:
-- the SQL does exactly what it says, and what it says is not what the page
-- claims it is.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. growth_retention_curve(p_weeks, p_internal_emails, p_internal_domains)
--
-- THE BUG: the curve counted every value-activated workspace, ours included.
-- Four internal accounts are value-activated, and one of them is driven by the
-- `invoke_synthetic_monitor('read')` pg_cron job every five minutes, so it is
-- retained in every week that will ever exist. Measured the day this was
-- written, page versus external-only:
--
--   week 7 : 3/13 = 23%   vs   1/10 = 10%
--   week 8 : 2/8  = 25%   vs   0/5  =  0%
--   week 9 : 2/5  = 40%   vs   0/2  =  0%
--   week 11: 2/4  = 50%   vs   0/1  =  0%
--
-- The chart drew a RISING tail (23 -> 25 -> 40 -> 50%), which is the classic
-- "retention is stabilising, this is product-market fit" shape. No external
-- workspace has ever come back in week 8 or later. This is the single most
-- decision-relevant number on the page and it was inverted by our own monitor.
--
-- The roster section already excludes internal accounts and says so; this one
-- did not. The address list cannot live in SQL (this repository is public and
-- the accounts are personal addresses), so it is passed in from the same
-- `isInternalAccount()` source the roster uses, exactly as the plan caps are
-- passed into growth_utilization_bands.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.growth_retention_curve(int);

CREATE OR REPLACE FUNCTION public.growth_retention_curve(
  p_weeks int,
  p_internal_emails text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
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
    LEFT JOIN public.users u ON u.id = w.owner_id
    WHERE w.deleted_at IS NULL
      AND w.onboarding_value_activated_at IS NOT NULL
      -- Ours, not a customer's. An owner with no users row cannot be matched
      -- against the list, and counts as external: overstating external usage
      -- is the safe direction to be wrong in, and it matches isInternalAccount.
      AND NOT (
        lower(coalesce(u.email, '')) = ANY (coalesce(p_internal_emails, '{}'))
        OR EXISTS (
          SELECT 1 FROM unnest(coalesce(p_internal_domains, '{}')) AS d(domain)
          WHERE lower(coalesce(u.email, '')) LIKE '%' || lower(d.domain)
        )
      )
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
-- 2. growth_oauth_abandonment()
--
-- THE BUG: the rate divided a ROW count by a row count plus a DISTINCT ADDRESS
-- count. Three units in one fraction, and it read 60% for Gmail:
--
--   79 surviving oauth_states rows / 51 distinct users
--   53 gmail inboxes / 43 distinct owners
--   page:            79 / (79 + 53) = 59.8%
--   user for user:   51 / (51 + 43) = 54.3%
--   actually lost:   37 / (37 + 43) = 46.3%
--
-- 14 of the 51 users who abandoned a consent screen came back and connected
-- anyway. Counting them as lost is what carried the number from 46% to 60%,
-- and that 60% is the figure being used to prioritise OAuth verification.
--
-- Both sides are now distinct USERS, and a user who eventually connected that
-- provider is not counted as abandoned. Consent screens opened repeatedly by
-- one person are one abandoned user, which is what the label claims.
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
  WITH connected_users AS (
    -- Owners holding a connected inbox for the provider. The inbox belongs to a
    -- workspace, and the consent was granted by a user, so this joins through
    -- to the owner to keep both sides of the ratio in the same unit.
    SELECT i.provider AS provider, w.owner_id AS user_id
    FROM public.inboxes i
    JOIN public.workspaces w ON w.id = i.workspace_id
    WHERE i.provider IN ('gmail', 'outlook')
    GROUP BY i.provider, w.owner_id
  ),
  abandoned_users AS (
    -- A surviving oauth_states row is an abandoned or failed consent: the row
    -- is deleted on a successful callback and never cleaned up otherwise.
    SELECT os.provider AS provider, os.user_id
    FROM public.oauth_states os
    WHERE NOT EXISTS (
      SELECT 1 FROM connected_users c
      WHERE c.provider = os.provider AND c.user_id = os.user_id
    )
    GROUP BY os.provider, os.user_id
  )
  SELECT
    coalesce(a.provider, c.provider) AS provider,
    coalesce(a.abandoned, 0)::int,
    coalesce(c.connected, 0)::int
  FROM (
    SELECT provider, count(*) AS abandoned FROM abandoned_users GROUP BY provider
  ) a
  FULL OUTER JOIN (
    SELECT provider, count(*) AS connected FROM connected_users GROUP BY provider
  ) c ON c.provider = a.provider
  ORDER BY coalesce(a.abandoned, 0) DESC, 1;
$$;

-- ---------------------------------------------------------------------------
-- 3. growth_provider_funnel(p_days) — the `attempts` column
--
-- THE BUG: `attempts` was count(*) over all funnel events, and one connection
-- writes a 'started' row AND a terminal row, so it double-counted every
-- resolved attempt while also counting flows that never resolved. Gmail
-- rendered as "92 attempts, 0 failures", which reads as a flawless provider;
-- there were 63 consent flows, 29 connected, and 34 never came back. That
-- `attempts <> successes + failures` on every single row is what gave it away.
--
-- `attempts` is now RESOLVED attempts: success + failure. It deliberately does
-- not count 'started', because a started row means different things per
-- provider (an OAuth flow starts once and may never return; an IMAP form is
-- opened once and submitted repeatedly, so yandex shows 17 started against 36
-- terminal events). Consent screens that never resolve are the abandonment
-- table's job, immediately below this one on the page.
--
-- The other columns are unchanged and were verified correct.
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
    count(*) FILTER (WHERE ev.outcome IN ('success', 'failure'))::int,
    count(*) FILTER (WHERE ev.outcome = 'success')::int,
    count(*) FILTER (WHERE ev.outcome = 'failure')::int,
    mode() WITHIN GROUP (ORDER BY ev.error_category)
      FILTER (WHERE ev.outcome = 'failure' AND ev.error_category IS NOT NULL)
  FROM events ev
  GROUP BY ev.category
  ORDER BY count(*) DESC, ev.category;
$$;

-- Same posture as 20260813140000: SECURITY INVOKER, service_role only.
REVOKE ALL ON FUNCTION public.growth_retention_curve(int, text[], text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_oauth_abandonment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_provider_funnel(int) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.growth_retention_curve(int, text[], text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_oauth_abandonment() TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_provider_funnel(int) TO service_role;
