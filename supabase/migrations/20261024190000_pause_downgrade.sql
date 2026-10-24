-- ============================================================================
-- Pause and switch-to-Personal at period end: state columns, funnel stages,
-- the two pause emails, and the Free allowance window during a pause.
-- 20261024190000_pause_downgrade
-- ============================================================================
--
-- WHY. Documents/plans/pause-downgrade-20261024.md (section 12 overrides the
-- mechanics). Stripe holds the truth (pause_collection plus metadata
-- mcpe_pause_*, and a price swap plus metadata mcpe_downgrade_*). The Stripe
-- webhook projects it here so the dashboard, the cron fallback and the
-- allowance function can read it without a Stripe call.
--
-- WHAT.
--   1. user_billing gains:
--        paused_from                when the paid plan stops (the renewal the
--                                   pause starts at). Set while a pause is
--                                   scheduled or running, NULL otherwise.
--        pause_resumes_at           when Stripe resumes collection (one hour
--                                   before the renewal that bills again).
--        pending_plan               the plan a pending downgrade lands on.
--        pending_plan_effective_at  when it lands (the current period end).
--        inbox_keep_order           jsonb array of inbox ids, the customer's
--                                   choice of which inboxes stay active when
--                                   the plan drops. Read by parking.ts.
--        pause_history              jsonb array of {from, months}: the
--                                   rolling 12-month cap of 3 paused months.
--                                   Mirrors metadata.mcpe_pause_history.
--      Only the service role writes user_billing (there is no write policy for
--      authenticated), so a customer cannot move paused_from to widen their
--      Free allowance window. Paired CHECKs keep each pair consistent.
--   2. product_funnel_events: nine new stages and four new categories
--      (pause_resumed early|auto, retention_option_clicked pause|downgrade).
--      Both lists are copied from their latest definitions
--      (stage: 20261019150000, category: 20260827100000) with the additions.
--   3. billing_email_sends: templates pause_started and pause_ending_3. Their
--      GENERATED category is 'transactional' (only winback_* is marketing), so
--      neither is suppressible: both are about money on an existing contract.
--      The template list is copied from 20260912200000.
--   4. workspace_action_allowance() and workspace_action_allowance_terms():
--      for a Free workspace whose owner has paused_from in the past, the
--      counting window opens at greatest(month_start, grace end, paused_from).
--      A heavy paid month therefore does not lock a paused customer out of
--      Free on day one. Bodies copied verbatim from 20261017160000 and
--      20261020214737; the Free branch's period_start is the only change, plus
--      the one read of user_billing.paused_from it needs. The parity test in
--      supabase/tests/mcp_tools_call_gate.sql keeps the two in step.
--
-- DEPLOY ORDER. Apply before the web push that writes these columns. The web
-- code tolerates the columns being absent (it reads them first and skips the
-- pause/downgrade work on an unknown-column error), so applying late only
-- delays the feature, which is behind BILLING_PAUSE_ENABLED and
-- BILLING_DOWNGRADE_ENABLED anyway.
--
-- Idempotent: IF NOT EXISTS columns, constraints dropped and re-added,
-- CREATE OR REPLACE functions.
-- ============================================================================

-- 1. user_billing columns ----------------------------------------------------

ALTER TABLE public.user_billing
  ADD COLUMN IF NOT EXISTS paused_from               timestamptz,
  ADD COLUMN IF NOT EXISTS pause_resumes_at          timestamptz,
  ADD COLUMN IF NOT EXISTS pending_plan              text,
  ADD COLUMN IF NOT EXISTS pending_plan_effective_at timestamptz,
  ADD COLUMN IF NOT EXISTS inbox_keep_order          jsonb,
  ADD COLUMN IF NOT EXISTS pause_history             jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.user_billing DROP CONSTRAINT IF EXISTS user_billing_pause_pair_check;
ALTER TABLE public.user_billing
  ADD CONSTRAINT user_billing_pause_pair_check
  CHECK ((paused_from IS NULL) = (pause_resumes_at IS NULL)
         AND (paused_from IS NULL OR paused_from < pause_resumes_at));

ALTER TABLE public.user_billing DROP CONSTRAINT IF EXISTS user_billing_pending_plan_check;
ALTER TABLE public.user_billing
  ADD CONSTRAINT user_billing_pending_plan_check
  CHECK ((pending_plan IS NULL) = (pending_plan_effective_at IS NULL)
         AND (pending_plan IS NULL OR pending_plan IN ('free', 'personal', 'solo')));

