-- ============================================================
-- MCPEmails - cron for the outlook-token-refresh Edge Function
-- 20260925120000_schedule_outlook_token_refresh
-- ============================================================
--
-- The function refreshes Outlook access tokens that expire within the next 10
-- minutes and persists the rotated refresh token Microsoft hands back. That
-- rotation is also what keeps an IDLE inbox alive: a Microsoft refresh token
-- has a 90-day sliding lifetime, so an inbox nobody touches dies unless
-- something refreshes it. Until now nothing in the repo scheduled it.
--
-- WHY EVERY 10 MINUTES
-- --------------------
-- It matches the function's own REFRESH_WINDOW_MINUTES: each run picks up
-- every token expiring before the next run, so no token falls between two.
--
-- WHY IT REUSES 'dispatch_secret'
-- -------------------------------
-- Same reasoning as 20260819190000_schedule_triage_dispatch.sql and
-- 20260902130100_schedule_billing_lifecycle.sql: Vault writes cannot live in a
-- migration, so a new secret means an out-of-band provisioning step this file
-- cannot perform or verify. The function is deployed with verify_jwt = false
-- and checks X-Dispatch-Secret against its DISPATCH_SECRET env var, which is a
-- project-wide Edge Function secret already set for mcp-server. Posts an empty
-- body: the function selects its own rows, so the secret cannot steer it.
--
-- Related: supabase/functions/outlook-token-refresh/index.ts (`authorised`).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;


-- ---------------------------------------------------------------------------
-- The poke
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.invoke_outlook_token_refresh()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  -- Public, non-secret URL of the Edge Function.
  v_url    text := 'https://swvaxorwumispmjaaszb.supabase.co/functions/v1/outlook-token-refresh';
  v_secret text;
BEGIN
  -- A missing or inaccessible Vault downgrades to a WARNING and a skip rather
  -- than an erroring cron run, same as the other dispatchers.
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
    RAISE WARNING 'invoke_outlook_token_refresh: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  -- Fire and forget. pg_net queues the request and returns immediately. The
  -- timeout is raised from pg_net's 5 s default: a run that refreshes many
  -- tokens makes one Microsoft round trip per inbox, and the function keeps
  -- going regardless, but a longer timeout keeps net._http_response honest.
  PERFORM net.http_post(
    url                  := v_url,
    headers              := jsonb_build_object(
                              'Content-Type',      'application/json',
                              'X-Dispatch-Secret', v_secret
                            ),
    body                 := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$fn$;

COMMENT ON FUNCTION public.invoke_outlook_token_refresh() IS
  'Called by pg_cron every 10 minutes. Posts to the outlook-token-refresh Edge '
  'Function, which refreshes Outlook tokens expiring within 10 minutes and '
  'persists the rotated refresh token. Secret read from Vault '
  '(name=''dispatch_secret''), shared with the other dispatchers. Empty body.';

-- SECURITY DEFINER plus Supabase default grants would let anon or an
-- authenticated browser session trigger it through /rest/v1/rpc.
REVOKE EXECUTE ON FUNCTION public.invoke_outlook_token_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_outlook_token_refresh() TO service_role;


-- ---------------------------------------------------------------------------
-- The schedule
-- ---------------------------------------------------------------------------
--
-- Unschedule first so re-running this migration lands the definition below
-- even if the command or cadence is later edited (guard style from
-- 20260819190000).

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'outlook-token-refresh') THEN
    PERFORM cron.unschedule('outlook-token-refresh');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'outlook-token-refresh',
  '*/10 * * * *',
  $$SELECT public.invoke_outlook_token_refresh()$$
);
