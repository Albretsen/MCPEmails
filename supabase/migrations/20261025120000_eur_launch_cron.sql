-- ===========================================================================
-- The EUR launch, turned on by itself on its date.
-- 20261025120000_eur_launch_cron
--
-- EUR prices (VAT-inclusive), Stripe Tax and SEPA Direct Debit launch on
-- 2026-12-07 (owner decision 2026-10-24, docs/RUNBOOK-eur-launch.md). The
-- dispatcher at /api/internal/eur-launch/dispatch runs a read-only Stripe
-- preflight and only launches when every check passes; otherwise it stays
-- off, changes nothing and alerts the owner once a day. The OSS registration
-- is due by 2026-12-10, so the first runs may well find it missing: the job
-- keeps trying hourly for 14 days and launches within the hour once it exists.
--
-- 1. public.pricing_switches row `eur_launch_live`, seeded false. Written true
--    only by the dispatcher after a passing preflight and a complete launch;
--    read by apps/web/src/lib/stripe/eur-launch.ts. The dispatcher also keeps
--    `eur_launch_swap_done` and its daily alert claims
--    (`eur_launch_alert:<Oslo day>:<reason>`) in the same table, which is
--    service role only already (RLS on, no grants to anon or authenticated).
-- 2. public.dispatch_eur_launch(): POSTs to the dispatcher with the Vault
--    `dispatch_secret`, the same shape as dispatch_pro_price_notice().
-- 3. Cron jobs, in UTC (pg_cron's clock):
--      dispatch-eur-launch-first  23:00 on 6 December, which is 2026-12-07
--                                 00:00 in Oslo, the first run
--      dispatch-eur-launch        every hour on 7 to 20 December, the 14 days
--    pg_cron has no year field, so both would fire again next December: the
--    route only ever continues a launch that is already live by then, and
--    step 4 removes the jobs first.
-- 4. A one-shot cleanup job on 21 December that unschedules all three.
--
-- Safe to re-run: the function is replaced, the seed never overwrites a value,
-- and each job is unscheduled before it is scheduled.
-- ===========================================================================

INSERT INTO public.pricing_switches (key, enabled, note)
VALUES ('eur_launch_live', false,
        'EUR prices + Stripe Tax + SEPA. Set true only by /api/internal/eur-launch/dispatch '
        'after its preflight passed on or after 2026-12-07 (Oslo). Rollback is STRIPE_FORCE_USD, not this row.')
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE public.pricing_switches IS
  'Runtime pricing switches. pro_inbox_cap: when false, every Pro workspace '
  'resolves to unlimited inboxes (the kill switch). Flip with one UPDATE; no '
  'deploy needed. eur_launch_live / eur_launch_swap_done and the '
  'eur_launch_alert:<day>:<reason> claims belong to the EUR launch dispatcher '
  '(apps/web/src/lib/stripe/eur-launch-run.ts).';

CREATE OR REPLACE FUNCTION public.dispatch_eur_launch()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  v_url    text := 'https://mcpemails.com/api/internal/eur-launch/dispatch';
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
    RAISE WARNING 'dispatch_eur_launch: Vault secret "dispatch_secret" is not set, skipping.';
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

COMMENT ON FUNCTION public.dispatch_eur_launch() IS
  'Posts to the EUR launch dispatcher. The route does nothing before 2026-12-07 (Oslo), launches only after a passing Stripe preflight, and is idempotent.';

REVOKE EXECUTE ON FUNCTION public.dispatch_eur_launch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_eur_launch() TO service_role;

DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job
   WHERE jobname IN ('dispatch-eur-launch-first', 'dispatch-eur-launch', 'cleanup-eur-launch');

  PERFORM cron.schedule(
    'dispatch-eur-launch-first',
    '0 23 6 12 *',
    $$SELECT public.dispatch_eur_launch()$$
  );

  PERFORM cron.schedule(
    'dispatch-eur-launch',
    '0 * 7-20 12 *',
    $$SELECT public.dispatch_eur_launch()$$
  );

  PERFORM cron.schedule(
    'cleanup-eur-launch',
    '0 12 21 12 *',
    $$SELECT cron.unschedule(jobid) FROM cron.job
       WHERE jobname IN ('dispatch-eur-launch-first', 'dispatch-eur-launch', 'cleanup-eur-launch')$$
  );
END;
$do$;