ALTER TABLE public.user_billing DROP CONSTRAINT IF EXISTS user_billing_inbox_keep_order_check;
ALTER TABLE public.user_billing
  ADD CONSTRAINT user_billing_inbox_keep_order_check
  CHECK (inbox_keep_order IS NULL OR jsonb_typeof(inbox_keep_order) = 'array');

ALTER TABLE public.user_billing DROP CONSTRAINT IF EXISTS user_billing_pause_history_check;
ALTER TABLE public.user_billing
  ADD CONSTRAINT user_billing_pause_history_check
  CHECK (jsonb_typeof(pause_history) = 'array');

COMMENT ON COLUMN public.user_billing.paused_from IS
  'When the paid plan stops for a pause (the renewal the pause starts at). Projected '
  'from Stripe metadata.mcpe_pause_from by the webhook. The Free allowance window '
  'opens no earlier than this while the owner is on Free. Service role writes only.';
COMMENT ON COLUMN public.user_billing.pause_resumes_at IS
  'Stripe pause_collection.resumes_at: one hour before the renewal that bills again.';
COMMENT ON COLUMN public.user_billing.pending_plan IS
  'The plan a pending downgrade lands on (metadata.mcpe_downgrade_*). Entitlement stays '
  'on the current plan until pending_plan_effective_at.';
COMMENT ON COLUMN public.user_billing.inbox_keep_order IS
  'jsonb array of inbox ids the customer picked to stay active when the plan drops '
  '(pause or downgrade). Preferred order for apps/web/src/lib/billing/parking.ts.';
COMMENT ON COLUMN public.user_billing.pause_history IS
  'jsonb array of {from: unix seconds, months: int}, one per pause. Enforces the '
  'rolling 12-month cap of 3 paused months. Mirrors metadata.mcpe_pause_history.';

-- 2. Funnel stages and categories --------------------------------------------

ALTER TABLE public.product_funnel_events
  DROP CONSTRAINT IF EXISTS product_funnel_events_stage_check;
ALTER TABLE public.product_funnel_events
  ADD CONSTRAINT product_funnel_events_stage_check
  CHECK (stage IN (
    'onboarding_started', 'client_selected', 'provider_selected', 'inbox_connection',
    'connection_verified', 'credential_created', 'technical_activation',
    'value_activation', 'first_tool_call',
    -- Billing funnel
    'paywall_reached', 'pricing_viewed', 'checkout_started', 'checkout_completed',
    'billing_portal_opened',
    -- An existing subscriber's price was swapped in place, in either direction.
    'plan_upgraded', 'plan_downgraded',
    -- The Overview guide asked a business-domain workspace to connect a second
    -- work mailbox: started = shown, success = clicked.
    'multi_inbox_prompt',
    -- A buy button on the inbox-cap offer was clicked. The matching "shown" is
    -- the paywall_reached row with connection_type = 'first_connect'.
    'paywall_clicked',
    -- Pause and switch to Personal (20261024190000). Category is the plan the
    -- customer was on, except pause_resumed (early | auto) and
    -- retention_option_clicked (pause | downgrade).
    'pause_started', 'pause_extended', 'pause_resumed', 'pause_ended_cancelled',
    'downgrade_scheduled', 'downgrade_undone',
    'inbox_parked', 'inbox_unparked',
    'retention_option_clicked'
  ));

ALTER TABLE public.product_funnel_events
  DROP CONSTRAINT IF EXISTS product_funnel_events_category_check;
ALTER TABLE public.product_funnel_events
  ADD CONSTRAINT product_funnel_events_category_check
  CHECK (category IN (
    'gmail', 'outlook', 'fastmail', 'icloud', 'yahoo', 'zoho', 'yandex',
    'generic_imap', 'api_key', 'oauth', 'claude', 'chatgpt', 'cursor',
    'vscode', 'cline', 'windsurf', 'gemini', 'zed', 'jetbrains', 'raycast',
    'warp', 'curl', 'unknown',
    -- Billing: the plan+interval a checkout targeted ...
    'personal_month', 'personal_year',
    'solo_month', 'solo_year', 'pro_month', 'pro_year',
    -- ... the plan a user was on when a paywall or portal event fired ...
    'free', 'personal', 'solo', 'pro',
    -- ... and the surface a pricing view happened on.
    'pricing_page', 'dashboard_billing',
    -- pause_resumed: who ended the pause. retention_option_clicked: which one.
    'early', 'auto', 'pause', 'downgrade'
  ));

