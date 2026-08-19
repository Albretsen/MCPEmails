-- ============================================================
-- MCPEmails - dispatcher and retention for unattended triage
-- 20260819190000_schedule_triage_dispatch
-- ============================================================
--
-- WHAT THIS SETS UP
-- -----------------
--   1. public.dispatch_triage_rules() - a SECURITY DEFINER function that pokes
--      the mcp-server Edge Function's /triage-dispatch route over pg_net.
--   2. The every-minute pg_cron job that calls it.
--   3. The daily retention job for the triage_seen_messages dedupe ledger.
--
-- WHY A ONE-MINUTE CRON DRIVES A 15-MINUTE-MINIMUM FEATURE
-- --------------------------------------------------------
-- The cadence in the cron expression is NOT the rule cadence. Cron only asks
-- the Edge Function "is anything due?"; the schedule that matters lives in
-- triage_rules.next_run_at, and the runner claims a lease per rule. Polling
-- every minute is what makes a 15-minute rule actually fire near its due time
-- instead of drifting, and it is what lets the runner return early on a
-- wall-clock budget and be re-entered a minute later to finish the backlog.
-- This mirrors dispatch-scheduled-sends exactly.
--
-- WHY IT REUSES THE EXISTING 'dispatch_secret'
-- --------------------------------------------
-- Deliberately the SAME Vault secret as dispatch_scheduled_sends(), not a new
-- one. The secret value is created out-of-git by a one-off vault.create_secret()
-- statement run against the remote database (see 20260607000000), because Vault
-- writes cannot live in a migration. Minting a second secret would mean a
-- second out-of-band provisioning step that this migration cannot perform and
-- cannot verify, and would leave the feature silently dead on any environment
-- where somebody forgot it. The two routes share a trust boundary anyway: both
-- are cron-only entry points into the same Edge Function, guarded by an exact
-- string match on X-Dispatch-Secret, and neither accepts a request body that
-- influences what it does.
--
-- The Edge Function checks the incoming X-Dispatch-Secret header against its
-- DISPATCH_SECRET env var. See supabase/functions/mcp-server/index.ts, the
-- /triage-dispatch route guard and handleTriageDispatch.
--
-- Related: supabase/migrations/20260607000000_scheduled_send_dispatch_vault.sql
-- (the function this copies), 20260603202232_harden_grants.sql (the grant
-- hardening this repeats), 20260804000000_disable_synthetic_canary_schedule.sql
-- (the cron guard style), 20260526000004_enum_check_constraints_retention_and_index.sql
-- (the inline-DELETE retention job style),
-- 20260819170000_create_triage_automations.sql (the tables).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;


-- ---------------------------------------------------------------------------
-- The dispatcher
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dispatch_triage_rules()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  -- Public, non-secret base URL of the mcp-server Edge Function. The
  -- /triage-dispatch route validates the X-Dispatch-Secret header.
  v_url    text := 'https://swvaxorwumispmjaaszb.supabase.co/functions/v1/mcp-server';
  v_secret text;
BEGIN
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

  -- Fire and forget. pg_net queues the request and returns immediately, so a
  -- slow or hung Edge Function cannot hold the cron worker open. The function
  -- deliberately posts an empty body: it selects no rules and passes no
  -- arguments, so this route cannot be used to steer which rules run even by a
  -- caller who somehow holds the secret. All selection, leasing and budgeting
  -- happens inside handleTriageDispatch against triage_rules.next_run_at.
  PERFORM net.http_post(
    url     := v_url || '/triage-dispatch',
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$fn$;

COMMENT ON FUNCTION public.dispatch_triage_rules() IS
  'Called by pg_cron every minute. Posts to the mcp-server /triage-dispatch route so the Edge Function can claim and run due triage_rules. Base URL is hardcoded (public); the dispatch secret is read from Vault (vault.decrypted_secrets WHERE name=''dispatch_secret''), reusing the scheduled-send secret so no additional out-of-git Vault provisioning is required. Posts an empty body: rule selection, leasing and the wall-clock budget all live in the Edge Function.';

-- ── Grant hardening (same posture as 20260603202232) ──────────────────────
-- SECURITY DEFINER plus the Supabase default grants would let anon or an
-- authenticated browser session trigger dispatch HTTP requests through
-- /rest/v1/rpc. Only pg_cron (running as the function owner) and service_role
-- have any business calling this. REVOKE on an absent grant is a no-op, so this
-- is safe to re-run.
REVOKE EXECUTE ON FUNCTION public.dispatch_triage_rules() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_triage_rules() TO service_role;


-- ---------------------------------------------------------------------------
-- The schedules
-- ---------------------------------------------------------------------------

-- cron.schedule already replaces a job of the same name, but it is only
-- idempotent for an unchanged definition: if the command or cadence below is
-- ever edited, an unscheduled-then-rescheduled job is the version that actually
-- lands. Unscheduling first makes re-running this migration deterministic
-- either way, and matches the guard style in the canary migration.
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-triage-rules') THEN
    PERFORM cron.unschedule('dispatch-triage-rules');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'dispatch-triage-rules',
  '* * * * *',
  $$SELECT public.dispatch_triage_rules()$$
);

-- ── Retention for the dedupe ledger ───────────────────────────────────────
--
-- triage_seen_messages holds one row per message per rule, forever, unless
-- something removes them. It is by construction the highest-volume table in the
-- schema, so it needs a retention policy for size alone; it also holds a keyed
-- digest per message a rule has looked at, so it needs one for privacy.
--
-- Retention window: 90 days, matching ACTIVITY_LOG_RETENTION_DAYS and the
-- activity-log-retention job this is modelled on. Comfortably longer than the
-- longest rule cadence (1440 minutes), so a digest can never age out of the
-- ledger while its rule could still re-match the message and act on it twice.
--
-- To change the window: unschedule 'triage-seen-retention', edit the INTERVAL
-- below, and re-run cron.schedule. Runs daily at 03:00 UTC, an hour after the
-- activity-log sweep so the two do not contend.
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'triage-seen-retention') THEN
    PERFORM cron.unschedule('triage-seen-retention');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'triage-seen-retention',
  '0 3 * * *',
  $$DELETE FROM public.triage_seen_messages WHERE first_seen_at < now() - INTERVAL '90 days'$$
);
