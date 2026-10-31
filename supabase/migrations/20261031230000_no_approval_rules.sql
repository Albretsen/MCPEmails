-- ============================================================
-- MCPEmails - no-approval rules: forwards to trusted addresses without a click
-- 20261031230000_no_approval_rules
-- ============================================================
--
-- A person (owner or admin, signed in to the dashboard) says: forwards to these
-- exact addresses may go out without waiting for approval. Everything else keeps
-- waiting. Approval stays the default.
--
-- WHO CAN WRITE. Nobody but the four no_approval_* functions below that check
-- auth.uid() against workspace_members. Those are granted to `authenticated` only
-- and refused to service_role, and the tables grant no write to anyone, service
-- role included. So the mcp-server, whose database role is service_role, cannot
-- create, widen or switch on a rule even if a bug tried to. An API key has no
-- auth.uid() at all.
--
-- HOW A FORWARD USES IT. The runner still writes the ordinary send_approvals row.
-- no_approval_auto_decide() then decides it in one transaction, with `decided_via`
-- = 'no_approval_rule', and writes the ordinary scheduled_sends marker. From there
-- it is the same dispatcher, delivery status, double-send guard and retention as a
-- person's approval. It reads the addresses a rule covers and the rule's own `to`
-- from the database at that moment.
--
-- CHOSEN AUTOMATIONS. A person confirms an automation as it stands: the fingerprint
-- of its filter, action, inbox and key. Any write through any path changes the
-- fingerprint, and coverage stops until a person confirms again. A rule for "all
-- automations" trusts the address alone and does not void on a filter change.
--
-- THE DAILY LIMIT is counted per no-approval rule per local day. The decide
-- function locks the workspace's rule rows, so concurrent runs queue up.

-- ------------------------------------------------------------
-- Validation helper
-- ------------------------------------------------------------
-- An exact address and nothing else: no wildcard, no bare domain, no display name.
CREATE OR REPLACE FUNCTION public.no_approval_recipients_valid(p_recipients text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $fn$
  SELECT cardinality(p_recipients) BETWEEN 1 AND 20
     AND NOT EXISTS (
       SELECT 1 FROM unnest(p_recipients) AS r(address)
       WHERE address IS NULL
          OR char_length(address) > 254
          OR address <> lower(btrim(address))
          OR address !~ '^[a-z0-9.!#$&''+^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$'
     );
$fn$;

-- ------------------------------------------------------------
-- Tables
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.no_approval_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  recipients   text[] NOT NULL CHECK (public.no_approval_recipients_valid(recipients)),
  scope        text NOT NULL DEFAULT 'all_automations'
               CHECK (scope IN ('all_automations', 'chosen_automations')),
  -- NULL: every inbox in the workspace.
  inbox_ids    uuid[],
  daily_limit  integer NOT NULL DEFAULT 25 CHECK (daily_limit BETWEEN 1 AND 100),
  -- The zone "today" is counted in, taken from the browser of the person saving.
  -- Workspaces have no zone of their own.
  time_zone    text NOT NULL DEFAULT 'UTC' CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  verified_senders_only boolean NOT NULL DEFAULT true,
  enabled      boolean NOT NULL DEFAULT false,
  -- Mail dated before this keeps waiting: turning a rule on never sends old mail.
  enabled_at   timestamptz,
  -- Set when repeated send failures stop this rule. A person resumes it.
  paused_at    timestamptz,
  paused_reason text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS no_approval_rules_workspace_idx
  ON public.no_approval_rules (workspace_id, created_at);

COMMENT ON TABLE public.no_approval_rules IS
  'Addresses an owner or admin trusts to receive rule forwards without approval. '
  'Written only through the auth.uid() gated no_approval_rule_* functions.';

-- The automations a person confirmed for a chosen-automations rule, as they stood.
CREATE TABLE IF NOT EXISTS public.no_approval_rule_automations (
  no_approval_rule_id uuid NOT NULL REFERENCES public.no_approval_rules(id) ON DELETE CASCADE,
  triage_rule_id      uuid NOT NULL REFERENCES public.triage_rules(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  fingerprint         text NOT NULL,
  confirmed_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  confirmed_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (no_approval_rule_id, triage_rule_id)
);

CREATE INDEX IF NOT EXISTS no_approval_rule_automations_rule_idx
  ON public.no_approval_rule_automations (triage_rule_id);
CREATE INDEX IF NOT EXISTS no_approval_rule_automations_workspace_idx
  ON public.no_approval_rule_automations (workspace_id);

-- Forwards decided per rule per local day. Kept a week.
CREATE TABLE IF NOT EXISTS public.no_approval_usage (
  no_approval_rule_id uuid NOT NULL REFERENCES public.no_approval_rules(id) ON DELETE CASCADE,
  day                 date NOT NULL,
  used                integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (no_approval_rule_id, day)
);

-- The page's "Pause all". A row exists only once somebody has used it.
CREATE TABLE IF NOT EXISTS public.no_approval_workspace_state (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  paused_at    timestamptz,
  paused_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.no_approval_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.no_approval_rule_automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.no_approval_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.no_approval_workspace_state ENABLE ROW LEVEL SECURITY;

-- Members may read what governs their mail. There is no write policy for anyone.
DROP POLICY IF EXISTS no_approval_rules_select_members ON public.no_approval_rules;
CREATE POLICY no_approval_rules_select_members ON public.no_approval_rules FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.workspace_members wm
                 WHERE wm.workspace_id = no_approval_rules.workspace_id AND wm.user_id = auth.uid()));
DROP POLICY IF EXISTS no_approval_rule_automations_select_members ON public.no_approval_rule_automations;
CREATE POLICY no_approval_rule_automations_select_members ON public.no_approval_rule_automations FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.workspace_members wm
                 WHERE wm.workspace_id = no_approval_rule_automations.workspace_id AND wm.user_id = auth.uid()));
