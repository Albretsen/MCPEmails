-- ============================================================
-- MCPEmails - cron for the one Black Week 2026 email
-- 20261024150000_schedule_black_week_email
-- ============================================================
--
-- One job, 'dispatch-black-week-email': every 10 minutes from 07:00 to 20:59
-- UTC on 27 November. It posts to the Next.js route
-- /api/internal/black-week-email/dispatch, exactly like
-- dispatch_billing_lifecycle() in 20260902130100 (same Vault secret
-- 'dispatch_secret', same X-Dispatch-Secret header, empty body, fire and
-- forget through pg_net).
--
-- THE ROUTE GATES ON TIME ITSELF. It sends nothing before
-- 2026-11-27T07:00:00Z (08:00 Oslo), nothing after the offer window closes
-- (1 Dec 2026 23:59 Oslo), and nothing unless both Black Week coupons are live
-- in Stripe. So the cron line only has to be "often enough on the day": the
-- first run sends what fits in its time budget, later runs finish the rest,
-- and every run after that finds everyone already in lifecycle_email_sends
-- (primary key user_id, template, trigger_key) and sends nothing.
--
-- THE JOB REMOVES ITSELF. The last slot of the day (20:50 UTC on 27 Nov 2026)
-- posts once more and then unschedules the job, so the cron line never fires
-- in November 2027. Should it survive anyway (the job was re-created, or the
-- 20:50 run was missed), any call from 2 December 2026 on posts nothing and
-- unschedules it. The route also refuses to send outside the 2026 window.
--
-- No new table: the send ledger is the existing lifecycle_email_sends
-- (RLS enabled, no policies, service role only), template 'black_week_2026',
-- trigger_key 'bw2026'.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE OR REPLACE FUNCTION public.dispatch_black_week_email()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  v_url    text := 'https://mcpemails.com/api/internal/black-week-email/dispatch';
  v_secret text;
BEGIN
  -- Past the campaign: never post again, and take the job down.
  IF now() >= timestamptz '2026-12-02 00:00:00+00' THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-black-week-email') THEN
      PERFORM cron.unschedule('dispatch-black-week-email');
    END IF;
    RETURN;
  END IF;

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
    RAISE WARNING 'dispatch_black_week_email: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb,
    -- The route can run for up to 60 s; pg_net's default 5 s timeout only
    -- abandons the response, not the run, but a longer one keeps the
    -- net._http_response row meaningful.
    timeout_milliseconds := 60000
  );

  -- The last scheduled slot of 27 Nov 2026 (20:50 UTC): after this post the
  -- job has no further work, so it unschedules itself. pg_net sends the
  -- request after this transaction commits, which unscheduling does not stop.
  IF now() >= timestamptz '2026-11-27 20:50:00+00' THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-black-week-email') THEN
      PERFORM cron.unschedule('dispatch-black-week-email');
    END IF;
  END IF;
END;
$fn$;

COMMENT ON FUNCTION public.dispatch_black_week_email() IS
  'Called by pg_cron on 27 Nov 2026; unschedules its job after the 20:50 UTC run and refuses to post from 2026-12-02. Posts to the Next.js Black Week 2026 email dispatcher, which gates on time, on the live Stripe coupons and on lifecycle_email_sends itself. Secret from Vault (name=''dispatch_secret''), shared with the other dispatchers. Empty body.';

REVOKE EXECUTE ON FUNCTION public.dispatch_black_week_email() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_black_week_email() TO service_role;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-black-week-email') THEN
    PERFORM cron.unschedule('dispatch-black-week-email');
  END IF;
END;
$guard$;

-- Minute */10, hours 07-20 UTC, day 27, month 11 (November).
SELECT cron.schedule(
  'dispatch-black-week-email',
  '*/10 7-20 27 11 *',
  $$SELECT public.dispatch_black_week_email()$$
);
