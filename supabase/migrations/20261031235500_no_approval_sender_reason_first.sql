-- ============================================================
-- MCPEmails - a sender warning is never hidden by another reason
-- 20261031235500_no_approval_sender_reason_first
-- ============================================================
--
-- Found on staging: a mail that failed DKIM, covered by a no-approval rule at its
-- daily limit, waited with `daily_limit`. It showed no warning and "Approve all"
-- took it. The sender reasons now come before every other reason for an address a
-- rule would cover. Nothing about what is covered changes: this only picks which
-- reason a waiting forward gives.

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

    IF p_sender_verdict = 'unverified' AND v_candidate.verified_senders_only THEN
      v_unverified := true;
      CONTINUE;
    END IF;

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
    -- A person has to see these whatever else is in the way, so they come first: a
    -- failed sender over the daily limit must not read as only over the limit, and
    -- then be approved in bulk.
    ELSIF p_sender_verdict = 'failed' THEN v_reason := 'sender_failed';
    ELSIF p_sender_verdict = 'unreadable' OR v_unverified THEN v_reason := 'sender_unverified';
    ELSIF NOT (v_recipients <@ v_reachable) THEN v_reason := 'coverage_off';
    ELSIF v_voided THEN v_reason := 'coverage_voided';
    ELSIF v_paused THEN v_reason := 'coverage_paused';
    ELSIF v_past THEN v_reason := 'past_mail';
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