DROP POLICY IF EXISTS no_approval_workspace_state_select_members ON public.no_approval_workspace_state;
CREATE POLICY no_approval_workspace_state_select_members ON public.no_approval_workspace_state FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.workspace_members wm
                 WHERE wm.workspace_id = no_approval_workspace_state.workspace_id AND wm.user_id = auth.uid()));

-- The revoke from service_role is the point: bypassing RLS does not help a role
-- that holds no table privilege, so the mcp-server cannot write these.
REVOKE ALL ON TABLE public.no_approval_rules, public.no_approval_rule_automations,
                    public.no_approval_usage, public.no_approval_workspace_state
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.no_approval_rules, public.no_approval_rule_automations,
                      public.no_approval_workspace_state
  TO authenticated, service_role;
-- What every public table keeps for the service role (api_roles_no_truncate.sql).
-- None of it can add or widen a row: emptying the table only makes forwards wait.
GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.no_approval_rules, public.no_approval_rule_automations,
                                               public.no_approval_usage, public.no_approval_workspace_state
  TO service_role;

-- ------------------------------------------------------------
-- send_approvals: which rule decided a row, and why one still waits
-- ------------------------------------------------------------
ALTER TABLE public.send_approvals
  ADD COLUMN IF NOT EXISTS no_approval_rule_id uuid REFERENCES public.no_approval_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS no_approval_rule_name text,
  ADD COLUMN IF NOT EXISTS no_approval_usage jsonb,
  ADD COLUMN IF NOT EXISTS no_approval_wait_reason text,
  ADD COLUMN IF NOT EXISTS receipt_notice_id uuid;

COMMENT ON COLUMN public.send_approvals.no_approval_rule_name IS
  'The no-approval rule that sent this row without a person, as it was named then.';
COMMENT ON COLUMN public.send_approvals.no_approval_usage IS
  'Which rule and local day each daily-limit count went to, so a row returned to waiting can give them back.';
COMMENT ON COLUMN public.send_approvals.no_approval_wait_reason IS
  'A short code: why a covered forward waits for a person after all. Shown on the row.';
COMMENT ON COLUMN public.send_approvals.receipt_notice_id IS
  'The receipt email that counted this row. Set once.';

CREATE INDEX IF NOT EXISTS send_approvals_no_approval_rule_idx
  ON public.send_approvals (no_approval_rule_id) WHERE no_approval_rule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS send_approvals_receipt_due_idx
  ON public.send_approvals (triage_rule_id)
  WHERE decided_via = 'no_approval_rule' AND receipt_notice_id IS NULL;

ALTER TABLE public.send_approvals DROP CONSTRAINT IF EXISTS send_approvals_decided_via_check;
ALTER TABLE public.send_approvals ADD CONSTRAINT send_approvals_decided_via_check
  CHECK (decided_via IS NULL OR decided_via IN ('dashboard', 'review_page', 'mcp_app', 'no_approval_rule'));

-- A row sent by a rule is decided by no person: the two columns can not both be set.
ALTER TABLE public.send_approvals DROP CONSTRAINT IF EXISTS send_approvals_no_approval_no_person;
ALTER TABLE public.send_approvals ADD CONSTRAINT send_approvals_no_approval_no_person
  CHECK (decided_via IS DISTINCT FROM 'no_approval_rule' OR decided_by IS NULL);

