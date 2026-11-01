-- ============================================================
-- Read-out of the Arabic setup guide test (/docs/claude-email-arabic).
--
-- READ ONLY. Only aggregate counts come out. Run 90 days after the page went
-- live, with the start date below set to the day it landed on main:
--   npx supabase db query --linked -f scripts/report-arabic-guide-test.sql
--
-- A signup counts when its first-touch landing path is the guide, within 90
-- days of launch and from a non-internal address. First touch means someone who
-- had already seen another page in the last 30 days is credited to that page.
-- Country is workspaces.acquisition_country. Browser language is the code in
-- auth.users.raw_user_meta_data (apps/web/src/lib/acquisition-browser-language.ts).
--
-- Decision thresholds, set before launch:
--   at least 50 signups, at least 50% using a tool and at least 3 paying
--     justifies a scoped marketing launch.
--   below 15 signups closes the question for a year.
--   anything between is inconclusive and does not justify a launch.
-- ============================================================

WITH launch AS (
  SELECT DATE '2026-11-01' AS started_on -- Set to the day the page landed on main.
),
cohort AS (
  SELECT
    w.id,
    w.plan,
    w.analytics_first_tool_used_at,
    w.acquisition_country,
    u.raw_user_meta_data ->> 'acquisition_browser_language' AS browser_language
  FROM public.workspaces w
  JOIN auth.users u ON u.id = w.owner_id
  CROSS JOIN launch l
  WHERE w.acquisition_landing_path = '/docs/claude-email-arabic'
    AND w.created_at >= l.started_on
    AND w.created_at < l.started_on + 90
    AND NOT public.growth_is_internal_email(u.email)
)
SELECT 'total' AS cut, 'signups' AS bucket, count(*) AS signups,
       count(*) FILTER (WHERE analytics_first_tool_used_at IS NOT NULL) AS used_a_tool,
       count(*) FILTER (WHERE coalesce(plan, 'free') <> 'free') AS paying
FROM cohort
UNION ALL
SELECT 'country', coalesce(acquisition_country, 'unknown'), count(*),
       count(*) FILTER (WHERE analytics_first_tool_used_at IS NOT NULL),
       count(*) FILTER (WHERE coalesce(plan, 'free') <> 'free')
FROM cohort GROUP BY 2
UNION ALL
SELECT 'browser_language', coalesce(browser_language, 'unknown'), count(*),
       count(*) FILTER (WHERE analytics_first_tool_used_at IS NOT NULL),
       count(*) FILTER (WHERE coalesce(plan, 'free') <> 'free')
FROM cohort GROUP BY 2
ORDER BY 1, 3 DESC;
