-- ============================================================
-- MCPEmails - tell owners and admins when rule forwards wait for approval
-- 20261031220000_forward_approval_notices
-- ============================================================
--
-- A forward queued by an automation only wrote a send_approvals row. Nobody was
-- told, so it sat until it expired. This adds two emails per rule:
--
--   queued    Forwards were queued. At most one per rule per run, and at most
--             one per rule per hour however busy the rule is.
--   reminder  Forwards are within 24 hours of their own expires_at. One per
--             rule per deadline window; none if nothing is still waiting.
--
-- HOW IT STAYS OUT OF THE RULE RUN. Nothing here is called by the triage engine.
-- pg_cron calls dispatch_forward_approval_notices() once a minute. It reads what
-- the engine already wrote, so a failure here cannot stop a run or the queue.
--
-- HOW A NOTICE IS CLAIMED, SO TWO CRON RUNS CANNOT DOUBLE-SEND.
--   1. enqueue_forward_approval_notices() takes a transaction advisory lock. A
--      second concurrent call returns at once.
--   2. In one transaction it inserts the notice and stamps the approvals it
--      covers (queued_notice_at, reminder_notice_at). A stamped row is never
--      picked up again, whatever happens next.
--   3. A unique index on (rule, kind, deadline) for reminders is the backstop.
--   4. claim_forward_approval_notices() moves a notice to 'sending' with
--      FOR UPDATE SKIP LOCKED and a 15-minute lease, so only one dispatcher
--      holds it. The send itself uses a Resend Idempotency-Key per notice and
--      per person, so a retry after a crash collapses at Resend.
--
-- A RUN IS NOT SPLIT. A rule holds running_since while it runs. Its rows wait
-- until the lease is released, so a cron tick in the middle of a run cannot send
-- one email for the first three forwards and another for the last two. A stuck
-- lease cannot hold a notice back for more than 15 minutes.
--
-- No mail content is stored or sent. The web dispatcher reads the rule name, the
-- count, the address and the deadline when it sends, from the live rows, so a
-- notice whose forwards were all decided in the meantime is cancelled instead.
--
-- These columns do not bump `revision` (see send_approvals_bump_revision) and
-- grant nothing: no gate reads them.

ALTER TABLE public.send_approvals
  ADD COLUMN IF NOT EXISTS queued_notice_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_notice_at timestamptz;

COMMENT ON COLUMN public.send_approvals.queued_notice_at IS
  'When a "forwards are waiting" notice claimed this rule forward. NULL means no notice covers it yet.';
COMMENT ON COLUMN public.send_approvals.reminder_notice_at IS
  'When an expiry reminder claimed this rule forward. Set once, so a row is reminded about at most once.';

-- Forwards already waiting when this lands were queued without a promise of an
-- email. No burst of notices on the day it goes live; they can still get the
-- expiry reminder.
UPDATE public.send_approvals
SET    queued_notice_at = now()
WHERE  status = 'pending'
  AND  triage_rule_id IS NOT NULL
  AND  queued_notice_at IS NULL;

CREATE INDEX IF NOT EXISTS send_approvals_forward_notice_idx
  ON public.send_approvals (triage_rule_id, expires_at)
  WHERE status = 'pending' AND triage_rule_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.forward_approval_notices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- A deleted rule's forwards lose their link (ON DELETE SET NULL on the
  -- approval), so there is nothing left to say about it: the notice goes too.
  triage_rule_id uuid NOT NULL REFERENCES public.triage_rules(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('queued', 'reminder')),
  -- The earliest expiry when the notice was made. The email reads the live one.
  deadline     timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempts     integer NOT NULL DEFAULT 0,
  claimed_at   timestamptz,
  sent_at      timestamptz,
  -- A short code, never a provider response or an address.
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.forward_approval_notices IS
  'Ledger of the queued and reminder emails about rule forwards waiting for approval. '
  'Service role only. Holds no recipient, no address and no mail content.';

CREATE UNIQUE INDEX IF NOT EXISTS forward_approval_notices_reminder_uniq
  ON public.forward_approval_notices (triage_rule_id, deadline)
  WHERE kind = 'reminder';

