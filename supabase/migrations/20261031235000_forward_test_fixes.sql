-- ============================================================
-- MCPEmails - forwards: what real testing found
-- 20261031235000_forward_test_fixes
-- ============================================================
--
-- 1. Receipts get their own opt-out. They shared `approval_notices` with the emails
--    saying forwards wait and fail, so stopping receipts silently stopped those too
--    and forwards expired unseen.
-- 2. A `failed` notice: an approved or unattended rule forward ended in error. Nobody
--    was told unless three unattended ones failed in a row. At most one per rule per
--    hour, read from the same tables, by the same pg_cron job, so nothing here can
--    stop a run or a send.
-- 3. no_approval_evaluate says why a forward waits when no-approval rules are paused
--    or switched off, and only when it would otherwise have been covered. Before, a
--    pause gave every forward that reason, and a rule switched off gave none.
--
-- These columns do not bump `revision` (see send_approvals_bump_revision) and grant
-- nothing: no gate reads them.

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_unsubscribed_categories_known;
ALTER TABLE public.users
  ADD CONSTRAINT users_unsubscribed_categories_known
  CHECK (unsubscribed_categories <@ ARRAY['lifecycle', 'product_update', 'research', 'activity_summary', 'approval_notices', 'approval_receipts']::text[]);

COMMENT ON COLUMN public.users.unsubscribed_categories IS
  'Per-category opt-out. Currently understood: lifecycle (founder and product-usage mail), product_update, research, activity_summary (the day-8 week-1 report), approval_notices (emails saying rule forwards are waiting, about to expire, have failed, or that a no-approval rule was paused), approval_receipts (receipts for forwards a no-approval rule sent). A category listed here is suppressed even when unsubscribed_at is NULL.';

ALTER TABLE public.send_approvals
  ADD COLUMN IF NOT EXISTS failed_notice_at timestamptz,
  ADD COLUMN IF NOT EXISTS failed_notice_id uuid;

COMMENT ON COLUMN public.send_approvals.failed_notice_at IS
  'When a "forward failed" notice claimed this row. NULL means no notice covers it yet. Set once.';
COMMENT ON COLUMN public.send_approvals.failed_notice_id IS
  'The notice that counted this failed forward. NULL on rows stamped when this landed.';

-- Failures from before this landed were never promised an email. No burst of them.
UPDATE public.send_approvals a
SET    failed_notice_at = now()
FROM   public.scheduled_sends s
WHERE  s.status = 'error'
  AND  s.payload_encrypted = false
  AND  s.workspace_id = a.workspace_id
  AND  s.payload->>'approval_id' = a.id::text
  AND  a.status = 'approved'
  AND  a.operation = 'email_forward'
  AND  a.failed_notice_at IS NULL;

-- What the once-a-minute enqueue reads: failures of the last days, nothing else.
CREATE INDEX IF NOT EXISTS scheduled_sends_recent_error_idx
  ON public.scheduled_sends (updated_at)
  WHERE status = 'error' AND payload_encrypted = false;

ALTER TABLE public.forward_approval_notices DROP CONSTRAINT IF EXISTS forward_approval_notices_kind_check;
ALTER TABLE public.forward_approval_notices ADD CONSTRAINT forward_approval_notices_kind_check
  CHECK (kind IN ('queued', 'reminder', 'receipt', 'coverage_paused', 'failed'));

COMMENT ON COLUMN public.send_approvals.no_approval_wait_reason IS
  'A short code: why a forward that a no-approval rule would otherwise cover waits for a person. Shown on the row. sender_failed and sender_unverified also keep it out of "Approve all".';

