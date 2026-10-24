-- ===========================================================================
-- The Pro price notice email, sent by itself on the announcement day.
-- 20261024150000_pro_price_notice_cron
--
-- Pro goes from $15 to $19 for new subscriptions on 2026-12-08 (owner
-- approved 2026-10-24; apps/web/src/lib/stripe/pro-price-change.ts). One email
-- to consenting Free users goes out on 2026-11-17, the announcement day.
--
-- 1. public.dispatch_pro_price_notice(): POSTs to
--    /api/internal/pro-price-notice/dispatch with the Vault `dispatch_secret`,
--    the same shape as dispatch_paywall_followup().
-- 2. cron job `dispatch-pro-price-notice` at 08:00, 09:00 and 10:00 UTC on
--    17 November (09:00 to 11:00 in Oslo). The first call sends; the later
--    ones pick up anyone the first did not reach (each run is capped) and
--    otherwise find everyone already claimed. pg_cron has no year field, so
--    the job would fire again every 17 November: the route refuses to send on
--    any day but the announcement day, and step 3 removes the job once it is
--    past.
-- 3. A one-shot cleanup job on 18 November that unschedules both jobs.
--
-- Safe to re-run: the function is replaced and each job is unscheduled
-- before it is scheduled.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.dispatch_pro_price_notice()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  v_url    text := 'https://mcpemails.com/api/internal/pro-price-notice/dispatch';
  v_secret text;
BEGIN
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
    RAISE WARNING 'dispatch_pro_price_notice: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$fn$;

COMMENT ON FUNCTION public.dispatch_pro_price_notice() IS
  'Posts to the Pro price notice dispatcher. The route sends only on the announcement day (2026-11-17, Oslo) and only once per person.';

REVOKE EXECUTE ON FUNCTION public.dispatch_pro_price_notice() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_pro_price_notice() TO service_role;

DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job
   WHERE jobname IN ('dispatch-pro-price-notice', 'cleanup-pro-price-notice');

  PERFORM cron.schedule(
    'dispatch-pro-price-notice',
    '0 8,9,10 17 11 *',
    $$SELECT public.dispatch_pro_price_notice()$$
  );

  PERFORM cron.schedule(
    'cleanup-pro-price-notice',
    '0 12 18 11 *',
    $$SELECT cron.unschedule(jobid) FROM cron.job
       WHERE jobname IN ('dispatch-pro-price-notice', 'cleanup-pro-price-notice')$$
  );
END;
$do$;
