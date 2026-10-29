-- EUR launch: no automatic launch (owner decision 2026-10-25).
--
-- 20261025120000_eur_launch_cron scheduled the EUR launch dispatcher hourly
-- from 2026-12-07. The owner decided the launch should not turn itself on, so
-- the three jobs are removed here. The dispatcher route and
-- public.dispatch_eur_launch() stay: the launch is now started by hand (see
-- docs/RUNBOOK-eur-launch.md, "Manual launch"), and the same preflight still
-- refuses to launch while a prerequisite is missing.

DO $do$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job
   WHERE jobname IN ('dispatch-eur-launch-first', 'dispatch-eur-launch', 'cleanup-eur-launch');
END;
$do$;
