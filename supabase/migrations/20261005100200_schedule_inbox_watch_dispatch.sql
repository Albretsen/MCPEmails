-- ============================================================
-- MCPEmails - the every-minute job that starts the new-mail watcher
-- 20261005100200_schedule_inbox_watch_dispatch
-- ============================================================
--
-- RELEASE ORDER: APPLY THIS ONE LAST. The tables (20261005100000) and the
-- functions (20261005100100) can go in at any time. This file is what turns
-- the watcher ON, so it is applied after the VAPID secrets are set and the
-- `client-api` edge function with the /push/dispatch route is deployed.
--
-- It is nevertheless SAFE to apply early, by construction:
--   - dispatch_inbox_watch() posts NOTHING while no mailbox is due, and no
--     mailbox can be due before somebody has subscribed, which needs the new
--     edge function. So before the deploy this job runs one cheap query a
--     minute and makes no HTTP request at all.
--   - if it did post to a function without the route, pg_net records a 404 in
--     net._http_response and nothing raises: pg_net is fire-and-forget, and a
--     cron run only fails when its SQL raises.
--   - a missing Vault secret is a WARNING and a skip, exactly as in
--     dispatch_triage_rules().
--
-- WHAT THIS SETS UP
-- -----------------
--   1. public.dispatch_inbox_watch(): syncs the watch set, counts the due
--      mailboxes, and pokes client-api's /push/dispatch over pg_net, once per
--      20 due mailboxes and at most 4 times a minute.
--   2. The every-minute pg_cron job that calls it.
--   3. The daily retention job for disabled push subscriptions.
--
-- WHY ONE-MINUTE CRON, AND WHY SEVERAL POSTS
-- ------------------------------------------
-- Cron only asks "is anything due?". The cadence that matters is each row's
-- next_check_at, which the dispatcher sets per provider (see
-- push/dispatch.ts). One edge isolate has about a second of CPU, so one
-- request claims a bounded batch (20) and stops; a backlog larger than that
-- is spread over up to 4 requests in the same minute, each of which claims
-- its own rows with FOR UPDATE SKIP LOCKED. Beyond 80 due mailboxes a minute
-- the watcher does not fall over: the oldest-due rows go first and the
-- interval between checks of one mailbox stretches.
--
-- WHY IT REUSES 'dispatch_secret'
-- -------------------------------
-- Same reasoning as dispatch_triage_rules() (20260819190000): the Vault secret
-- is provisioned out of git, a second one would be a second out-of-band step
-- nobody can verify from a migration, and the routes share a trust boundary:
-- cron-only entry points guarded by X-Dispatch-Secret, none of which accepts a
-- body that influences what it does. Edge function secrets are project-wide,
-- so client-api reads the same DISPATCH_SECRET the mcp-server function does.
--
-- Re-runnable: CREATE OR REPLACE, unschedule-then-schedule.
-- NOT APPLIED BY THE AGENT THAT WROTE IT.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;


-- ---------------------------------------------------------------------------
-- The dispatcher
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dispatch_inbox_watch()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  -- Public, non-secret base URL of the client-api Edge Function. The
  -- /push/dispatch route validates the X-Dispatch-Secret header.
  v_url      text := 'https://swvaxorwumispmjaaszb.supabase.co/functions/v1/client-api';
  v_secret   text;
  v_due      integer;
  v_requests integer;
  -- Keep in step with BATCH_SIZE in supabase/functions/client-api/push/dispatch.ts.
  c_batch    constant integer := 20;
  c_max_requests constant integer := 4;
BEGIN
  PERFORM public.sync_inbox_watch_state();

  SELECT count(*)::integer
    INTO v_due
    FROM public.inbox_watch_state s
   WHERE s.next_check_at <= now()
     AND (s.backoff_until IS NULL OR s.backoff_until <= now())
     AND (s.leased_until IS NULL OR s.leased_until <= now());

  -- Nothing to check: no HTTP request. This is the state of every project
  -- until somebody turns notifications on.
  IF v_due = 0 THEN
    RETURN;
  END IF;

  -- A missing secret (or an inaccessible vault) is a WARNING and a skip, not
  -- an error: an erroring cron job is noisier and less recoverable than a
  -- skipping one, and this runs every minute.
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
    RAISE WARNING 'dispatch_inbox_watch: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  v_requests := least(ceil(v_due::numeric / c_batch)::integer, c_max_requests);

  -- Fire and forget. The body is empty on purpose: the route selects nothing
  -- from it, so it cannot be used to steer which mailboxes are checked even
  -- by a caller who somehow holds the secret. Selection, leasing and the
  -- time budget all live in lease_inbox_watches() and push/dispatch.ts.
  FOR n IN 1..v_requests LOOP
    PERFORM net.http_post(
      url     := v_url || '/push/dispatch',
      headers := jsonb_build_object(
                   'Content-Type',      'application/json',
                   'X-Dispatch-Secret', v_secret
                 ),
      body    := '{}'::jsonb
    );
  END LOOP;
END;
$fn$;

COMMENT ON FUNCTION public.dispatch_inbox_watch() IS
  'Called by pg_cron every minute. Syncs the set of watched mailboxes, and when any is due posts to the client-api /push/dispatch route (once per 20 due, at most 4 requests) so the Edge Function can lease and check them. Posts nothing when nothing is due. Base URL is hardcoded (public); the dispatch secret is read from Vault (name ''dispatch_secret''), shared with the scheduled-send and triage dispatchers. Empty body: selection, leasing and budgeting live in lease_inbox_watches() and the Edge Function.';

REVOKE EXECUTE ON FUNCTION public.dispatch_inbox_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_inbox_watch() TO service_role;


-- ---------------------------------------------------------------------------
-- The schedules
-- ---------------------------------------------------------------------------

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-inbox-watch') THEN
    PERFORM cron.unschedule('dispatch-inbox-watch');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'dispatch-inbox-watch',
  '* * * * *',
  $$SELECT public.dispatch_inbox_watch()$$
);

-- ── Retention for dead subscriptions ──────────────────────────────────────
--
-- A subscription the push service reported gone is disabled, not deleted, so
-- "why did my notifications stop" can be answered for a while. After 30 days
-- the row (a push endpoint and two keys that no longer work) is removed.
-- Daily at 03:20 UTC, clear of the other retention sweeps.
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'push-subscriptions-retention') THEN
    PERFORM cron.unschedule('push-subscriptions-retention');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'push-subscriptions-retention',
  '20 3 * * *',
  $$DELETE FROM public.push_subscriptions WHERE disabled_at IS NOT NULL AND disabled_at < now() - INTERVAL '30 days'$$
);
