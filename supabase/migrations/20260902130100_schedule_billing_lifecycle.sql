-- ============================================================
-- MCPEmails - cron for the billing lifecycle email dispatcher
-- 20260902130100_schedule_billing_lifecycle
-- ============================================================
--
-- Three jobs:
--   1. dispatch-billing-lifecycle   every 5 minutes. "Is anything due?"
--   2. sweep-expiring-cards         daily at 09:00 UTC. Queue card warnings.
--   3. billing-email-retention      daily at 04:00 UTC. Prune finished rows.
--
-- WHY FIVE MINUTES
-- ----------------
-- The cadence is NOT the email schedule. Every delay in the sequence lives in
-- `billing_email_sends.send_after`, materialised when the sequence is queued;
-- cron only asks whether anything has come due. Five minutes is chosen by the
-- tightest deadline in the feature: the first dunning email has to land within
-- 60 minutes of the decline, because the customer's own bank notification is
-- still on their phone and that is the whole reason the first email recovers
-- more than the other three combined. Five minutes leaves eleven cycles of
-- slack against that hour. Every other row in the table is due on a day
-- boundary and does not care.
--
-- WHY IT POSTS TO THE WEB APP, NOT THE EDGE FUNCTION
-- --------------------------------------------------
-- Unlike dispatch_scheduled_sends() and dispatch_triage_rules(), which poke the
-- mcp-server Edge Function, this one posts to the Next.js app. The dispatcher
-- needs Resend, the Stripe SDK, the plan catalogue and nine email templates,
-- all of which already live there and none of which exist in the Deno runtime.
-- Putting the copy for a dunning email in a different language and a different
-- deploy pipeline from the purchase confirmation it has to sound like would be
-- a lot of work to make the product worse.
--
-- WHY IT REUSES 'dispatch_secret'
-- -------------------------------
-- Same reasoning as 20260819190000_schedule_triage_dispatch.sql, which reused
-- it from 20260607000000: Vault writes cannot live in a migration, so a new
-- secret means a second out-of-band provisioning step that this file cannot
-- perform and cannot verify, leaving the feature silently dead anywhere it was
-- forgotten. The three routes share a trust boundary anyway (cron-only entry
-- points, exact-string header match, no body that steers behaviour).
--
-- ONE THING DOES HAVE TO BE PROVISIONED BY HAND: the same secret value must be
-- set as DISPATCH_SECRET in the Vercel environment, or every POST from here is
-- answered with a 403. The route logs loudly when the variable is missing.
--
-- SAFE TO SCHEDULE BEFORE THE FEATURE IS SIGNED OFF. The dispatcher reads
-- BILLING_LIFECYCLE_EMAILS and returns immediately when it is `off`, which is
-- the default. These jobs can run for a week against an empty queue and send
-- nothing.
--
-- Related: 20260902130000_billing_lifecycle_emails.sql (the tables and the
-- claim), 20260819190000_schedule_triage_dispatch.sql (the pattern copied).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;


-- ---------------------------------------------------------------------------
-- The dispatcher poke
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dispatch_billing_lifecycle(p_mode text DEFAULT 'send')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
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
$fn$;

COMMENT ON FUNCTION public.dispatch_billing_lifecycle(text) IS
  'Called by pg_cron. Posts to the Next.js billing lifecycle dispatcher so it '
  'can claim and send due rows from billing_email_sends (mode=send, every 5 '
  'minutes) or queue card-expiry warnings (mode=sweep, daily). Base URL is '
  'public; the secret is read from Vault (name=''dispatch_secret''), shared with '
  'the scheduled-send and triage dispatchers. Posts an empty body: all selection '
  'and budgeting lives in the route.';

-- SECURITY DEFINER plus Supabase default grants would let anon or an
-- authenticated browser session trigger sends through /rest/v1/rpc.
REVOKE EXECUTE ON FUNCTION public.dispatch_billing_lifecycle(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_billing_lifecycle(text) TO service_role;


-- ---------------------------------------------------------------------------
-- The schedules
-- ---------------------------------------------------------------------------
--
-- cron.schedule replaces a job of the same name, but only idempotently for an
-- unchanged definition: if a command or cadence below is edited, the version
-- that actually lands is an unscheduled-then-rescheduled job. Unscheduling
-- first makes re-running this migration deterministic either way, matching the
-- guard style in 20260819190000.

DO $guard$
DECLARE
  j text;
BEGIN
  FOREACH j IN ARRAY ARRAY['dispatch-billing-lifecycle', 'sweep-expiring-cards', 'billing-email-retention']
  LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = j) THEN
      PERFORM cron.unschedule(j);
    END IF;
  END LOOP;
END;
$guard$;

SELECT cron.schedule(
  'dispatch-billing-lifecycle',
  '*/5 * * * *',
  $$SELECT public.dispatch_billing_lifecycle('send')$$
);

-- 09:00 UTC, which is 10:00 or 11:00 in Bergen and a reasonable hour across
-- Europe and the Americas for an email that is not urgent. A card expiring at
-- the end of the month does not care which minute it is warned about, and
-- there is no reason to wake anybody at 03:00 for it.
SELECT cron.schedule(
  'sweep-expiring-cards',
  '0 9 * * *',
  $$SELECT public.dispatch_billing_lifecycle('sweep')$$
);


-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
--
-- 180 days, and only for rows that have REACHED A TERMINAL STATE. A pending row
-- is never pruned, however old, because the only way a pending row gets old is
-- that something is wrong and deleting the evidence is the opposite of useful.
--
-- Why 180 and not the 90 used for the activity log: this table is the answer to
-- "did we email this customer, and what did we say" during a billing dispute,
-- and 90 days is shorter than an annual subscriber's gap between invoices. It
-- is also tiny. At the current rate the whole table will hold a few hundred
-- rows a year.
--
-- 04:00 UTC, an hour after the triage sweep at 03:00 so the two do not contend.
SELECT cron.schedule(
  'billing-email-retention',
  '0 4 * * *',
  $$DELETE FROM public.billing_email_sends
     WHERE (sent_at IS NOT NULL OR cancelled_at IS NOT NULL)
       AND COALESCE(sent_at, cancelled_at) < now() - INTERVAL '180 days'$$
);
