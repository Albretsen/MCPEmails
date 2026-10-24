-- ============================================================================
-- Subscription cleanup: the hourly follow-up dispatcher and plan retention.
-- ============================================================================
--
-- APPLY AFTER 20261024150000 and after mcp-server is deployed with the
-- /subscription-followup route. Before that the posts are answered 401 or
-- routed nowhere useful, which is harmless but noisy.
--
--   1. public.dispatch_subscription_followup(): counts unsubscribe_requests
--      that are due (check_after passed, not yet checked) and, when there is
--      at least one, posts once to mcp-server /subscription-followup.
--   2. The hourly pg_cron job 'dispatch-subscription-followup'.
--   3. A daily sweep of subscription_plans older than a day (ciphertext of
--      unsubscribe URLs and message ids has no use after the plan's window).
--
-- Same secret and guard as dispatch_triage_rules() (20260819190000): the Vault
-- secret 'dispatch_secret', sent as X-Dispatch-Secret, compared by mcp-server
-- against DISPATCH_SECRET. The body is empty: row selection, leasing and the
-- wall-clock budget all live in runSubscriptionFollowUp
-- (supabase/functions/mcp-server/subscription-cleanup.ts).
--
-- Re-runnable: CREATE OR REPLACE, and each job is unscheduled before it is
-- scheduled.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE OR REPLACE FUNCTION public.dispatch_subscription_followup()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  -- Public, non-secret base URL of the mcp-server Edge Function.
  v_url    text := 'https://swvaxorwumispmjaaszb.supabase.co/functions/v1/mcp-server';
  v_secret text;
  v_due    boolean;
BEGIN
  -- The predicate of the store's listDueFollowUps. Keep them in step.
  SELECT EXISTS (
           SELECT 1 FROM public.unsubscribe_requests
            WHERE checked_at IS NULL
              AND check_after IS NOT NULL
              AND check_after <= now()
         )
    INTO v_due;

  IF NOT v_due THEN
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
    RAISE WARNING 'dispatch_subscription_followup: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url || '/subscription-followup',
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$fn$;

COMMENT ON FUNCTION public.dispatch_subscription_followup() IS
  'Called by pg_cron hourly. Posts to mcp-server /subscription-followup when an unsubscribe_requests row is due for its 72-hour check. Reuses the dispatch_secret Vault secret. Empty body: selection and leasing live in the Edge Function.';

REVOKE ALL ON FUNCTION public.dispatch_subscription_followup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_subscription_followup() TO service_role;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-subscription-followup') THEN
    PERFORM cron.unschedule('dispatch-subscription-followup');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'dispatch-subscription-followup',
  '17 * * * *',
  $$SELECT public.dispatch_subscription_followup()$$
);

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'subscription-plans-retention') THEN
    PERFORM cron.unschedule('subscription-plans-retention');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'subscription-plans-retention',
  '40 3 * * *',
  $$DELETE FROM public.subscription_plans WHERE created_at < now() - INTERVAL '1 day'$$
);
