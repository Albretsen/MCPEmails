-- Personal's silent abuse ceiling 25,000 -> 100,000 billable actions per
-- billing period.
--
-- Why: on 2026-10-16 the heaviest Personal workspace had used 24.7k billable
-- actions in 30 days, so a $9 customer was about to be refused by a limit no
-- page names. The ceiling exists to stop abuse, not to sell Pro.
--
-- Only c_cap_personal changes. The body is otherwise byte for byte the one in
-- 20260912200000_free_action_cap_150.sql, which was checked against the live
-- definition (pg_get_functiondef) before writing this. CREATE OR REPLACE keeps
-- the existing COMMENT, REVOKE and GRANT.
--
-- Mirror: maxMonthlyToolCalls for 'personal' in apps/web/src/lib/stripe/plans.ts
-- and c_cap_personal in self-host/db/00-schema.sql.

CREATE OR REPLACE FUNCTION public.workspace_action_allowance(p_workspace_id uuid)
RETURNS TABLE (
  plan           text,
  owner_id       uuid,
  exempt         boolean,
  exempt_reason  text,
  cap            integer,
  period_start   timestamptz,
  period_end     timestamptz,
  grace_ends_at  timestamptz,
  in_grace       boolean,
  used           integer,
  remaining      integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- THE two product constants. apps/web/src/lib/stripe/plans.ts mirrors them
  -- as FREE_ACTION_ALLOWANCE / FREE_ACTION_GRACE_DAYS for copy only; the
  -- number a customer reads on /pricing must be the number that blocks them,
  -- and that number is this one.
  c_free_cap        constant integer  := 150;
  c_grace           constant interval := interval '7 days';
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
    -- (d) Free, created after launch. The first 7 days are not counted, so
    -- the counting window opens at the LATER of the month start and the end
    -- of grace, and never after the month ends. A workspace created on the
    -- 28th is in grace until the 5th of next month: this month's window is
    -- empty (period_start = period_end, used = 0), next month's starts on
    -- the 5th.
    v_grace_ends_at := v_created_at + c_grace;
    v_in_grace := v_now < v_grace_ends_at;
    v_period_end := v_month_end;
    v_period_start := LEAST(GREATEST(v_month_start, v_grace_ends_at), v_month_end);
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
$$;