CREATE INDEX IF NOT EXISTS forward_approval_notices_rule_kind_idx
  ON public.forward_approval_notices (triage_rule_id, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS forward_approval_notices_claimable_idx
  ON public.forward_approval_notices (created_at)
  WHERE status IN ('pending', 'sending');

ALTER TABLE public.forward_approval_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.forward_approval_notices FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.forward_approval_notices TO service_role;

-- The opt-out. Same store and same link as the other per-category opt-outs.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_unsubscribed_categories_known;
ALTER TABLE public.users
  ADD CONSTRAINT users_unsubscribed_categories_known
  CHECK (unsubscribed_categories <@ ARRAY['lifecycle', 'product_update', 'research', 'activity_summary', 'approval_notices']::text[]);

COMMENT ON COLUMN public.users.unsubscribed_categories IS
  'Per-category opt-out. Currently understood: lifecycle (founder and product-usage mail), product_update, research, activity_summary (the day-8 week-1 report), approval_notices (emails about rule forwards waiting for approval). A category listed here is suppressed even when unsubscribed_at is NULL.';

-- ------------------------------------------------------------
-- enqueue: turn waiting rule forwards into notices
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_forward_approval_notices()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_rule    record;
  v_created integer := 0;
  v_rows    integer;
BEGIN
  -- One at a time. Released at the end of this transaction.
  IF NOT pg_try_advisory_xact_lock(hashtext('enqueue_forward_approval_notices')) THEN
    RETURN 0;
  END IF;

  -- Queued: one notice per rule, once its run has finished.
  FOR v_rule IN
    SELECT a.workspace_id, a.triage_rule_id, min(a.expires_at) AS deadline
    FROM   public.send_approvals a
    JOIN   public.triage_rules r ON r.id = a.triage_rule_id
    WHERE  a.status = 'pending'
      AND  a.operation = 'email_forward'
      AND  a.expires_at > now()
      AND  a.queued_notice_at IS NULL
    GROUP  BY a.workspace_id, a.triage_rule_id, r.running_since
    HAVING (r.running_since IS NULL OR min(a.created_at) < now() - interval '15 minutes')
       AND NOT EXISTS (
             SELECT 1 FROM public.forward_approval_notices n
             WHERE  n.triage_rule_id = a.triage_rule_id
               AND  n.kind = 'queued'
               AND  n.created_at > now() - interval '1 hour'
           )
  LOOP
    INSERT INTO public.forward_approval_notices (workspace_id, triage_rule_id, kind, deadline)
    VALUES (v_rule.workspace_id, v_rule.triage_rule_id, 'queued', v_rule.deadline);
    UPDATE public.send_approvals
    SET    queued_notice_at = now()
    WHERE  triage_rule_id = v_rule.triage_rule_id
      AND  status = 'pending'
      AND  queued_notice_at IS NULL;
    v_created := v_created + 1;
  END LOOP;

  -- Reminder: a rule forward came within 24 hours of its own expires_at. A
  -- forward that only ever lives about a day is left out: the first email
  -- already gave that deadline. The window takes in everything expiring in the
  -- next 48 hours, so a rule that forwards steadily gets one reminder a day,
  -- not one for each message.
  FOR v_rule IN
    SELECT a.workspace_id, a.triage_rule_id, min(a.expires_at) AS deadline
    FROM   public.send_approvals a
    WHERE  a.status = 'pending'
      AND  a.operation = 'email_forward'
      AND  a.triage_rule_id IS NOT NULL
      AND  a.reminder_notice_at IS NULL
      AND  a.expires_at > now()
      AND  a.expires_at <= now() + interval '24 hours'
      AND  a.expires_at - a.created_at > interval '25 hours'
    GROUP  BY a.workspace_id, a.triage_rule_id
  LOOP
    INSERT INTO public.forward_approval_notices (workspace_id, triage_rule_id, kind, deadline)
    VALUES (v_rule.workspace_id, v_rule.triage_rule_id, 'reminder', v_rule.deadline)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    UPDATE public.send_approvals
    SET    reminder_notice_at = now()
    WHERE  triage_rule_id = v_rule.triage_rule_id
      AND  status = 'pending'
      AND  reminder_notice_at IS NULL
      AND  expires_at <= now() + interval '48 hours';
    v_created := v_created + v_rows;
  END LOOP;

  -- The ledger is only worth keeping while someone might ask about it.
  DELETE FROM public.forward_approval_notices
  WHERE  created_at < now() - interval '90 days';

  RETURN v_created;
END;
$fn$;

-- ------------------------------------------------------------
-- claim: hand due notices to one dispatcher
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_forward_approval_notices(p_limit integer DEFAULT 25)
RETURNS SETOF public.forward_approval_notices
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $fn$
  UPDATE public.forward_approval_notices n
  SET    status = 'sending', claimed_at = now(), attempts = n.attempts + 1
  WHERE  n.id IN (
    SELECT c.id
    FROM   public.forward_approval_notices c
    WHERE  c.attempts < 5
      AND  (c.status = 'pending'
            OR (c.status = 'sending' AND c.claimed_at < now() - interval '15 minutes'))
    ORDER  BY c.created_at
    LIMIT  greatest(1, least(coalesce(p_limit, 25), 100))
    FOR UPDATE SKIP LOCKED
  )
  RETURNING n.*;
$fn$;

-- ------------------------------------------------------------
-- dispatch: the pg_cron entry point
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_forward_approval_notices()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  v_url    text := public._app_base_url() || '/api/internal/forward-notices/dispatch';
  v_secret text;
BEGIN
  BEGIN
    PERFORM public.enqueue_forward_approval_notices();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'dispatch_forward_approval_notices: enqueue failed: %', SQLERRM;
  END;

  -- Nothing to send: no HTTP request. This is the WHERE clause of
  -- claim_forward_approval_notices(). Keep the two in step.
  IF NOT EXISTS (
    SELECT 1
    FROM   public.forward_approval_notices c
    WHERE  c.attempts < 5
      AND  (c.status = 'pending'
            OR (c.status = 'sending' AND c.claimed_at < now() - interval '15 minutes'))
  ) THEN
    RETURN;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO v_secret
    FROM   vault.decrypted_secrets
    WHERE  name = 'dispatch_secret'
    LIMIT  1;
  EXCEPTION WHEN OTHERS THEN
    v_secret := NULL;
  END;

  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'dispatch_forward_approval_notices: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_forward_approval_notices: Vault secret "app_base_url" is not set, skipping.';
    RETURN;
  END IF;

  -- Fire and forget, empty body: the route claims its own work.
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

REVOKE ALL ON FUNCTION public.enqueue_forward_approval_notices() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_forward_approval_notices(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dispatch_forward_approval_notices() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_forward_approval_notices() TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_forward_approval_notices(integer) TO service_role;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-forward-approval-notices') THEN
    PERFORM cron.unschedule('dispatch-forward-approval-notices');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'dispatch-forward-approval-notices',
  '* * * * *',
  $$SELECT public.dispatch_forward_approval_notices()$$
);
