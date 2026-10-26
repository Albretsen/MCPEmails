-- Dispatchers: build their target URLs from Vault, not hardcoded hosts.
--
-- WHY. Seventeen cron dispatchers posted to literal production URLs: ten to
-- https://mcpemails.com/api/internal/... and seven to
-- https://swvaxorwumispmjaaszb.supabase.co/functions/v1/.... Any other
-- database that replays these migrations (staging, a local stack, self-host)
-- would post to production every minute. With a copied dispatch_secret that
-- means real billing emails, scheduled sends and referral credits.
--
-- THE CHANGE.
--
--   1. Two helpers read the base URLs from Vault:
--        public._app_base_url()        <- secret 'app_base_url'
--                                         (production: https://mcpemails.com)
--        public._functions_base_url()  <- secret 'functions_base_url'
--                                         (production: https://<ref>.supabase.co/functions/v1)
--      Both return NULL when the secret is missing, empty or unreadable, and
--      strip a trailing slash.
--   2. Every dispatcher is re-created from its latest definition with exactly
--      two edits: v_url is built from the helper, and after the existing
--      dispatch_secret check a NULL v_url raises a WARNING and returns, the
--      same skip a missing dispatch_secret already gives. Every other line is
--      the body that was live in production on 2026-10-26 (checked by md5 of
--      prosrc against the migration replay).
--
-- ORDER IN PRODUCTION. Create both Vault secrets BEFORE applying this file,
-- or every dispatcher skips until they exist:
--   SELECT vault.create_secret('https://mcpemails.com', 'app_base_url');
--   SELECT vault.create_secret('https://swvaxorwumispmjaaszb.supabase.co/functions/v1', 'functions_base_url');
--
-- supabase/tests/dispatch_urls_from_vault.sql asserts no function in public
-- carries either production host again.

CREATE OR REPLACE FUNCTION public._app_base_url()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v text;
BEGIN
  BEGIN
    SELECT decrypted_secret
      INTO v
      FROM vault.decrypted_secrets
     WHERE name = 'app_base_url'
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v := NULL;
  END;
  RETURN nullif(rtrim(btrim(coalesce(v, '')), '/'), '');
END;
$$;

CREATE OR REPLACE FUNCTION public._functions_base_url()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v text;
BEGIN
  BEGIN
    SELECT decrypted_secret
      INTO v
      FROM vault.decrypted_secrets
     WHERE name = 'functions_base_url'
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v := NULL;
  END;
  RETURN nullif(rtrim(btrim(coalesce(v, '')), '/'), '');
END;
$$;

-- Invoker rights: they only read Vault when the caller already can (the
-- SECURITY DEFINER dispatchers run as their owner). Not callable over the API.
REVOKE ALL ON FUNCTION public._app_base_url() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._functions_base_url() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._app_base_url() TO service_role;
GRANT EXECUTE ON FUNCTION public._functions_base_url() TO service_role;

-- ------------------------------------------------------------
-- dispatch_activation_help
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_activation_help()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  v_url    text := public._app_base_url() || '/api/internal/activation-help/dispatch';
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
    RAISE WARNING 'dispatch_activation_help: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_activation_help: Vault secret "app_base_url" is not set, skipping.';
    RETURN;
  END IF;

  -- Fire and forget. The empty body is deliberate: the route selects its own
  -- work, so a caller holding the secret cannot steer who is emailed.
  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$function$;

-- ------------------------------------------------------------
-- dispatch_billing_lifecycle
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_billing_lifecycle(p_mode text DEFAULT 'send'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  -- Public, non-secret. The apex domain is the canonical one; NEXT_PUBLIC_APP_URL
  -- must agree with it or OAuth redirects break, so it is not going to drift.
  v_url    text := public._app_base_url() || '/api/internal/billing-lifecycle/dispatch';
  v_secret text;
BEGIN
  -- The only two modes this function will ask for. Anything else is a caller
  -- bug and must not reach the route as a query string.
  IF p_mode NOT IN ('send', 'sweep') THEN
    RAISE EXCEPTION 'dispatch_billing_lifecycle: unsupported mode %', p_mode;
  END IF;

  -- 'send' with nothing claimable: no HTTP request. This is the WHERE clause
  -- of claim_billing_emails(), which is all the route's send path selects.
  -- Keep the two in step.
  IF p_mode = 'send' AND NOT EXISTS (
       SELECT 1
         FROM public.billing_email_sends
        WHERE sent_at IS NULL
          AND cancelled_at IS NULL
          AND send_after <= now()
          AND attempts < 5
          AND (claimed_at IS NULL OR claimed_at < now() - INTERVAL '15 minutes')
     )
  THEN
    RETURN;
  END IF;

  -- Sub-block so a missing or inaccessible Vault downgrades to a WARNING and a
  -- skip, rather than raising and tripping the cron run into an error state. A
  -- skipping job is quieter and far more recoverable than an erroring one, and
  -- this runs 288 times a day.
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
    RAISE WARNING 'dispatch_billing_lifecycle: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_billing_lifecycle: Vault secret "app_base_url" is not set, skipping.';
    RETURN;
  END IF;

  -- Fire and forget. pg_net queues the request and returns immediately, so a
  -- slow dispatcher cannot hold a cron worker open. The empty body is
  -- deliberate: the route selects, claims and budgets its own work, so even a
  -- caller holding the secret cannot steer which emails go out or to whom.
  PERFORM net.http_post(
    url     := CASE WHEN p_mode = 'sweep' THEN v_url || '?mode=sweep' ELSE v_url END,
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$function$;

-- ------------------------------------------------------------
-- dispatch_black_week_email
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_black_week_email()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  v_url    text := public._app_base_url() || '/api/internal/black-week-email/dispatch';
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

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_black_week_email: Vault secret "app_base_url" is not set, skipping.';
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
$function$;

-- ------------------------------------------------------------
-- dispatch_eur_launch
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_eur_launch()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  v_url    text := public._app_base_url() || '/api/internal/eur-launch/dispatch';
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

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_eur_launch: Vault secret "app_base_url" is not set, skipping.';
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
$function$;

-- ------------------------------------------------------------
-- dispatch_first_30_days
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_first_30_days()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  v_url    text := public._app_base_url() || '/api/internal/first-30-days/dispatch';
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
    RAISE WARNING 'dispatch_first_30_days: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_first_30_days: Vault secret "app_base_url" is not set, skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$function$;

-- ------------------------------------------------------------
-- dispatch_pass_expiry
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_pass_expiry()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  v_url    text := public._app_base_url() || '/api/internal/pass-expiry';
  v_secret text;
BEGIN
  IF NOT EXISTS (
       SELECT 1
         FROM public.user_passes
        WHERE (status = 'active' AND ends_at <= now())
           OR (status = 'scheduled' AND starts_at <= now())
     )
  THEN
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
    RAISE WARNING 'dispatch_pass_expiry: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_pass_expiry: Vault secret "app_base_url" is not set, skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$function$;

-- ------------------------------------------------------------
-- dispatch_paywall_followup
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_paywall_followup()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  v_url    text := public._app_base_url() || '/api/internal/paywall-followup/dispatch';
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
    RAISE WARNING 'dispatch_paywall_followup: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_paywall_followup: Vault secret "app_base_url" is not set, skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$function$;

-- ------------------------------------------------------------
-- dispatch_pro_price_notice
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_pro_price_notice()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  v_url    text := public._app_base_url() || '/api/internal/pro-price-notice/dispatch';
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

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_pro_price_notice: Vault secret "app_base_url" is not set, skipping.';
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
$function$;

-- ------------------------------------------------------------
-- dispatch_referrals
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_referrals()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  -- Public, non-secret. The apex domain is the canonical one.
  v_url    text := public._app_base_url() || '/api/internal/referrals/dispatch';
  v_secret text;
BEGIN
  IF NOT EXISTS (
       SELECT 1
         FROM public.referrals
        WHERE status = 'charged'
          AND qualifies_at <= now()
     )
  THEN
    RETURN;
  END IF;

  -- A missing or inaccessible Vault downgrades to a WARNING and a skip.
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
    RAISE WARNING 'dispatch_referrals: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_referrals: Vault secret "app_base_url" is not set, skipping.';
    RETURN;
  END IF;

  -- Fire and forget; the route selects and claims its own work.
  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$function$;

-- ------------------------------------------------------------
-- dispatch_site_feed
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_site_feed(p_job text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  -- Public, non-secret. The apex domain is the canonical one.
  v_url    text := public._app_base_url() || '/api/internal/site-feed/dispatch';
  v_secret text;
BEGIN
  -- The only two jobs. Anything else is a caller bug and must not reach the
  -- route as a query string.
  IF p_job NOT IN ('events', 'figure') THEN
    RAISE EXCEPTION 'dispatch_site_feed: unsupported job %', p_job;
  END IF;

  -- A missing or inaccessible Vault downgrades to a WARNING and a skip rather
  -- than an erroring cron run.
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

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_site_feed: Vault secret "app_base_url" is not set, skipping.';
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
$function$;

-- ------------------------------------------------------------
-- dispatch_inbox_watch
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_inbox_watch()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  -- Public, non-secret base URL of the client-api Edge Function. The
  -- /push/dispatch route validates the X-Dispatch-Secret header.
  v_url      text := public._functions_base_url() || '/client-api';
  v_secret   text;
  v_due      integer;
  v_retries  boolean;
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

  SELECT EXISTS (
    SELECT 1 FROM public.webhook_deliveries d
     WHERE d.status = 'pending'
       AND d.next_attempt_at <= now()
       AND (d.leased_until IS NULL OR d.leased_until <= now())
  ) INTO v_retries;

  -- Nothing to check and nothing to retry: no HTTP request.
  IF v_due = 0 AND NOT v_retries THEN
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
    RAISE WARNING 'dispatch_inbox_watch: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_inbox_watch: Vault secret "functions_base_url" is not set, skipping.';
    RETURN;
  END IF;

  v_requests := greatest(least(ceil(v_due::numeric / c_batch)::integer, c_max_requests), 1);

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
$function$;

-- ------------------------------------------------------------
-- dispatch_morning_briefs
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_morning_briefs()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  v_url    text := public._functions_base_url() || '/mcp-server';
  v_secret text;
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.morning_briefs
        WHERE enabled
          AND paused_at IS NULL
          AND claimed_at IS NULL
          AND (next_due_at IS NULL OR next_due_at <= now() + INTERVAL '1 minute')
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.morning_briefs
        WHERE claimed_at IS NOT NULL
          AND claimed_at < now() - INTERVAL '10 minutes'
     )
  THEN
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
    RAISE WARNING 'dispatch_morning_briefs: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_morning_briefs: Vault secret "functions_base_url" is not set, skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url || '/morning-brief-dispatch',
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$function$;

-- ------------------------------------------------------------
-- dispatch_reminders
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_reminders()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  -- Public, non-secret base URL of the mcp-server Edge Function. The
  -- /reminders-dispatch route validates the X-Dispatch-Secret header.
  v_url    text := public._functions_base_url() || '/mcp-server';
  v_secret text;
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM public.reminders
        WHERE status IN ('pending', 'due')
          AND claimed_at IS NULL
          AND next_check_at IS NOT NULL
          AND next_check_at <= now() + INTERVAL '1 minute'
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.reminders
        WHERE claimed_at IS NOT NULL
          AND claimed_at < now() - INTERVAL '10 minutes'
     )
  THEN
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
    RAISE WARNING 'dispatch_reminders: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_reminders: Vault secret "functions_base_url" is not set, skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url || '/reminders-dispatch',
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$function$;

-- ------------------------------------------------------------
-- dispatch_scheduled_sends
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_scheduled_sends()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- Public, non-secret base URL of the mcp-server Edge Function.
  -- The /dispatch route validates the X-Dispatch-Secret header.
  v_url    text := public._functions_base_url() || '/mcp-server';
  v_secret text;
BEGIN
  -- Nothing due and nothing stale: no HTTP request. Keep in step with
  -- handleScheduledDispatch (pending rows by send_at) and STALE_SENDING_MS.
  IF NOT EXISTS (
       SELECT 1 FROM public.scheduled_sends
        WHERE status = 'pending'
          AND send_at <= now() + INTERVAL '1 minute'
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.scheduled_sends
        WHERE status = 'sending'
          AND updated_at < now() - INTERVAL '15 minutes'
     )
  THEN
    RETURN;
  END IF;

  -- Read the dispatch secret from Vault. Wrapped in a sub-block so that a
  -- missing secret (or an inaccessible vault) downgrades to a WARNING +
  -- skip rather than raising and tripping the pg_cron run into an error.
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
    RAISE WARNING 'dispatch_scheduled_sends: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_scheduled_sends: Vault secret "functions_base_url" is not set, skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url || '/dispatch',
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$function$;

-- ------------------------------------------------------------
-- dispatch_subscription_followup
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_subscription_followup()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  -- Public, non-secret base URL of the mcp-server Edge Function.
  v_url    text := public._functions_base_url() || '/mcp-server';
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

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_subscription_followup: Vault secret "functions_base_url" is not set, skipping.';
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
$function$;

-- ------------------------------------------------------------
-- dispatch_triage_rules
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_triage_rules()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  -- Public, non-secret base URL of the mcp-server Edge Function. The
  -- /triage-dispatch route validates the X-Dispatch-Secret header.
  v_url      text := public._functions_base_url() || '/mcp-server';
  v_secret   text;
  v_due      integer;
  v_stale    boolean;
  v_requests integer;
  -- Rules one invocation gets through inside TRIAGE_TIME_BUDGET_MS.
  c_per_request  constant integer := 10;
  -- Keep in step with TRIAGE_DISPATCH_FANOUT in mcp-server/triage-engine.ts.
  c_max_requests constant integer := 4;
BEGIN
  -- The predicate of triageStore.listDueRules. Keep them in step.
  SELECT count(*)::integer
    INTO v_due
    FROM public.triage_rules
   WHERE enabled
     AND deleted_at IS NULL
     AND running_since IS NULL
     AND next_run_at IS NOT NULL
     AND next_run_at <= now()
     AND (paused_until IS NULL OR paused_until <= now());

  -- A stale lease (TRIAGE_STALE_LEASE_MS, 10 minutes) is work too: the same
  -- route reclaims it.
  SELECT EXISTS (
           SELECT 1 FROM public.triage_rules
            WHERE running_since IS NOT NULL
              AND running_since < now() - INTERVAL '10 minutes'
         )
    INTO v_stale;

  IF v_due = 0 AND NOT v_stale THEN
    RETURN;
  END IF;

  -- Read the dispatch secret from Vault. Wrapped in a sub-block so that a
  -- missing secret (or an inaccessible vault) downgrades to a WARNING + skip
  -- rather than raising and tripping the pg_cron run into an error.
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
    RAISE WARNING 'dispatch_triage_rules: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_triage_rules: Vault secret "functions_base_url" is not set, skipping.';
    RETURN;
  END IF;

  v_requests := greatest(1, least(ceil(v_due::numeric / c_per_request)::integer, c_max_requests));

  -- Fire and forget. The empty body is deliberate: this route cannot be used
  -- to steer which rules run even by a caller who somehow holds the secret.
  -- All selection, leasing and budgeting happens inside handleTriageDispatch.
  FOR n IN 1..v_requests LOOP
    PERFORM net.http_post(
      url     := v_url || '/triage-dispatch',
      headers := jsonb_build_object(
                   'Content-Type',      'application/json',
                   'X-Dispatch-Secret', v_secret
                 ),
      body    := '{}'::jsonb
    );
  END LOOP;
END;
$function$;

-- ------------------------------------------------------------
-- invoke_outlook_token_refresh
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.invoke_outlook_token_refresh()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  -- Public, non-secret URL of the Edge Function.
  v_url    text := public._functions_base_url() || '/outlook-token-refresh';
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

  IF v_url IS NULL THEN
    RAISE WARNING 'invoke_outlook_token_refresh: Vault secret "functions_base_url" is not set, skipping.';
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
$function$;
