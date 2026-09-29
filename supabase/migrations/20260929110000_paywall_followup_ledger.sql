-- ============================================================================
-- 2026-09-29: make `lifecycle_email_sends` safe to use as a claim-then-send
-- ledger, for the paywall follow-up sequence.
--
-- The table was created in 20260902140000_lifecycle_email_preferences.sql with
-- status IN ('sent', 'failed', 'skipped') and DEFAULT 'sent'. That shape
-- assumed the writer inserts AFTER sending. The paywall follow-up inserts
-- BEFORE sending (INSERT ... ON CONFLICT DO NOTHING is the claim; only the
-- winner of the insert sends), so it needs a state that means "claimed, send
-- in progress or crashed mid-send". Without it the claim row would have to say
-- 'sent' before anything was sent.
--
-- Changes, all additive and all safe on a table that has held zero rows since
-- it was created:
--
--   1. status may also be 'claimed'.
--   2. The DEFAULT becomes 'claimed'. A writer that forgets to set status must
--      never produce a row that reads as a delivered email.
--   3. `finished_at`: when a claimed row reached sent / failed. `sent_at`
--      keeps its existing meaning for the older writers (the row's creation
--      time, which for a claim is the claim time).
--
-- A 'claimed' row that never reaches a terminal state (the process died
-- between the claim and the provider call, or between the provider call and
-- the update) is deliberately NEVER retried by the dispatcher. It stops the
-- sequence for that workspace. Losing one marketing email is the correct loss;
-- sending it twice is not.
--
-- Nothing here schedules anything. The dispatcher route
-- (/api/internal/paywall-followup/dispatch) is not on any cron; see the
-- comment on public.dispatch_paywall_followup() below.
-- ============================================================================

ALTER TABLE public.lifecycle_email_sends
  DROP CONSTRAINT IF EXISTS lifecycle_email_sends_status_check;

ALTER TABLE public.lifecycle_email_sends
  ADD CONSTRAINT lifecycle_email_sends_status_check
  CHECK (status IN ('claimed', 'sent', 'failed', 'skipped'));

ALTER TABLE public.lifecycle_email_sends
  ALTER COLUMN status SET DEFAULT 'claimed';

ALTER TABLE public.lifecycle_email_sends
  ADD COLUMN IF NOT EXISTS finished_at timestamptz;

COMMENT ON COLUMN public.lifecycle_email_sends.status IS
  'claimed = the claim insert won and a send may be in flight (or crashed; never retried). sent / failed = terminal outcome of the provider call. skipped = the step was due but a stop condition held, recorded so the sequence stays stopped.';

COMMENT ON COLUMN public.lifecycle_email_sends.finished_at IS
  'When a claimed row reached sent or failed. NULL on a claimed row means the outcome is unknown.';

-- The dispatcher reads a user's rows for one sequence at a time.
CREATE INDEX IF NOT EXISTS idx_lifecycle_email_sends_user_template
  ON public.lifecycle_email_sends (user_id, template);


-- ---------------------------------------------------------------------------
-- The cron poke, CREATED BUT NOT SCHEDULED.
--
-- Mirrors dispatch_billing_lifecycle() in 20260902130100 (same Vault secret,
-- same fire-and-forget pg_net post, empty body). It is deliberately not passed
-- to cron.schedule here: the sequence must not run until the founder has read
-- the drafts and the dry-run output. Even once scheduled, the route no-ops
-- unless PAYWALL_FOLLOWUP_ENABLED=on, and it only dry-runs unless
-- PAYWALL_FOLLOWUP_DRY_RUN=false as well.
--
-- To schedule, by hand, after sign-off:
--   SELECT cron.schedule('dispatch-paywall-followup', '*/15 * * * *',
--                        $$SELECT public.dispatch_paywall_followup()$$);
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE OR REPLACE FUNCTION public.dispatch_paywall_followup()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  v_url    text := 'https://mcpemails.com/api/internal/paywall-followup/dispatch';
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

COMMENT ON FUNCTION public.dispatch_paywall_followup() IS
  'Posts to the Next.js paywall follow-up dispatcher. NOT scheduled by any migration; schedule by hand after sign-off. The route itself is off unless PAYWALL_FOLLOWUP_ENABLED=on.';

REVOKE EXECUTE ON FUNCTION public.dispatch_paywall_followup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_paywall_followup() TO service_role;