-- ------------------------------------------------------------
-- The fingerprint a person confirms
-- ------------------------------------------------------------
-- jsonb's text form sorts keys, so the same content always reads the same.
CREATE OR REPLACE FUNCTION public.triage_rule_fingerprint(
  p_filter jsonb, p_action jsonb, p_inbox_id uuid, p_api_key_id uuid
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $fn$
  SELECT encode(
    pg_catalog.sha256(convert_to(jsonb_build_array(p_filter, p_action, p_inbox_id, p_api_key_id)::text, 'UTF8')),
    'hex'
  );
$fn$;

-- ------------------------------------------------------------
-- The one decision: does this forward run without a person?
-- ------------------------------------------------------------
-- Reads only. Everything comes from the database except the addresses the send
-- would really go to, the sender verdict and the mail's date, which the mcp-server
-- works out at run time. A rule's `to` must contain every address, so a stale
-- approval can not go somewhere the rule no longer says.
--
-- p_sender_verdict: NULL skip the sender check | verified | unverified (no usable
-- header, or no result for the sender's domain) | failed | unreadable.
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

  IF EXISTS (SELECT 1 FROM public.no_approval_workspace_state s
             WHERE s.workspace_id = v_rule.workspace_id AND s.paused_at IS NOT NULL) THEN
    RETURN jsonb_build_object('covered', false, 'reason', 'paused_all');
  END IF;

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
    IF NOT (v_recipients <@ v_reachable) THEN
      -- Nothing to say about an address nobody trusted, unless another was trusted.
      v_reason := CASE WHEN v_recipients && v_reachable THEN 'address_not_covered' END;
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

  RETURN jsonb_build_object(
    'covered', true,
    'reason', NULL,
    'rule_ids', to_jsonb(v_chosen),
    'primary_rule_id', v_primary.id,
    'primary_rule_name', v_primary.name
  );
END;
$fn$;

-- ------------------------------------------------------------
-- The automatic decision, in one transaction
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.no_approval_auto_decide(
  p_approval_id    uuid,
  p_revision       integer,
  p_recipients     text[],
  p_sender_verdict text,
  p_message_date   timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_approval public.send_approvals%ROWTYPE;
  v_result   jsonb;
  v_rule_id  uuid;
  v_rule     public.no_approval_rules%ROWTYPE;
  v_day      date;
  v_usage    jsonb := '[]'::jsonb;
BEGIN
  IF p_sender_verdict IS NULL THEN
    RETURN jsonb_build_object('decided', false, 'reason', 'sender_unverified');
  END IF;

  SELECT * INTO v_approval FROM public.send_approvals WHERE id = p_approval_id FOR UPDATE;
  IF NOT FOUND
     OR v_approval.status <> 'pending'
     OR v_approval.operation <> 'email_forward'
     OR v_approval.triage_rule_id IS NULL
     OR v_approval.reforward_of IS NOT NULL
     OR v_approval.revision IS DISTINCT FROM p_revision
     OR (v_approval.expires_at IS NOT NULL AND v_approval.expires_at <= now()) THEN
    RETURN jsonb_build_object('decided', false, 'reason', NULL);
  END IF;

  -- Serialises the daily count for this workspace. Always the same order.
  PERFORM 1 FROM public.no_approval_rules
    WHERE workspace_id = v_approval.workspace_id ORDER BY id FOR UPDATE;

  v_result := public.no_approval_evaluate(v_approval.triage_rule_id, p_recipients, p_sender_verdict, p_message_date, true);
  IF NOT coalesce((v_result->>'covered')::boolean, false) THEN
    UPDATE public.send_approvals
       SET no_approval_wait_reason = v_result->>'reason'
     WHERE id = p_approval_id;
    RETURN jsonb_build_object('decided', false, 'reason', v_result->>'reason');
  END IF;

  FOR v_rule_id IN SELECT (value #>> '{}')::uuid FROM jsonb_array_elements(v_result->'rule_ids') LOOP
    SELECT * INTO v_rule FROM public.no_approval_rules WHERE id = v_rule_id;
    v_day := (now() AT TIME ZONE v_rule.time_zone)::date;
    INSERT INTO public.no_approval_usage (no_approval_rule_id, day, used)
    VALUES (v_rule_id, v_day, 1)
    ON CONFLICT (no_approval_rule_id, day) DO UPDATE SET used = public.no_approval_usage.used + 1;
    v_usage := v_usage || jsonb_build_object('rule_id', v_rule_id, 'day', v_day);
  END LOOP;

  UPDATE public.send_approvals
     SET status = 'approved',
         decided_at = now(),
         decided_by = NULL,
         decided_via = 'no_approval_rule',
         no_approval_rule_id = (v_result->>'primary_rule_id')::uuid,
         no_approval_rule_name = v_result->>'primary_rule_name',
         no_approval_usage = v_usage,
         no_approval_wait_reason = NULL
   WHERE id = p_approval_id;

  -- The same marker decide.ts writes. The dispatcher takes it from here.
  INSERT INTO public.scheduled_sends (workspace_id, inbox_id, payload, payload_encrypted, send_at, status)
  VALUES (
    v_approval.workspace_id,
    v_approval.inbox_id,
    jsonb_build_object('approval_id', v_approval.id),
    false,
    now(),
    'pending'
  );

  RETURN jsonb_build_object(
    'decided', true,
    'rule_id', v_result->>'primary_rule_id',
    'rule_name', v_result->>'primary_rule_name'
  );
END;
$fn$;

-- Coverage again, just before the dispatcher sends. The count is already taken.
CREATE OR REPLACE FUNCTION public.no_approval_recheck(p_approval_id uuid, p_recipients text[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_approval public.send_approvals%ROWTYPE;
BEGIN
  SELECT * INTO v_approval FROM public.send_approvals WHERE id = p_approval_id;
  IF NOT FOUND OR v_approval.triage_rule_id IS NULL THEN
    RETURN jsonb_build_object('covered', false, 'reason', 'rule_gone');
  END IF;
  RETURN public.no_approval_evaluate(v_approval.triage_rule_id, p_recipients, NULL, NULL, false);
END;
$fn$;

-- Covered no longer, or a brake or the allowance said no: it waits for a person.
CREATE OR REPLACE FUNCTION public.no_approval_return_to_waiting(
  p_approval_id uuid,
  p_scheduled_send_id uuid,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_approval public.send_approvals%ROWTYPE;
  v_entry    jsonb;
BEGIN
  SELECT * INTO v_approval FROM public.send_approvals WHERE id = p_approval_id FOR UPDATE;
  IF NOT FOUND OR v_approval.status <> 'approved' OR v_approval.decided_via IS DISTINCT FROM 'no_approval_rule' THEN
    RETURN false;
  END IF;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(coalesce(v_approval.no_approval_usage, '[]'::jsonb)) LOOP
    UPDATE public.no_approval_usage
       SET used = greatest(used - 1, 0)
     WHERE no_approval_rule_id = (v_entry->>'rule_id')::uuid
       AND day = (v_entry->>'day')::date;
  END LOOP;

  UPDATE public.send_approvals
     SET status = 'pending',
         decided_at = NULL,
         decided_by = NULL,
         decided_via = NULL,
         dispatch_scheduled_send_id = NULL,
         no_approval_rule_id = NULL,
         no_approval_rule_name = NULL,
         no_approval_usage = NULL,
         no_approval_wait_reason = left(p_reason, 60),
         queued_notice_at = NULL
   WHERE id = p_approval_id;

  UPDATE public.scheduled_sends
     SET status = 'cancelled',
         error_detail = 'back to waiting for approval: ' || left(p_reason, 60),
         updated_at = now()
   WHERE id = p_scheduled_send_id AND status IN ('pending', 'sending');

  RETURN true;
END;
$fn$;

-- Three failures in a row stop a rule's coverage and email the owners.
CREATE OR REPLACE FUNCTION public.no_approval_note_send_result(p_approval_id uuid, p_ok boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_approval public.send_approvals%ROWTYPE;
  v_entry    jsonb;
  v_rule_id  uuid;
  v_rule     public.no_approval_rules%ROWTYPE;
BEGIN
  SELECT * INTO v_approval FROM public.send_approvals WHERE id = p_approval_id;
  IF NOT FOUND OR v_approval.decided_via IS DISTINCT FROM 'no_approval_rule' THEN
    RETURN;
  END IF;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(coalesce(v_approval.no_approval_usage, '[]'::jsonb)) LOOP
    v_rule_id := (v_entry->>'rule_id')::uuid;
    IF p_ok THEN
      UPDATE public.no_approval_rules SET consecutive_failures = 0
       WHERE id = v_rule_id AND consecutive_failures <> 0;
      CONTINUE;
    END IF;
    UPDATE public.no_approval_rules
       SET consecutive_failures = consecutive_failures + 1,
           paused_at = CASE WHEN consecutive_failures + 1 >= 3 THEN coalesce(paused_at, now()) ELSE paused_at END,
           paused_reason = CASE WHEN consecutive_failures + 1 >= 3 THEN 'send_failures' ELSE paused_reason END
     WHERE id = v_rule_id
     RETURNING * INTO v_rule;
    IF FOUND AND v_rule.consecutive_failures = 3 THEN
      INSERT INTO public.forward_approval_notices (workspace_id, no_approval_rule_id, kind, deadline)
      VALUES (v_rule.workspace_id, v_rule.id, 'coverage_paused', now());
      INSERT INTO public.system_events (event_type, payload, status, processed_at)
      VALUES (
        'no_approval_rule.paused_by_failures',
        jsonb_build_object('workspace_id', v_rule.workspace_id, 'rule_id', v_rule.id),
        'sent',
        now()
      );
    END IF;
  END LOOP;
END;
$fn$;

-- ------------------------------------------------------------
-- What the dashboard and the automation tool read
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.no_approval_workspace_coverage(p_workspace_id uuid)
RETURNS TABLE (triage_rule_id uuid, runs_without_approval boolean, reason text, rule_names text[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_rule   record;
  v_to     text[];
  v_result jsonb;
BEGIN
  -- Nothing configured, so nothing to work out: the usual case, and self-host.
  IF NOT EXISTS (SELECT 1 FROM public.no_approval_rules r WHERE r.workspace_id = p_workspace_id) THEN
    RETURN;
  END IF;
  FOR v_rule IN
    SELECT t.id, t.action FROM public.triage_rules t
     WHERE t.workspace_id = p_workspace_id AND t.deleted_at IS NULL AND t.action->>'type' = 'forward'
  LOOP
    IF jsonb_typeof(v_rule.action->'to') <> 'array' THEN CONTINUE; END IF;
    SELECT coalesce(array_agg(value), '{}') INTO v_to FROM jsonb_array_elements_text(v_rule.action->'to');
    v_result := public.no_approval_evaluate(v_rule.id, v_to, NULL, NULL, false);
    triage_rule_id := v_rule.id;
    runs_without_approval := coalesce((v_result->>'covered')::boolean, false);
    reason := v_result->>'reason';
    rule_names := CASE WHEN runs_without_approval THEN ARRAY(
      SELECT r.name FROM public.no_approval_rules r
       WHERE r.id IN (SELECT (value #>> '{}')::uuid FROM jsonb_array_elements(v_result->'rule_ids'))
       ORDER BY r.created_at, r.id
    ) ELSE '{}'::text[] END;
    RETURN NEXT;
  END LOOP;
END;
$fn$;

-- The rules page, in one read: each rule, its count today, its chosen automations.
CREATE OR REPLACE FUNCTION public.no_approval_rules_overview(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT jsonb_build_object(
    'paused_all', EXISTS (SELECT 1 FROM public.no_approval_workspace_state s
                          WHERE s.workspace_id = p_workspace_id AND s.paused_at IS NOT NULL),
    'rules', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id,
        'name', r.name,
        'recipients', to_jsonb(r.recipients),
        'scope', r.scope,
        'inbox_ids', to_jsonb(r.inbox_ids),
        'daily_limit', r.daily_limit,
        'time_zone', r.time_zone,
        'verified_senders_only', r.verified_senders_only,
        'enabled', r.enabled,
        'paused_at', r.paused_at,
        'paused_reason', r.paused_reason,
        'used_today', coalesce((SELECT u.used FROM public.no_approval_usage u
                                 WHERE u.no_approval_rule_id = r.id
                                   AND u.day = (now() AT TIME ZONE r.time_zone)::date), 0),
        'automations', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'id', t.id,
            'name', t.name,
            'voided', a.fingerprint IS DISTINCT FROM public.triage_rule_fingerprint(t.filter, t.action, t.inbox_id, t.api_key_id)
          ) ORDER BY t.name, t.id)
            FROM public.no_approval_rule_automations a
            JOIN public.triage_rules t ON t.id = a.triage_rule_id AND t.deleted_at IS NULL
           WHERE a.no_approval_rule_id = r.id
        ), '[]'::jsonb)
      ) ORDER BY r.created_at, r.id)
      FROM public.no_approval_rules r
      WHERE r.workspace_id = p_workspace_id
    ), '[]'::jsonb)
  );
$fn$;

-- ------------------------------------------------------------
-- The only write path: a signed-in owner or admin
-- ------------------------------------------------------------
-- Raises 42501 for anyone else. auth.uid() is NULL for the service role and for
-- every API key, so this also refuses the mcp-server.
CREATE OR REPLACE FUNCTION public.no_approval_require_manager(p_workspace_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.workspace_members m
     WHERE m.workspace_id = p_workspace_id AND m.user_id = v_uid AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'no_approval_forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN v_uid;
END;
$fn$;

-- Who, when, what changed. system_events never holds an address (its own rule), so
-- addresses appear as a count and SHA-256 digests.
CREATE OR REPLACE FUNCTION public.no_approval_log(
  p_event text, p_workspace_id uuid, p_rule_id uuid, p_user_id uuid, p_changes jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $fn$
  INSERT INTO public.system_events (event_type, payload, status, processed_at)
  VALUES (
    p_event,
    jsonb_build_object(
      'workspace_id', p_workspace_id,
      'rule_id', p_rule_id,
      'user_id', p_user_id,
      'at', now(),
      'changes', coalesce(p_changes, '{}'::jsonb)
    ),
    'sent',
    now()
  );
$fn$;

CREATE OR REPLACE FUNCTION public.no_approval_address_digests(p_recipients text[])
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $fn$
  SELECT coalesce(jsonb_agg(encode(pg_catalog.sha256(convert_to(r, 'UTF8')), 'hex') ORDER BY r), '[]'::jsonb)
    FROM unnest(p_recipients) AS r;
$fn$;

CREATE OR REPLACE FUNCTION public.no_approval_rule_save(
  p_workspace_id uuid,
  p_rule_id      uuid,
  p_name         text,
  p_recipients   text[],
  p_scope        text,
  p_automation_ids uuid[],
  p_inbox_ids    uuid[],
  p_daily_limit  integer,
  p_time_zone    text,
  p_verified_senders_only boolean,
  p_enabled      boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid      uuid := public.no_approval_require_manager(p_workspace_id);
  v_before   public.no_approval_rules%ROWTYPE;
  v_id       uuid := p_rule_id;
  v_recipients text[];
  v_changes  jsonb := '{}'::jsonb;
  v_enabled_at timestamptz;
  v_added    boolean;
BEGIN
  SELECT coalesce(array_agg(DISTINCT lower(btrim(r))), '{}') INTO v_recipients FROM unnest(p_recipients) AS r;
  IF NOT public.no_approval_recipients_valid(v_recipients) THEN
    RAISE EXCEPTION 'no_approval_invalid_recipients' USING ERRCODE = '22023';
  END IF;
  IF p_scope NOT IN ('all_automations', 'chosen_automations') THEN
    RAISE EXCEPTION 'no_approval_invalid_scope' USING ERRCODE = '22023';
  END IF;
  IF p_scope = 'chosen_automations' AND coalesce(cardinality(p_automation_ids), 0) = 0 THEN
    RAISE EXCEPTION 'no_approval_automations_required' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_daily_limit, 0) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'no_approval_invalid_limit' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name = p_time_zone) THEN
    RAISE EXCEPTION 'no_approval_invalid_time_zone' USING ERRCODE = '22023';
  END IF;
  IF p_scope = 'chosen_automations' AND EXISTS (
    SELECT 1 FROM unnest(p_automation_ids) AS wanted(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.triage_rules t
        WHERE t.id = wanted.id AND t.workspace_id = p_workspace_id
          AND t.deleted_at IS NULL AND t.action->>'type' = 'forward'
     )
  ) THEN
    RAISE EXCEPTION 'no_approval_invalid_automation' USING ERRCODE = '22023';
  END IF;
  IF p_inbox_ids IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(p_inbox_ids) AS wanted(id)
     WHERE NOT EXISTS (SELECT 1 FROM public.inboxes i WHERE i.id = wanted.id AND i.workspace_id = p_workspace_id)
  ) THEN
    RAISE EXCEPTION 'no_approval_invalid_inbox' USING ERRCODE = '22023';
  END IF;

  IF p_rule_id IS NULL THEN
    INSERT INTO public.no_approval_rules (
      workspace_id, name, recipients, scope, inbox_ids, daily_limit, time_zone,
      verified_senders_only, enabled, enabled_at, created_by, updated_by
    ) VALUES (
      p_workspace_id, btrim(p_name), v_recipients, p_scope, p_inbox_ids, p_daily_limit, p_time_zone,
      p_verified_senders_only, p_enabled, CASE WHEN p_enabled THEN now() END, v_uid, v_uid
    ) RETURNING id INTO v_id;
    v_changes := jsonb_build_object(
      'recipient_count', cardinality(v_recipients),
      'recipient_digests', public.no_approval_address_digests(v_recipients),
      'scope', p_scope,
      'daily_limit', p_daily_limit,
      'verified_senders_only', p_verified_senders_only,
      'enabled', p_enabled
    );
    PERFORM public.no_approval_log('no_approval_rule.created', p_workspace_id, v_id, v_uid, v_changes);
  ELSE
    SELECT * INTO v_before FROM public.no_approval_rules
     WHERE id = p_rule_id AND workspace_id = p_workspace_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no_approval_not_found' USING ERRCODE = 'P0002';
    END IF;
    v_added := NOT (v_recipients <@ v_before.recipients);
    -- Turning on, or trusting a new address: mail already there keeps waiting.
    v_enabled_at := CASE
      WHEN NOT p_enabled THEN v_before.enabled_at
      WHEN NOT v_before.enabled OR v_added THEN now()
      ELSE v_before.enabled_at
    END;
    IF v_before.name <> btrim(p_name) THEN v_changes := v_changes || jsonb_build_object('name', true); END IF;
    IF v_before.recipients IS DISTINCT FROM v_recipients THEN
      v_changes := v_changes || jsonb_build_object(
        'recipient_count', cardinality(v_recipients),
        'recipient_digests', public.no_approval_address_digests(v_recipients)
      );
    END IF;
    IF v_before.scope <> p_scope THEN v_changes := v_changes || jsonb_build_object('scope', p_scope); END IF;
    IF v_before.inbox_ids IS DISTINCT FROM p_inbox_ids THEN v_changes := v_changes || jsonb_build_object('inbox_ids', to_jsonb(p_inbox_ids)); END IF;
    IF v_before.daily_limit <> p_daily_limit THEN v_changes := v_changes || jsonb_build_object('daily_limit', p_daily_limit); END IF;
    IF v_before.verified_senders_only <> p_verified_senders_only THEN v_changes := v_changes || jsonb_build_object('verified_senders_only', p_verified_senders_only); END IF;
    IF v_before.enabled <> p_enabled THEN v_changes := v_changes || jsonb_build_object('enabled', p_enabled); END IF;

    UPDATE public.no_approval_rules
       SET name = btrim(p_name), recipients = v_recipients, scope = p_scope, inbox_ids = p_inbox_ids,
           daily_limit = p_daily_limit, time_zone = p_time_zone,
           verified_senders_only = p_verified_senders_only, enabled = p_enabled,
           enabled_at = v_enabled_at,
           -- Switching off and on is how a person resumes a rule failures paused.
           paused_at = CASE WHEN p_enabled AND NOT v_before.enabled THEN NULL ELSE paused_at END,
           paused_reason = CASE WHEN p_enabled AND NOT v_before.enabled THEN NULL ELSE paused_reason END,
           consecutive_failures = CASE WHEN p_enabled AND NOT v_before.enabled THEN 0 ELSE consecutive_failures END,
           updated_by = v_uid, updated_at = now()
     WHERE id = p_rule_id;
    PERFORM public.no_approval_log(
      CASE WHEN p_enabled AND NOT v_before.enabled THEN 'no_approval_rule.enabled'
           WHEN v_before.enabled AND NOT p_enabled THEN 'no_approval_rule.disabled'
           ELSE 'no_approval_rule.updated' END,
      p_workspace_id, p_rule_id, v_uid, v_changes
    );
  END IF;

  -- Saving lists automations, it never re-confirms one: a kept row keeps the
  -- fingerprint a person confirmed, so a voided automation stays voided.
  DELETE FROM public.no_approval_rule_automations a
   WHERE a.no_approval_rule_id = v_id
     AND (p_scope <> 'chosen_automations' OR NOT (a.triage_rule_id = ANY (p_automation_ids)));
  IF p_scope = 'chosen_automations' THEN
    INSERT INTO public.no_approval_rule_automations (no_approval_rule_id, triage_rule_id, workspace_id, fingerprint, confirmed_by)
    SELECT v_id, t.id, p_workspace_id,
           public.triage_rule_fingerprint(t.filter, t.action, t.inbox_id, t.api_key_id), v_uid
      FROM public.triage_rules t
     WHERE t.id = ANY (p_automation_ids) AND t.workspace_id = p_workspace_id
    ON CONFLICT (no_approval_rule_id, triage_rule_id) DO NOTHING;
  END IF;

  RETURN v_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.no_approval_rule_delete(p_workspace_id uuid, p_rule_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid := public.no_approval_require_manager(p_workspace_id);
BEGIN
  DELETE FROM public.no_approval_rules WHERE id = p_rule_id AND workspace_id = p_workspace_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.no_approval_log('no_approval_rule.deleted', p_workspace_id, p_rule_id, v_uid, NULL);
  RETURN true;
END;
$fn$;

-- A person looks at an automation as it stands now and says yes again.
CREATE OR REPLACE FUNCTION public.no_approval_rule_confirm(p_workspace_id uuid, p_rule_id uuid, p_triage_rule_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid := public.no_approval_require_manager(p_workspace_id);
BEGIN
  UPDATE public.no_approval_rule_automations a
     SET fingerprint = public.triage_rule_fingerprint(t.filter, t.action, t.inbox_id, t.api_key_id),
         confirmed_by = v_uid,
         confirmed_at = now()
    FROM public.triage_rules t
   WHERE a.no_approval_rule_id = p_rule_id
     AND a.triage_rule_id = p_triage_rule_id
     AND a.workspace_id = p_workspace_id
     AND t.id = a.triage_rule_id
     AND t.workspace_id = p_workspace_id
     AND t.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.no_approval_log(
    'no_approval_rule.reconfirmed', p_workspace_id, p_rule_id, v_uid,
    jsonb_build_object('triage_rule_id', p_triage_rule_id)
  );
  RETURN true;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.no_approval_pause_all(p_workspace_id uuid, p_paused boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid := public.no_approval_require_manager(p_workspace_id);
BEGIN
  INSERT INTO public.no_approval_workspace_state (workspace_id, paused_at, paused_by, updated_at)
  VALUES (p_workspace_id, CASE WHEN p_paused THEN now() END, v_uid, now())
  ON CONFLICT (workspace_id) DO UPDATE
    SET paused_at = EXCLUDED.paused_at, paused_by = EXCLUDED.paused_by, updated_at = now();
  PERFORM public.no_approval_log(
    CASE WHEN p_paused THEN 'no_approval_rule.paused_all' ELSE 'no_approval_rule.resumed_all' END,
    p_workspace_id, NULL, v_uid, NULL
  );
  RETURN p_paused;
END;
$fn$;

-- ------------------------------------------------------------
-- Grants
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.no_approval_evaluate(uuid, text[], text, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.no_approval_auto_decide(uuid, integer, text[], text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.no_approval_recheck(uuid, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.no_approval_return_to_waiting(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.no_approval_note_send_result(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.no_approval_workspace_coverage(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.no_approval_rules_overview(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.no_approval_evaluate(uuid, text[], text, timestamptz, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.no_approval_auto_decide(uuid, integer, text[], text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.no_approval_recheck(uuid, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.no_approval_return_to_waiting(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.no_approval_note_send_result(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.no_approval_workspace_coverage(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.no_approval_rules_overview(uuid) TO service_role;

-- The writers: a user's session only, never the service role.
REVOKE ALL ON FUNCTION public.no_approval_rule_save(uuid, uuid, text, text[], text, uuid[], uuid[], integer, text, boolean, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.no_approval_rule_delete(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.no_approval_rule_confirm(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.no_approval_pause_all(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.no_approval_rule_save(uuid, uuid, text, text[], text, uuid[], uuid[], integer, text, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.no_approval_rule_delete(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.no_approval_rule_confirm(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.no_approval_pause_all(uuid, boolean) TO authenticated;

-- Helpers, called only from inside the functions above.
REVOKE ALL ON FUNCTION public.no_approval_require_manager(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.no_approval_log(text, uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.no_approval_address_digests(text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.triage_rule_fingerprint(jsonb, jsonb, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.no_approval_recipients_valid(text[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.no_approval_recipients_valid(text[]) TO authenticated;

-- ------------------------------------------------------------
-- Notices: receipts and the coverage-paused email
-- ------------------------------------------------------------
ALTER TABLE public.forward_approval_notices
  ALTER COLUMN triage_rule_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS no_approval_rule_id uuid REFERENCES public.no_approval_rules(id) ON DELETE CASCADE;

ALTER TABLE public.forward_approval_notices DROP CONSTRAINT IF EXISTS forward_approval_notices_kind_check;
ALTER TABLE public.forward_approval_notices ADD CONSTRAINT forward_approval_notices_kind_check
  CHECK (kind IN ('queued', 'reminder', 'receipt', 'coverage_paused'));

CREATE INDEX IF NOT EXISTS forward_approval_notices_no_approval_rule_idx
  ON public.forward_approval_notices (no_approval_rule_id) WHERE no_approval_rule_id IS NOT NULL;

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
