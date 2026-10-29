-- Free trial week shortened from 7 to 3 days for NEW workspaces.
--
-- Decided 2026-10-17: the action cap converts (28% of capped workspaces pay)
-- and 29% of evaluators burn past 150 actions inside the old 7-day window, so
-- the cap reached them after their highest-intent days. Workspaces created at
-- or after 2026-10-17 16:00 UTC get 3 uncounted days; every workspace created
-- before keeps the 7 days it was promised at signup.
--
-- The grace length now lives in ONE place, free_action_grace_ends_at(), and
-- the three functions that hard-coded interval '7 days' call it:
--   workspace_action_allowance()  the gate (edge function, /api/usage)
--   growth_usage_cap_states()     /admin/growth usage-cap sub-page
--   growth_utilization_bands()    /admin/growth utilization bands
-- Bodies are the live definitions as of 2026-10-17 (pg_get_functiondef) with
-- only the grace expression changed. Copy mirrors: FREE_ACTION_GRACE_DAYS in
-- apps/web/src/lib/stripe/plans.ts and supabase/functions/mcp-server/
-- usage-limit-message.ts. Re-runnable.

CREATE OR REPLACE FUNCTION public.free_action_grace_ends_at(p_created_at timestamptz)
 RETURNS timestamptz
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_created_at + CASE
    WHEN p_created_at >= timestamptz '2026-10-17 16:00:00+00' THEN interval '3 days'
    ELSE interval '7 days'
  END;
$function$;