CREATE OR REPLACE FUNCTION public.no_approval_evaluate(
  p_triage_rule_id uuid,
  p_recipients     text[],
  p_sender_verdict text DEFAULT NULL,
  p_message_date   timestamptz DEFAULT NULL,
  p_check_limit    boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_rule       record;
  v_candidate  record;
  v_recipients text[];
  v_to         text[];
  v_remaining  text[];
  v_reachable  text[] := '{}';
  v_chosen     uuid[] := '{}';
  v_primary    record;
  v_has_primary boolean := false;
  v_voided     boolean := false;
  v_over       boolean := false;
  v_unverified boolean := false;
  v_past       boolean := false;
  v_paused     boolean := false;
  v_paused_all boolean;
  v_off        text[];
  v_used       integer;
  v_reason     text;
BEGIN
  SELECT id, workspace_id, inbox_id, api_key_id, filter, action, deleted_at
    INTO v_rule
    FROM public.triage_rules
   WHERE id = p_triage_rule_id;
  IF NOT FOUND OR v_rule.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('covered', false, 'reason', 'rule_gone');
  END IF;

  SELECT coalesce(array_agg(DISTINCT lower(btrim(r))), '{}') INTO v_recipients
    FROM unnest(p_recipients) AS r WHERE r IS NOT NULL AND btrim(r) <> '';
  IF cardinality(v_recipients) = 0 THEN
    RETURN jsonb_build_object('covered', false, 'reason', NULL);
  END IF;

  IF v_rule.action->>'type' IS DISTINCT FROM 'forward' THEN
    RETURN jsonb_build_object('covered', false, 'reason', NULL);
  END IF;
  IF jsonb_typeof(v_rule.action->'to') = 'array' THEN
    SELECT coalesce(array_agg(lower(btrim(value))), '{}') INTO v_to
      FROM jsonb_array_elements_text(v_rule.action->'to');
  ELSE
    v_to := '{}';
  END IF;
  IF NOT (v_recipients <@ v_to) THEN
    RETURN jsonb_build_object('covered', false, 'reason', 'recipients_changed');
  END IF;

  -- Pause all stops everything, but it only explains a wait for a forward that
  -- would otherwise have gone: checked at the very end, below.
  v_paused_all := EXISTS (SELECT 1 FROM public.no_approval_workspace_state s
                          WHERE s.workspace_id = v_rule.workspace_id AND s.paused_at IS NOT NULL);

  v_remaining := v_recipients;
  FOR v_candidate IN
    SELECT r.*
      FROM public.no_approval_rules r
     WHERE r.workspace_id = v_rule.workspace_id
       AND r.enabled
       AND (r.inbox_ids IS NULL OR v_rule.inbox_id = ANY (r.inbox_ids))
       AND r.recipients && v_recipients
     ORDER BY r.created_at, r.id
  LOOP
    IF v_candidate.scope = 'chosen_automations' THEN
      -- Not on the list: this rule says nothing about this automation.
      CONTINUE WHEN NOT EXISTS (
        SELECT 1 FROM public.no_approval_rule_automations a
         WHERE a.no_approval_rule_id = v_candidate.id AND a.triage_rule_id = v_rule.id
      );
    END IF;
    v_reachable := v_reachable || v_candidate.recipients;

    IF v_candidate.scope = 'chosen_automations' AND NOT EXISTS (
      SELECT 1 FROM public.no_approval_rule_automations a
       WHERE a.no_approval_rule_id = v_candidate.id
         AND a.triage_rule_id = v_rule.id
         AND a.fingerprint = public.triage_rule_fingerprint(v_rule.filter, v_rule.action, v_rule.inbox_id, v_rule.api_key_id)
    ) THEN
      v_voided := true;
      CONTINUE;
    END IF;
    IF v_candidate.paused_at IS NOT NULL THEN
      v_paused := true;
      CONTINUE;
    END IF;
    IF p_message_date IS NOT NULL AND (v_candidate.enabled_at IS NULL OR p_message_date < v_candidate.enabled_at) THEN
      v_past := true;
      CONTINUE;
    END IF;
    IF p_sender_verdict = 'unverified' AND v_candidate.verified_senders_only THEN
      v_unverified := true;
      CONTINUE;
    END IF;
    IF p_check_limit THEN
      SELECT u.used INTO v_used
        FROM public.no_approval_usage u
       WHERE u.no_approval_rule_id = v_candidate.id
         AND u.day = (now() AT TIME ZONE v_candidate.time_zone)::date;
      IF coalesce(v_used, 0) >= v_candidate.daily_limit THEN
        v_over := true;
        CONTINUE;
      END IF;
    END IF;

    -- Greedy: the oldest rule that still adds an address. A rule adding nothing
    -- is not counted against.
    IF v_remaining && v_candidate.recipients THEN
      v_chosen := v_chosen || v_candidate.id;
      v_remaining := ARRAY(SELECT unnest(v_remaining) EXCEPT SELECT unnest(v_candidate.recipients));
      IF NOT v_has_primary THEN
        v_primary := v_candidate;
        v_has_primary := true;
      END IF;
    END IF;
  END LOOP;

  IF cardinality(v_remaining) > 0 THEN
    -- What a rule that is switched off would add. It covers nothing; it only says
    -- why this forward waits.
    SELECT coalesce(array_agg(DISTINCT x.address), '{}') INTO v_off
      FROM public.no_approval_rules r, unnest(r.recipients) AS x(address)
     WHERE r.workspace_id = v_rule.workspace_id
       AND NOT r.enabled
       AND (r.inbox_ids IS NULL OR v_rule.inbox_id = ANY (r.inbox_ids))
       AND (r.scope = 'all_automations' OR EXISTS (
             SELECT 1 FROM public.no_approval_rule_automations a
              WHERE a.no_approval_rule_id = r.id AND a.triage_rule_id = v_rule.id));
    IF NOT (v_recipients <@ (v_reachable || v_off)) THEN
      -- Nothing to say about an address nobody trusted, unless another was trusted.
      v_reason := CASE WHEN v_recipients && (v_reachable || v_off) THEN 'address_not_covered' END;
    ELSIF NOT (v_recipients <@ v_reachable) THEN v_reason := 'coverage_off';
    ELSIF v_voided THEN v_reason := 'coverage_voided';
    ELSIF v_paused THEN v_reason := 'coverage_paused';
    ELSIF v_past THEN v_reason := 'past_mail';
    ELSIF v_unverified THEN v_reason := 'sender_unverified';
    ELSIF v_over THEN v_reason := 'daily_limit';
    END IF;
    RETURN jsonb_build_object('covered', false, 'reason', v_reason);
  END IF;

  -- Fails whatever the setting. A verdict that could not be read fails closed.
  IF p_sender_verdict = 'failed' THEN
    RETURN jsonb_build_object('covered', false, 'reason', 'sender_failed');
  END IF;
  IF p_sender_verdict = 'unreadable' THEN
    RETURN jsonb_build_object('covered', false, 'reason', 'sender_unverified');
  END IF;

  -- Covered in every way but this. After the sender checks, so a mail that failed
  -- them says so, and stays out of "Approve all", whatever the pause says.
  IF v_paused_all THEN
    RETURN jsonb_build_object('covered', false, 'reason', 'paused_all');
  END IF;

  RETURN jsonb_build_object(
    'covered', true,
    'reason', NULL,
    'rule_ids', to_jsonb(v_chosen),
    'primary_rule_id', v_primary.id,
    'primary_rule_name', v_primary.name
  );
END;
$fn$;

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
  v_notice  uuid;
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

  -- Receipt: forwards a no-approval rule sent. At most one per automation per
  -- run, and per hour however busy it is. Only what has really been sent counts.
  FOR v_rule IN
    SELECT a.workspace_id, a.triage_rule_id
    FROM   public.send_approvals a
    JOIN   public.triage_rules r ON r.id = a.triage_rule_id
    JOIN   public.scheduled_sends s ON s.id = a.dispatch_scheduled_send_id
    WHERE  a.status = 'approved'
      AND  a.decided_via = 'no_approval_rule'
      AND  a.receipt_notice_id IS NULL
      AND  s.status = 'sent'
    GROUP  BY a.workspace_id, a.triage_rule_id, r.running_since
    HAVING r.running_since IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM public.forward_approval_notices n
             WHERE  n.triage_rule_id = a.triage_rule_id
               AND  n.kind = 'receipt'
               AND  n.created_at > now() - interval '1 hour'
           )
  LOOP
    INSERT INTO public.forward_approval_notices (workspace_id, triage_rule_id, kind, deadline)
    VALUES (v_rule.workspace_id, v_rule.triage_rule_id, 'receipt', now())
    RETURNING id INTO v_notice;
    UPDATE public.send_approvals a
    SET    receipt_notice_id = v_notice
    FROM   public.scheduled_sends s
    WHERE  a.triage_rule_id = v_rule.triage_rule_id
      AND  a.status = 'approved'
      AND  a.decided_via = 'no_approval_rule'
      AND  a.receipt_notice_id IS NULL
      AND  s.id = a.dispatch_scheduled_send_id
      AND  s.status = 'sent';
    v_created := v_created + 1;
  END LOOP;

  -- Failed: an approved or unattended rule forward ended in error. At most one per
  -- rule per hour; a failure inside the hour keeps its NULL and the next notice takes it.
  FOR v_rule IN
    SELECT a.workspace_id, a.triage_rule_id
    FROM   public.scheduled_sends s
    JOIN   public.send_approvals a
      ON   a.id = CASE WHEN s.payload->>'approval_id' ~ '^[0-9a-fA-F-]{36}$'
                       THEN (s.payload->>'approval_id')::uuid END
     AND   a.workspace_id = s.workspace_id
    WHERE  s.status = 'error'
      AND  s.payload_encrypted = false
      AND  s.updated_at > now() - interval '8 days'
      AND  a.status = 'approved'
      AND  a.operation = 'email_forward'
      AND  a.triage_rule_id IS NOT NULL
      AND  a.failed_notice_at IS NULL
    GROUP  BY a.workspace_id, a.triage_rule_id
    HAVING NOT EXISTS (
             SELECT 1 FROM public.forward_approval_notices n
             WHERE  n.triage_rule_id = a.triage_rule_id
               AND  n.kind = 'failed'
               AND  n.created_at > now() - interval '1 hour'
           )
  LOOP
    INSERT INTO public.forward_approval_notices (workspace_id, triage_rule_id, kind, deadline)
    VALUES (v_rule.workspace_id, v_rule.triage_rule_id, 'failed', now())
    RETURNING id INTO v_notice;
    UPDATE public.send_approvals a
    SET    failed_notice_at = now(), failed_notice_id = v_notice
    FROM   public.scheduled_sends s
    WHERE  a.triage_rule_id = v_rule.triage_rule_id
      AND  a.status = 'approved'
      AND  a.operation = 'email_forward'
      AND  a.failed_notice_at IS NULL
      AND  s.workspace_id = a.workspace_id
      AND  s.status = 'error'
      AND  s.payload_encrypted = false
      AND  s.updated_at > now() - interval '8 days'
      AND  s.payload->>'approval_id' = a.id::text;
    v_created := v_created + 1;
  END LOOP;

  -- The ledger is only worth keeping while someone might ask about it.
  DELETE FROM public.forward_approval_notices
  WHERE  created_at < now() - interval '90 days';
  DELETE FROM public.no_approval_usage
  WHERE  day < (now() - interval '8 days')::date;

  RETURN v_created;
END;
$fn$;

REVOKE ALL ON FUNCTION public.enqueue_forward_approval_notices() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_forward_approval_notices() TO service_role;
