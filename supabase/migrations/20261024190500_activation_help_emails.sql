-- ============================================================================
-- 2026-10-24: activation help emails (connection help, first-call help).
--
-- Rules live in apps/web/src/lib/email/activation-help.ts. The dispatcher is
-- POST /api/internal/activation-help/dispatch, which is off unless
-- ACTIVATION_HELP_ENABLED=on and only dry-runs unless ACTIVATION_HELP_DRY_RUN
-- is false as well.
--
-- LEDGER. The existing `lifecycle_email_sends` table (RLS on, no policies,
-- service role only) holds these rows too:
--
--   template     activation_help_connection | activation_help_first_call
--   trigger_key  the workspace id
--   status       claimed -> sent / failed for the send arm,
--                holdout for the 20% control arm (nothing is sent)
--
-- Two changes, both additive:
--
--   1. status may also be 'holdout'. The control arm gets a row of its own so
--      it is counted with exactly the same eligibility as the send arm, and a
--      read-out never has to tell a holdout apart from a stop.
--   2. One row per (template, workspace), whoever owns the workspace. The
--      primary key is (user_id, template, trigger_key), so without this index
--      a change of owner would let the same workspace be emailed twice.
--
-- SCHEDULE. dispatch-activation-help every 15 minutes, same Vault secret and
-- the same fire-and-forget pg_net post as dispatch_paywall_followup().
-- ============================================================================

ALTER TABLE public.lifecycle_email_sends
  DROP CONSTRAINT IF EXISTS lifecycle_email_sends_status_check;

ALTER TABLE public.lifecycle_email_sends
  ADD CONSTRAINT lifecycle_email_sends_status_check
  CHECK (status IN ('claimed', 'sent', 'failed', 'skipped', 'holdout'));

COMMENT ON COLUMN public.lifecycle_email_sends.status IS
  'claimed = the claim insert won and a send may be in flight (or crashed; never retried). sent / failed = terminal outcome of the provider call. skipped = the step was due but a stop condition held, recorded so the sequence stays stopped. holdout = the control arm of a measured email: eligible, deliberately not sent.';

CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_email_sends_activation_help_once
  ON public.lifecycle_email_sends (template, trigger_key)
  WHERE template IN ('activation_help_connection', 'activation_help_first_call');

-- Belt and braces: the table has had RLS on since 20260902140000 and no
-- policy has ever been added. Restated so this migration alone guarantees it.
ALTER TABLE public.lifecycle_email_sends ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- The cron poke. Mirrors dispatch_paywall_followup() in 20260929110000.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE OR REPLACE FUNCTION public.dispatch_activation_help()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  v_url    text := 'https://mcpemails.com/api/internal/activation-help/dispatch';
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
$fn$;

COMMENT ON FUNCTION public.dispatch_activation_help() IS
  'Posts to the Next.js activation help dispatcher every 15 minutes (cron job dispatch-activation-help). The route itself is off unless ACTIVATION_HELP_ENABLED=on.';

REVOKE EXECUTE ON FUNCTION public.dispatch_activation_help() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_activation_help() TO service_role;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-activation-help') THEN
    PERFORM cron.unschedule('dispatch-activation-help');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'dispatch-activation-help',
  '*/15 * * * *',
  $$SELECT public.dispatch_activation_help()$$
);
