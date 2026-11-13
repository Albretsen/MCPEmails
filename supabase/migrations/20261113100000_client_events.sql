-- ============================================================================
-- 2026-11-13: what real browsers do on the pages where people buy.
--
-- From 2026-11-11 evening, buy clicks stopped reaching the server while every
-- buy path worked when tested by hand. Nothing recorded what happens in a
-- visitor's browser: a script error, a chunk that fails to load, a click that
-- leads nowhere. public/ce.js (a small standalone script, independent of the
-- React bundle) now reports those, and /api/analytics/client-event writes
-- them here.
--
-- What is stored, and nothing else:
--   kind       fixed vocabulary (CHECK below).
--   path       the page path with ids and tokens masked, no query string.
--   detail     small jsonb: error message (emails masked, <= 300 chars), the
--              script file and line, the clicked plan name or link kind,
--              hydrated yes/no, viewport width bucket, page language.
--   browser    coarse family / os / mobile, parsed server-side from the
--              user agent. The user agent itself is not stored. No IP, no
--              user id, no cookie value.
--   signed_in  whether a Supabase session cookie was present.
--
-- Service-role only (RLS on, no policy), like checkout_cancel_feedback.
-- Rows older than 30 days are purged daily.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.client_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL
    CHECK (kind IN ('page', 'error', 'rejection', 'resource', 'buy', 'buy_stalled', 'contact')),
  path        text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 160),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(detail) <= 2048),
  browser     text CHECK (browser IS NULL OR char_length(browser) <= 60),
  signed_in   boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE public.client_events IS
  'Browser-side events from public/ce.js on buy-relevant pages: script errors, failed script loads, buy and contact clicks, buy clicks that did not leave the page, and one page event saying whether the app hydrated. Coarse and anonymous: masked path, small detail, browser family. Service-role only; 30-day retention.';

CREATE INDEX IF NOT EXISTS idx_client_events_created
  ON public.client_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_events_kind_created
  ON public.client_events (kind, created_at DESC);

ALTER TABLE public.client_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.client_events FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.purge_client_events()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH gone AS (
    DELETE FROM public.client_events
    WHERE created_at < now() - interval '30 days'
    RETURNING 1
  )
  SELECT count(*)::integer FROM gone;
$$;

REVOKE ALL ON FUNCTION public.purge_client_events() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_client_events() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.schedule(
      'client-events-retention',
      '35 2 * * *',
      'SELECT public.purge_client_events()'
    );
  END IF;
END $$;