-- 3. Billing email templates -------------------------------------------------

ALTER TABLE public.billing_email_sends
  DROP CONSTRAINT IF EXISTS billing_email_sends_template_check;
ALTER TABLE public.billing_email_sends
  ADD CONSTRAINT billing_email_sends_template_check CHECK (template IN (
    -- transactional: the payment is broken or about to be
    'dunning_1', 'dunning_3', 'dunning_7', 'dunning_14',
    'card_expiry_30', 'card_expiry_7',
    -- transactional: they cancelled, we ask one question
    'cancel_ask',
    -- marketing-adjacent: they are already gone
    'winback_14', 'winback_30',
    -- transactional: the Free allowance is 80% used, used up, or paused a rule
    'usage_warning_80', 'usage_limit_reached', 'automation_paused_limit',
    -- transactional: a pause receipt, and the notice 3 days before billing resumes
    'pause_started', 'pause_ending_3'
  ));

-- 4. The Free allowance window during a pause --------------------------------

CREATE OR REPLACE FUNCTION public.workspace_action_allowance(p_workspace_id uuid)
 RETURNS TABLE(plan text, owner_id uuid, exempt boolean, exempt_reason text, cap integer, period_start timestamp with time zone, period_end timestamp with time zone, grace_ends_at timestamp with time zone, in_grace boolean, used integer, remaining integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- THE two product constants. apps/web/src/lib/stripe/plans.ts mirrors them
  -- as FREE_ACTION_ALLOWANCE / FREE_ACTION_GRACE_DAYS for copy only (the grace
  -- length lives in free_action_grace_ends_at()); the
  -- number a customer reads on /pricing must be the number that blocks them,
  -- and that number is this one.
  c_free_cap        constant integer  := 150;
  -- Silent abuse ceilings for paid plans. NOT a pricing lever; mirrors
  -- SHADOW_ACTION_CAPS in supabase/functions/mcp-server/index.ts and
  -- maxMonthlyToolCalls in plans.ts. Never named in customer-facing copy.
  c_cap_personal    constant integer  := 100000;
  c_cap_solo        constant integer  := 100000;
  c_cap_pro         constant integer  := 500000;
  c_cap_other       constant integer  := 5000;
  c_meter_version   constant integer  := 1;

  v_plan            text;
  v_owner_id        uuid;
  v_created_at      timestamptz;
  v_early_member    boolean;
  v_exempt          boolean := false;
  v_exempt_reason   text;
  v_cap             integer;
  v_now             timestamptz := now();
  v_month_start     timestamptz;
  v_month_end       timestamptz;
  v_period_start    timestamptz;
  v_period_end      timestamptz;
  v_grace_ends_at   timestamptz;
  v_in_grace        boolean := false;
  v_used            integer := 0;
  v_remaining       integer;
  v_ub_start        timestamptz;
  v_ub_end          timestamptz;
  v_paused_from     timestamptz;
BEGIN
  -- (a) The workspace. deleted_at is irrelevant: a soft-deleted workspace
  -- cannot make tool calls, and if it is restored its allowance must not have
  -- silently changed meanwhile.
  SELECT w.plan, w.owner_id, w.created_at, w.free_action_cap_exempt
    INTO v_plan, v_owner_id, v_created_at, v_early_member
  FROM public.workspaces w
  WHERE w.id = p_workspace_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- The UTC calendar month containing now(), as timestamptz at 00:00 UTC on
  -- the 1st. now() AT TIME ZONE 'UTC' is a plain timestamp in UTC wall-clock;
  -- date_trunc gives the 1st at midnight; the second AT TIME ZONE 'UTC' reads
  -- that wall-clock back as a UTC instant. This is the same month the edge
  -- function's calendarMonthUsageWindow() computes with Date.UTC.
  v_month_start := date_trunc('month', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_month_end   := v_month_start + interval '1 month';

  -- (b) Exemptions, in precedence order.
  IF v_early_member THEN
    v_exempt := true;
    v_exempt_reason := 'early_member';
  ELSIF EXISTS (
    SELECT 1 FROM public.user_usage_entitlements e
    WHERE e.user_id = v_owner_id
      AND e.kind = 'comped_scale'
      AND (e.expires_at IS NULL OR e.expires_at > v_now)
  ) THEN
    v_exempt := true;
    v_exempt_reason := 'comped';
  ELSIF EXISTS (
    SELECT 1 FROM public.workspace_usage_exemptions x
    WHERE x.workspace_id = p_workspace_id
      AND x.revoked_at IS NULL
      AND (x.expires_at IS NULL OR x.expires_at > v_now)
  ) THEN
    v_exempt := true;
    v_exempt_reason := 'exemption';
  END IF;

  IF v_exempt THEN
    -- Nothing to run out of. The month is reported so a dashboard can still
    -- say "42 actions this month" next to the exempt badge.
    v_cap := NULL;
    v_period_start := v_month_start;
    v_period_end := v_month_end;
    v_grace_ends_at := NULL;
    v_in_grace := false;

  ELSIF v_plan IS DISTINCT FROM 'free' THEN
    -- (c) Paid: Stripe's stored cycle when it is live, else the calendar
    -- month. Same rule as growth_inventory_rpcs and the edge function's
    -- resolveUsageBillingWindow.
    SELECT ub.current_period_start, ub.current_period_end
      INTO v_ub_start, v_ub_end
    FROM public.user_billing ub
    WHERE ub.user_id = v_owner_id
    LIMIT 1;
    IF v_ub_start IS NOT NULL AND v_ub_end IS NOT NULL
       AND v_ub_start <= v_now AND v_now < v_ub_end THEN
      v_period_start := v_ub_start;
      v_period_end := v_ub_end;
    ELSE
      v_period_start := v_month_start;
      v_period_end := v_month_end;
    END IF;
    v_cap := CASE v_plan
      WHEN 'personal' THEN c_cap_personal
      WHEN 'solo'     THEN c_cap_solo
      WHEN 'pro'      THEN c_cap_pro
      ELSE c_cap_other
    END;
    v_grace_ends_at := NULL;
    v_in_grace := false;

  ELSE
    -- (d) Free, created after launch. The first 3 days (7 for workspaces
    -- created before 2026-10-17 16:00 UTC) are not counted, so
    -- the counting window opens at the LATER of the month start and the end
    -- of grace, and never after the month ends. A workspace created on the
    -- 28th is in grace until the 5th of next month: this month's window is
    -- empty (period_start = period_end, used = 0), next month's starts on
    -- the 5th.
    --
    -- A paused subscriber (20261024190000) is on Free from paused_from, and
    -- the window opens no earlier than that, so the paid month before the
    -- pause is not counted against the Free allowance. Only a pause that has
    -- started counts; GREATEST ignores the NULL of everyone else.
    SELECT ub.paused_from INTO v_paused_from
    FROM public.user_billing ub
    WHERE ub.user_id = v_owner_id AND ub.paused_from <= v_now
    LIMIT 1;
    v_grace_ends_at := public.free_action_grace_ends_at(v_created_at);
    v_in_grace := v_now < v_grace_ends_at;
    v_period_end := v_month_end;
    v_period_start := LEAST(GREATEST(v_month_start, v_grace_ends_at, v_paused_from), v_month_end);
    v_cap := c_free_cap;
  END IF;

  -- (e) The meter. An empty window (Free, still in grace past month end)
  -- counts nothing; the half-open range would return 0 anyway, this just
  -- makes the intent visible.
  IF v_period_start < v_period_end THEN
    SELECT count(*)::integer INTO v_used
    FROM public.action_usage au
    WHERE au.workspace_id = p_workspace_id
      AND au.billable
      AND au.meter_version = c_meter_version
      AND au.occurred_at >= v_period_start
      AND au.occurred_at <  v_period_end;
  ELSE
    v_used := 0;
  END IF;

  v_remaining := CASE WHEN v_cap IS NULL THEN NULL
                      ELSE GREATEST(v_cap - v_used, 0) END;

  RETURN QUERY SELECT
    v_plan, v_owner_id, v_exempt, v_exempt_reason, v_cap,
    v_period_start, v_period_end, v_grace_ends_at, v_in_grace,
    v_used, v_remaining;
END;
$function$;

CREATE OR REPLACE FUNCTION public.workspace_action_allowance_terms(p_workspace_id uuid)
 RETURNS TABLE(plan text, owner_id uuid, exempt boolean, exempt_reason text, cap integer, period_start timestamp with time zone, period_end timestamp with time zone, grace_ends_at timestamp with time zone, in_grace boolean, used integer, remaining integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- Sections (a) to (d) of workspace_action_allowance(), verbatim, including
  -- the constants. Section (e), the count, is the only thing removed.
  -- Keep the two in step: the parity check in
  -- supabase/tests/mcp_tools_call_gate.sql compares them column by column.
  c_free_cap        constant integer  := 150;
  c_cap_personal    constant integer  := 100000;
  c_cap_solo        constant integer  := 100000;
  c_cap_pro         constant integer  := 500000;
  c_cap_other       constant integer  := 5000;

  v_plan            text;
  v_owner_id        uuid;
  v_created_at      timestamptz;
  v_early_member    boolean;
  v_exempt          boolean := false;
  v_exempt_reason   text;
  v_cap             integer;
  v_now             timestamptz := now();
  v_month_start     timestamptz;
  v_month_end       timestamptz;
  v_period_start    timestamptz;
  v_period_end      timestamptz;
  v_grace_ends_at   timestamptz;
  v_in_grace        boolean := false;
  v_ub_start        timestamptz;
  v_ub_end          timestamptz;
  v_paused_from     timestamptz;
BEGIN
  SELECT w.plan, w.owner_id, w.created_at, w.free_action_cap_exempt
    INTO v_plan, v_owner_id, v_created_at, v_early_member
  FROM public.workspaces w
  WHERE w.id = p_workspace_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_month_start := date_trunc('month', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_month_end   := v_month_start + interval '1 month';

  IF v_early_member THEN
    v_exempt := true;
    v_exempt_reason := 'early_member';
  ELSIF EXISTS (
    SELECT 1 FROM public.user_usage_entitlements e
    WHERE e.user_id = v_owner_id
      AND e.kind = 'comped_scale'
      AND (e.expires_at IS NULL OR e.expires_at > v_now)
  ) THEN
    v_exempt := true;
    v_exempt_reason := 'comped';
  ELSIF EXISTS (
    SELECT 1 FROM public.workspace_usage_exemptions x
    WHERE x.workspace_id = p_workspace_id
      AND x.revoked_at IS NULL
      AND (x.expires_at IS NULL OR x.expires_at > v_now)
  ) THEN
    v_exempt := true;
    v_exempt_reason := 'exemption';
  END IF;

  IF v_exempt THEN
    v_cap := NULL;
    v_period_start := v_month_start;
    v_period_end := v_month_end;
    v_grace_ends_at := NULL;
    v_in_grace := false;

  ELSIF v_plan IS DISTINCT FROM 'free' THEN
    SELECT ub.current_period_start, ub.current_period_end
      INTO v_ub_start, v_ub_end
    FROM public.user_billing ub
    WHERE ub.user_id = v_owner_id
    LIMIT 1;
    IF v_ub_start IS NOT NULL AND v_ub_end IS NOT NULL
       AND v_ub_start <= v_now AND v_now < v_ub_end THEN
      v_period_start := v_ub_start;
      v_period_end := v_ub_end;
    ELSE
      v_period_start := v_month_start;
      v_period_end := v_month_end;
    END IF;
    v_cap := CASE v_plan
      WHEN 'personal' THEN c_cap_personal
      WHEN 'solo'     THEN c_cap_solo
      WHEN 'pro'      THEN c_cap_pro
      ELSE c_cap_other
    END;
    v_grace_ends_at := NULL;
    v_in_grace := false;

  ELSE
    SELECT ub.paused_from INTO v_paused_from
    FROM public.user_billing ub
    WHERE ub.user_id = v_owner_id AND ub.paused_from <= v_now
    LIMIT 1;
    v_grace_ends_at := public.free_action_grace_ends_at(v_created_at);
    v_in_grace := v_now < v_grace_ends_at;
    v_period_end := v_month_end;
    v_period_start := LEAST(GREATEST(v_month_start, v_grace_ends_at, v_paused_from), v_month_end);
    v_cap := c_free_cap;
  END IF;

  RETURN QUERY SELECT
    v_plan, v_owner_id, v_exempt, v_exempt_reason, v_cap,
    v_period_start, v_period_end, v_grace_ends_at, v_in_grace,
    NULL::integer, NULL::integer;
END;
$function$;

-- CREATE OR REPLACE keeps the existing grants; restated so this file alone is
-- the whole truth about who may call them.
REVOKE ALL ON FUNCTION public.workspace_action_allowance_terms(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_action_allowance_terms(uuid) TO service_role;
