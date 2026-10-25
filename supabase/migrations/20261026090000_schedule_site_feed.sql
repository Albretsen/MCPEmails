-- ============================================================
-- MCPEmails - cron for the albretsen.no site feed
-- 20261026090000_schedule_site_feed
-- ============================================================
--
-- Two jobs, both posting to the Next.js app:
--   1. site-feed-events   every minute. Up to three anonymous ticker lines
--                         from the previous whole minute's activity.
--   2. site-feed-mrr      every 15 minutes. The live MRR figure in NOK,
--                         posted when it changed or at least hourly.
--
-- The route is app/api/internal/site-feed/dispatch/route.ts; the jobs and
-- their privacy rules are in apps/web/src/lib/site-feed/. Both read rows that
-- already exist, so nothing on the product's request path knows the feed is
-- there.
--
-- WHY CRON IS THE ONLY TRIGGER. The events job is rate limited per run (three
-- lines at most), so one run a minute is the global rate limit. A retried or
-- doubled run reads the same previous whole minute and can at worst repeat its
-- own lines.
--
-- SAFE TO SCHEDULE BEFORE THE KEY EXISTS. The route returns immediately when
-- ALBRETSEN_FEED_KEY is unset in Vercel. These jobs can run against an
-- unconfigured route and do nothing.
--
-- WHY IT REUSES 'dispatch_secret'. Same reasoning as
-- 20260902130100_schedule_billing_lifecycle.sql: Vault writes cannot live in a
-- migration, and the routes share a trust boundary (cron-only entry points,
-- exact-string header match, no body that steers behaviour).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;


-- ---------------------------------------------------------------------------
-- The dispatcher poke
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dispatch_site_feed(p_job text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  -- Public, non-secret. The apex domain is the canonical one.
  v_url    text := 'https://mcpemails.com/api/internal/site-feed/dispatch';
  v_secret text;
BEGIN
  -- The only two jobs. Anything else is a caller bug and must not reach the
  -- route as a query string.
  IF p_job NOT IN ('events', 'mrr') THEN
    RAISE EXCEPTION 'dispatch_site_feed: unsupported job %', p_job;
  END IF;

  -- A missing or inaccessible Vault downgrades to a WARNING and a skip rather
  -- than an erroring cron run. This runs 1,440 times a day.
  BEGIN
    SELECT decrypted_secret
      INTO v_secret
      FROM vault.decrypted_secrets
     WHERE name = 'dispatch_secret'
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_secret := NULL;
  END;

  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'dispatch_site_feed: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  -- Fire and forget: pg_net queues the request and returns immediately. The
  -- empty body is deliberate; the route chooses everything it posts.
  PERFORM net.http_post(
    url     := v_url || '?job=' || p_job,
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
END;
$fn$;

COMMENT ON FUNCTION public.dispatch_site_feed(text) IS
  'Called by pg_cron. Posts to the Next.js site-feed dispatcher, which feeds '
  'albretsen.no an anonymous activity ticker (job=events, every minute) and '
  'the MRR figure (job=mrr, every 15 minutes). The secret is read from Vault '
  '(name=''dispatch_secret''), shared with the other dispatchers. Posts an '
  'empty body: all selection lives in the route.';

-- SECURITY DEFINER plus Supabase default grants would let anon or an
-- authenticated browser session trigger the route through /rest/v1/rpc.
REVOKE EXECUTE ON FUNCTION public.dispatch_site_feed(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_site_feed(text) TO service_role;


-- ---------------------------------------------------------------------------
-- The schedules
-- ---------------------------------------------------------------------------
--
-- Unschedule first so re-running this migration lands the definitions below
-- whatever was there, matching the guard in 20260902130100.

DO $guard$
DECLARE
  j text;
BEGIN
  FOREACH j IN ARRAY ARRAY['site-feed-events', 'site-feed-mrr']
  LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
      PERFORM cron.unschedule(j);
    END IF;
  END LOOP;
END;
$guard$;

SELECT cron.schedule(
  'site-feed-events',
  '* * * * *',
  $$SELECT public.dispatch_site_feed('events')$$
);

SELECT cron.schedule(
  'site-feed-mrr',
  '*/15 * * * *',
  $$SELECT public.dispatch_site_feed('mrr')$$
);
