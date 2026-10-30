-- Inbox autofill lookups: one row per server-side provider lookup in the
-- connect form (/api/inboxes/autodiscover) and the onboarding inbox step
-- (/api/onboarding/detect), so the hit rate can be read instead of replayed.
--
-- Only lookups the browser's own table could not answer reach these routes,
-- which is exactly the population the static table cannot speak for: custom
-- domains. Table hits (gmail.com, gmx.net, ...) stay in the browser and are
-- measurable offline, since the table is deterministic.
--
-- Stores the DOMAIN, never the address. Service role only; 180-day retention.

CREATE TABLE IF NOT EXISTS public.inbox_autofill_lookups (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  surface     text NOT NULL CHECK (surface IN ('connect_modal', 'onboarding')),
  domain      text NOT NULL CHECK (length(domain) BETWEEN 1 AND 253),
  -- Where the answer came from; 'none' = nothing found, 'timeout' = the
  -- route's overall budget ran out before an answer.
  source      text NOT NULL CHECK (source IN ('table', 'srv', 'mx', 'ispdb', 'ispdb_mx', 'none', 'timeout')),
  -- Onboarding only: the provider panel chosen (imap, microsoft365, ...).
  kind        text CHECK (kind IS NULL OR length(kind) <= 40),
  imap_host   text CHECK (imap_host IS NULL OR length(imap_host) <= 253),
  smtp_host   text CHECK (smtp_host IS NULL OR length(smtp_host) <= 253),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbox_autofill_lookups_user_domain_idx
  ON public.inbox_autofill_lookups (user_id, domain, created_at);
CREATE INDEX IF NOT EXISTS inbox_autofill_lookups_created_at_idx
  ON public.inbox_autofill_lookups (created_at);

ALTER TABLE public.inbox_autofill_lookups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbox_autofill_lookups FROM anon, authenticated;

-- The read-out. One row per (user, surface, domain) looked up in the window,
-- matched to an inbox on that domain created in one of the user's workspaces
-- within 7 days of the first lookup:
--   kept            an IMAP inbox connected with the suggested IMAP host
--   changed         an IMAP inbox connected with a different IMAP host
--   connected       an inbox connected where nothing was suggested, or a
--                   non-IMAP inbox (Microsoft 365, Google OAuth)
--   abandoned       no inbox on that domain followed
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
               AND i.created_at >= la.first_at - interval '1 hour'
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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('inbox-autofill-lookups-retention')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'inbox-autofill-lookups-retention');
    PERFORM cron.schedule(
      'inbox-autofill-lookups-retention',
      '20 2 * * *',
      $cron$DELETE FROM public.inbox_autofill_lookups WHERE created_at < now() - INTERVAL '180 days'$cron$
    );
  END IF;
END $$;
