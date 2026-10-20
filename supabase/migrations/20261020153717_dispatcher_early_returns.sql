-- Dispatchers that call out only when there is work.
--
-- Three pg_cron dispatchers posted to their Edge Function or Vercel route on
-- every tick whether or not anything was due. This copies the shape of
-- dispatch_inbox_watch() (20261005100200): count what the route would select,
-- return before touching Vault or pg_net when the answer is zero.
--
-- Each "is anything due" predicate mirrors the route's own selection exactly,
-- so a tick that returns early is a tick on which the route would have done
-- nothing at all:
--
--   dispatch_scheduled_sends()   handleScheduledDispatch in mcp-server does two
--     things: fail-forward 'sending' rows older than STALE_SENDING_MS (15 min)
--     and send 'pending' rows with send_at <= now. Both are checked. The
--     pending check looks one minute ahead: the function reads its own clock a
--     moment after this one, and a row that falls due in between must not wait
--     an extra tick because of us.
--
--   dispatch_billing_lifecycle('send')   the route's send path is one call to
--     claim_billing_emails(), whose WHERE clause is repeated here verbatim.
--     'sweep' (once a day, scans Stripe) is NOT gated: it has no SQL predicate.
--
--   dispatch_triage_rules()   the predicate of triageStore.listDueRules in
--     mcp-server: enabled, not deleted, not leased, next_run_at <= now, not
--     paused. Stale leases (TRIAGE_STALE_LEASE_MS, 10 min) are reclaimed by the
--     same route, so a stale lease also counts as work. Still ONE request a
--     tick here; the fan-out is a separate migration that must follow the
--     mcp-server deploy carrying the per-inbox lease check.
--
-- dispatch_paywall_followup() is left alone on purpose: its selection lives in
-- TypeScript (src/lib/email/paywall-followup.ts: consent, step timing, the
-- first-paywall rule) and has no exact SQL mirror. A copy that drifted would
-- silently stop the emails.
--
-- Re-runnable: CREATE OR REPLACE only. Attributes (SECURITY DEFINER,
-- search_path) and grants are restated from the live definitions.

CREATE OR REPLACE FUNCTION public.dispatch_scheduled_sends()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Public, non-secret base URL of the mcp-server Edge Function.
  -- The /dispatch route validates the X-Dispatch-Secret header.
  v_url    text := 'https://swvaxorwumispmjaaszb.supabase.co/functions/v1/mcp-server';
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

  PERFORM net.http_post(
    url     := v_url || '/dispatch',
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dispatch_scheduled_sends() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_scheduled_sends() TO service_role;


CREATE OR REPLACE FUNCTION public.dispatch_billing_lifecycle(p_mode text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  -- Public, non-secret. The apex domain is the canonical one; NEXT_PUBLIC_APP_URL
  -- must agree with it or OAuth redirects break, so it is not going to drift.
  v_url    text := 'https://mcpemails.com/api/internal/billing-lifecycle/dispatch';
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
$$;

REVOKE ALL ON FUNCTION public.dispatch_billing_lifecycle(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_billing_lifecycle(text) TO service_role;


CREATE OR REPLACE FUNCTION public.dispatch_triage_rules()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  -- Public, non-secret base URL of the mcp-server Edge Function. The
  -- /triage-dispatch route validates the X-Dispatch-Secret header.
  v_url    text := 'https://swvaxorwumispmjaaszb.supabase.co/functions/v1/mcp-server';
  v_secret text;
BEGIN
  -- Nothing due and no stale lease to reclaim: no HTTP request. The due
  -- predicate is triageStore.listDueRules; the stale one is
  -- TRIAGE_STALE_LEASE_MS (10 minutes). Keep them in step.
  IF NOT EXISTS (
       SELECT 1 FROM public.triage_rules
        WHERE enabled
          AND deleted_at IS NULL
          AND running_since IS NULL
          AND next_run_at IS NOT NULL
          AND next_run_at <= now()
          AND (paused_until IS NULL OR paused_until <= now())
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.triage_rules
        WHERE running_since IS NOT NULL
          AND running_since < now() - INTERVAL '10 minutes'
     )
  THEN
    RETURN;
  END IF;

  -- Read the dispatch secret from Vault. Wrapped in a sub-block so that a
  -- missing secret (or an inaccessible vault) downgrades to a WARNING + skip
  -- rather than raising and tripping the pg_cron run into an error. An erroring
  -- cron job is noisier and less recoverable than a skipping one, and this runs
  -- every minute.
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

  -- Fire and forget. The empty body is deliberate: this route cannot be used
  -- to steer which rules run even by a caller who somehow holds the secret.
  -- All selection, leasing and budgeting happens inside handleTriageDispatch.
  PERFORM net.http_post(
    url     := v_url || '/triage-dispatch',
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dispatch_triage_rules() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_triage_rules() TO service_role;
