-- inbox_autofill_scoreboard: count only inboxes created AFTER the first lookup.
-- The lookup always comes before its connect; the earlier 1-hour backward
-- window credited inboxes connected before the user ever looked the domain up.

CREATE OR REPLACE FUNCTION public.inbox_autofill_scoreboard(p_days integer DEFAULT 30)
RETURNS TABLE (surface text, source text, suggested boolean, result text, lookups bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (l.user_id, l.surface, l.domain)
           l.user_id, l.surface, l.domain, l.source, l.imap_host,
           min(l.created_at) OVER (PARTITION BY l.user_id, l.surface, l.domain) AS first_at
      FROM inbox_autofill_lookups l
     WHERE l.created_at >= now() - make_interval(days => p_days)
     ORDER BY l.user_id, l.surface, l.domain, l.created_at DESC
  ),
  matched AS (
    SELECT la.*,
           (SELECT i.provider || '|' || coalesce(lower(i.imap_host), '')
              FROM inboxes i
              JOIN workspace_members wm ON wm.workspace_id = i.workspace_id AND wm.user_id = la.user_id
             WHERE lower(split_part(i.email_address, '@', 2)) = la.domain
               AND i.created_at >= la.first_at
               AND i.created_at <  la.first_at + interval '7 days'
             ORDER BY i.created_at
             LIMIT 1) AS inbox
      FROM latest la
  )
  SELECT m.surface,
         m.source,
         m.imap_host IS NOT NULL AS suggested,
         CASE
           WHEN m.inbox IS NULL THEN 'abandoned'
           WHEN m.imap_host IS NULL OR split_part(m.inbox, '|', 1) <> 'imap' THEN 'connected'
           WHEN split_part(m.inbox, '|', 2) = lower(m.imap_host) THEN 'kept'
           ELSE 'changed'
         END AS result,
         count(*) AS lookups
    FROM matched m
   GROUP BY 1, 2, 3, 4
   ORDER BY 1, 2, 3, 4;
$$;

REVOKE ALL ON FUNCTION public.inbox_autofill_scoreboard(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_autofill_scoreboard(integer) TO service_role;