REVOKE ALL ON FUNCTION public.free_action_grace_ends_at(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.free_action_grace_ends_at(timestamptz) TO service_role;

COMMENT ON FUNCTION public.free_action_grace_ends_at(timestamptz) IS
  'End of the uncounted Free trial window: created_at + 3 days for workspaces '
  'created at or after 2026-10-17 16:00 UTC, + 7 days before that.';

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
    v_grace_ends_at := public.free_action_grace_ends_at(v_created_at);
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
$function$;

CREATE OR REPLACE FUNCTION public.growth_usage_cap_states(p_internal_emails text[] DEFAULT '{}'::text[], p_internal_domains text[] DEFAULT '{}'::text[])
 RETURNS TABLE(workspace_id uuid, owner_id uuid, owner_email text, workspace_name text, plan text, created_at timestamp with time zone, state text, used integer, cap integer, remaining integer, period_start timestamp with time zone, period_end timestamp with time zone, grace_ends_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH consts AS (
    -- MUST equal c_free_cap and c_meter_version in
    -- workspace_action_allowance(); grace comes from free_action_grace_ends_at().
    SELECT 150::int AS free_cap, 1::int AS meter_version
  ),
  month AS (
    SELECT
      date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc' AS starts,
      (date_trunc('month', now() AT TIME ZONE 'utc') + interval '1 month') AT TIME ZONE 'utc' AS ends
  ),
  scoped AS (
    SELECT
      w.id,
      w.owner_id,
      u.email AS owner_email,
      w.display_name,
      coalesce(w.plan, 'free') AS plan,
      w.created_at,
      w.free_action_cap_exempt AS early,
      EXISTS (
        SELECT 1 FROM public.user_usage_entitlements e
        WHERE e.user_id = w.owner_id
          AND e.kind = 'comped_scale'
          AND (e.expires_at IS NULL OR e.expires_at > now())
      ) AS comped,
      EXISTS (
        SELECT 1 FROM public.workspace_usage_exemptions x
        WHERE x.workspace_id = w.id
          AND x.revoked_at IS NULL
          AND (x.expires_at IS NULL OR x.expires_at > now())
      ) AS exempted
    FROM public.workspaces w
    JOIN public.users u ON u.id = w.owner_id
    WHERE w.deleted_at IS NULL
      AND NOT public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains)
  ),
  windowed AS (
    SELECT
      s.*,
      (s.early OR s.comped OR s.exempted) AS exempt,
      c.free_cap,
      c.meter_version,
      m.ends AS period_end,
      CASE WHEN s.plan = 'free' AND NOT (s.early OR s.comped OR s.exempted)
        THEN public.free_action_grace_ends_at(s.created_at) END AS grace_ends_at,
      -- Exempt and paid rows report the plain month so `used` still means
      -- something on the sub-page; the metered Free window opens after grace
      -- and never after the month ends.
      CASE WHEN s.plan = 'free' AND NOT (s.early OR s.comped OR s.exempted)
        THEN LEAST(GREATEST(m.starts, public.free_action_grace_ends_at(s.created_at)), m.ends)
        ELSE m.starts END AS period_start
    FROM scoped s
    CROSS JOIN consts c
    CROSS JOIN month m
  ),
  counted AS (
    SELECT
      wd.*,
      (
        SELECT count(*)::int
        FROM public.action_usage a
        WHERE a.workspace_id = wd.id
          AND a.billable
          AND a.meter_version = wd.meter_version
          AND a.occurred_at >= wd.period_start
          AND a.occurred_at <  wd.period_end
      ) AS used
    FROM windowed wd
  )
  SELECT
    c.id            AS workspace_id,
    c.owner_id,
    c.owner_email,
    c.display_name  AS workspace_name,
    c.plan,
    c.created_at,
    CASE
      WHEN c.early                          THEN 'exempt_early'
      WHEN c.exempt                         THEN 'exempt_support'
      WHEN c.plan <> 'free'                 THEN 'paid'
      WHEN now() < c.grace_ends_at          THEN 'grace'
      WHEN c.used >= c.free_cap             THEN 'capped'
      WHEN c.used * 100 >= c.free_cap * 80  THEN 'warn'
      WHEN c.used * 100 >= c.free_cap * 50  THEN 'half'
      ELSE 'under_half'
    END AS state,
    c.used,
    CASE WHEN c.plan = 'free' AND NOT c.exempt THEN c.free_cap END AS cap,
    CASE WHEN c.plan = 'free' AND NOT c.exempt THEN GREATEST(c.free_cap - c.used, 0) END AS remaining,
    c.period_start,
    c.period_end,
    c.grace_ends_at
  FROM counted c;
$function$;

CREATE OR REPLACE FUNCTION public.growth_utilization_bands(p_caps jsonb, p_meter_version integer DEFAULT 1)
 RETURNS TABLE(band text, workspaces integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH month AS (
    SELECT
      date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc' AS starts,
      (date_trunc('month', now() AT TIME ZONE 'utc') + interval '1 month') AT TIME ZONE 'utc' AS ends
  ),
  scoped AS (
    SELECT
      w.id,
      coalesce(w.plan, 'free') AS plan,
      w.owner_id,
      public.free_action_grace_ends_at(w.created_at) AS grace_ends_at,
      coalesce(e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now()), false)
        OR x.workspace_id IS NOT NULL
        OR (coalesce(w.plan, 'free') = 'free' AND w.free_action_cap_exempt)
        OR (coalesce(w.plan, 'free') = 'free' AND now() < public.free_action_grace_ends_at(w.created_at)) AS unlimited
    FROM public.workspaces w
    LEFT JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
    LEFT JOIN (
      SELECT DISTINCT ex.workspace_id
      FROM public.workspace_usage_exemptions ex
      WHERE ex.revoked_at IS NULL
        AND (ex.expires_at IS NULL OR ex.expires_at > now())
    ) x ON x.workspace_id = w.id
    WHERE w.deleted_at IS NULL
  ),
  windowed AS (
    SELECT
      s.id,
      s.plan,
      s.unlimited,
      CASE WHEN s.plan <> 'free'
            AND b.current_period_start IS NOT NULL
            AND b.current_period_end IS NOT NULL
            AND b.current_period_start <= now()
            AND now() < b.current_period_end
        THEN b.current_period_start
        WHEN s.plan = 'free' THEN least(greatest(m.starts, s.grace_ends_at), m.ends)
        ELSE m.starts END AS period_start,
      CASE WHEN s.plan <> 'free'
            AND b.current_period_start IS NOT NULL
            AND b.current_period_end IS NOT NULL
            AND b.current_period_start <= now()
            AND now() < b.current_period_end
        THEN b.current_period_end ELSE m.ends END AS period_end
    FROM scoped s
    CROSS JOIN month m
    LEFT JOIN public.user_billing b ON b.user_id = s.owner_id
  ),
  used AS (
    SELECT
      wd.id,
      wd.plan,
      wd.unlimited,
      coalesce(sum(a.quantity), 0)::numeric AS actions
    FROM windowed wd
    LEFT JOIN public.action_usage a
      ON a.workspace_id = wd.id
     AND a.billable
     AND a.meter_version = p_meter_version
     AND a.occurred_at >= wd.period_start
     AND a.occurred_at < wd.period_end
    GROUP BY wd.id, wd.plan, wd.unlimited
  ),
  rated AS (
    SELECT
      u.actions,
      CASE WHEN u.unlimited THEN NULL
        ELSE coalesce((p_caps ->> u.plan)::numeric, (p_caps ->> 'free')::numeric) END AS cap
    FROM used u
  ),
  assigned AS (
    SELECT
      CASE
        WHEN r.cap IS NULL OR r.cap <= 0 THEN 1
        WHEN r.actions / r.cap >= 1 THEN 5
        WHEN r.actions / r.cap >= 0.8 THEN 4
        WHEN r.actions / r.cap >= 0.5 THEN 3
        WHEN r.actions / r.cap >= 0.25 THEN 2
        ELSE 1
      END AS band_order
    FROM rated r
  ),
  bands (band_order, label) AS (
    VALUES (1, '0-24%'), (2, '25-49%'), (3, '50-79%'), (4, '80-99%'), (5, '100%+')
  )
  SELECT
    b.label AS band,
    count(a.band_order)::int AS workspaces
  FROM bands b
  LEFT JOIN assigned a ON a.band_order = b.band_order
  GROUP BY b.band_order, b.label
  ORDER BY b.band_order;
$function$;
