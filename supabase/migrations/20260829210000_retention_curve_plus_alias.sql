-- ===========================================================================
-- growth_retention_curve: match internal accounts through the plus-alias helper
--
-- THE BUG
-- `growth_retention_curve` (20260819140000) matches the internal-account list
-- with a bare `lower(email) = ANY (p_internal_emails)`. `growth_is_internal_
-- email` (20260829120000) added plus-tag folding for exactly this list, and
-- `isInternalAccount()` in Node does the same, but the retention curve was
-- written before the helper existed and still holds its own copy of the match.
--
-- The consequence is specific, not theoretical. `bjellanda+test@gmail.com` is
-- an alias of a listed address and is one of our own test accounts; it
-- value-activated, and it completed a live 100%-off checkout on 2026-08-29. The
-- curve therefore counted it as an EXTERNAL workspace in every week it stayed
-- active, which is the precise failure the internal filter was added to
-- prevent: the same comment in growth-queries.ts records that including our own
-- accounts made the tail rise (23 -> 25 -> 40 -> 50%) when no external
-- workspace has ever returned in week 8 or later.
--
-- THE FIX is to call the helper instead of re-implementing the match. Nothing
-- else about the function changes: same signature, same defaults, same columns,
-- same window arithmetic, so callers are untouched.
--
-- Found by the session building the kiosk's revenue tiles, which hit the same
-- alias hole from the Node side.
-- ===========================================================================

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
      -- Ours, not a customer's. One shared definition, so a plus-addressed
      -- alias of a listed account can never be counted as an external user
      -- here while the revenue counters correctly exclude it. An owner with no
      -- users row cannot be matched and counts as external: overstating
      -- external usage is the safe direction to be wrong in, and it matches
      -- isInternalAccount().
      AND NOT public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains)
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

REVOKE ALL ON FUNCTION public.growth_retention_curve(int, text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_retention_curve(int, text[], text[]) TO service_role;
