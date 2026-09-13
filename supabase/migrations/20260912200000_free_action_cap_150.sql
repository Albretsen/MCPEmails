-- ===========================================================================
-- Free action allowance: 150 email actions per UTC calendar month, first 7
-- days uncounted, every workspace that exists today exempt for good.
-- 20260912200000_free_action_cap_150
--
-- Design: docs/PLAN-free-action-cap-150.md (Phase 1) and
-- docs/DECISION-free-tier-usage-cap-20260912.md.
--
-- WHY ONE FUNCTION
-- ----------------
-- The billing window is currently defined three times (the edge function's
-- resolveUsageBillingWindow, lib/usage/billing-window.ts, /api/usage) and the
-- header of billing-window.ts records the bug that produced. A grace window
-- and a per-workspace exemption would make it four. So the allowance is
-- computed in exactly one place, workspace_action_allowance(), and every
-- caller (edge function, /api/usage, dashboard, admin RPCs) reads its row.
-- reserve_action_usage() is unchanged: it receives cap, period_start and
-- period_end from that row.
--
-- WHAT THIS MIGRATION DOES, IN ORDER
-- ----------------------------------
--   1. workspaces.free_action_cap_exempt, true for every row present now.
--   2. workspace_action_allowance(uuid): the one source of truth.
--   3. record_usage_limit_event(): same body, now RETURNS boolean.
--   4. triage_rules.paused_reason / paused_until for plan-limit pauses.
--   5. billing_email_sends: workspace-keyed rows for the three usage emails.
--   6. Grants.
--
-- Forward-only, one transaction. Every step is guarded so a partial re-run
-- after a failed apply converges on the same end state.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. workspaces.free_action_cap_exempt
--
-- Same shape as the 2026-08-19 inbox grandfather: the promise is made to the
-- accounts that exist at launch, per workspace. The UPDATE deliberately covers
-- soft-deleted rows too; a restored workspace is still a pre-launch one.
--
-- The backfill runs ONLY when the column is created by this apply. On a re-run
-- the column already exists, and re-marking every row would silently exempt
-- workspaces created after launch.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces'
      AND column_name = 'free_action_cap_exempt'
  ) THEN
    ALTER TABLE public.workspaces
      ADD COLUMN free_action_cap_exempt boolean NOT NULL DEFAULT false;
    UPDATE public.workspaces SET free_action_cap_exempt = true;
    RAISE NOTICE 'free_action_cap_exempt: backfilled % workspaces as early members',
      (SELECT count(*) FROM public.workspaces WHERE free_action_cap_exempt);
  ELSE
    RAISE NOTICE 'free_action_cap_exempt: column already present, backfill skipped';
  END IF;
END;
$$;

COMMENT ON COLUMN public.workspaces.free_action_cap_exempt IS
  'Set true for every workspace that existed on 2026-09-12 before the Free '
  'action allowance (150 email actions per UTC month) launched. Those '
  'workspaces are never metered against the Free allowance and keep only the '
  'silent 5,000 abuse ceiling. New workspaces default false. Never mass-update; '
  'a support exemption goes in workspace_usage_exemptions instead.';

-- create_workspace(p_name text), last defined in 20260803160000, inserts with
-- an explicit column list (owner_id, slug, display_name, plan), so the new
-- column takes its default of false and a second workspace made by an early
-- member is a NEW workspace, exactly as the plan wants. Nothing to redefine.


-- ---------------------------------------------------------------------------
-- 2. workspace_action_allowance(p_workspace_id uuid)
--
-- Returns one row, or no row for an unknown workspace id. Column contract
-- (order matters, the edge function and /api/usage read it positionally in
-- tests):
--
--   plan           workspaces.plan
--   owner_id       workspaces.owner_id
--   exempt         true when the workspace is never metered against Free
--   exempt_reason  'early_member' | 'comped' | 'exemption' | NULL
--   cap            NULL when exempt, else the plan's allowance
--   period_start   start of the COUNTING window (after grace for Free)
--   period_end     end of the billing window
--   grace_ends_at  created_at + 7 days for non-exempt Free, else NULL
--   in_grace       now() < grace_ends_at
--   used           billable action_usage rows in [period_start, period_end)
--   remaining      greatest(cap - used, 0), NULL when cap is NULL
--
-- Precedence: early member > comped owner > support exemption > paid plan >
-- Free. Exempt rows still report used for the calendar month so the dashboard
-- can show a number, but cap and remaining are NULL: there is nothing to
-- run out of.
--
-- used is a row COUNT, not SUM(quantity), on purpose: it must agree with
-- reserve_action_usage(), which counts rows plus live reservations, and the
-- edge function writes quantity = 1 on every billable row.
--
-- The window arithmetic is done in local variables and assigned to the OUT
-- columns once at the end; several OUT names (plan, period_start, cap) are
-- also column names on the tables read here (project_plpgsql_out_param_ambiguity).
-- ---------------------------------------------------------------------------
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
  c_cap_personal    constant integer  := 25000;
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

COMMENT ON FUNCTION public.workspace_action_allowance(uuid) IS
  'The one source of truth for a workspace''s action allowance: plan, '
  'exemption (early member, comped owner, support exemption), cap, counting '
  'window, 7-day grace, used and remaining. Free workspaces created after '
  '2026-09-12 get 150 billable actions per UTC month with the first 7 days '
  'uncounted; every other caller (edge function, /api/usage, dashboard, admin) '
  'must read this row rather than re-derive the window. Service-role only.';


-- ---------------------------------------------------------------------------
-- 3. record_usage_limit_event(): RETURNS boolean
--
-- Current definition is 20260827100000 (verified against the live database
-- with pg_get_functiondef before this file was written). The body is
-- reproduced unchanged. Only the return shape changes: a plain boolean, true
-- when THIS call wrote the once-per-period paywall_reached funnel row, so the
-- edge function can send the "limit reached" email exactly once per period
-- off the same signal, with no second round trip.
--
-- A return type cannot be changed with CREATE OR REPLACE, hence the DROP. The
-- REVOKE/GRANT posture is re-applied because a dropped function's ACL goes
-- with it, and the Supabase default would re-expose it to anon over
-- /rest/v1/rpc.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.record_usage_limit_event(uuid, text, integer, integer, integer, timestamptz);

CREATE FUNCTION public.record_usage_limit_event(
  p_workspace_id  uuid,
  p_plan          text,
  p_used_actions  integer,
  p_cap           integer,
  p_meter_version integer,
  p_period_start  timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_funnel_rows integer;
BEGIN
  INSERT INTO public.usage_limit_events
    (workspace_id, effective_plan, used_actions, cap, meter_version)
  VALUES
    (p_workspace_id, p_plan, p_used_actions, p_cap, p_meter_version);

  -- Serialised per workspace so two concurrent rejections cannot both pass the
  -- NOT EXISTS check. Same lock key as reserve_action_usage, so a rejection and
  -- a reservation for one workspace never interleave here.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));

  INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
  SELECT
    p_workspace_id,
    'paywall_reached',
    'success',
    CASE WHEN p_plan IN ('personal', 'solo', 'pro') THEN p_plan ELSE 'free' END
  WHERE NOT EXISTS (
    SELECT 1 FROM public.product_funnel_events e
    WHERE e.workspace_id = p_workspace_id
      AND e.stage = 'paywall_reached'
      AND e.occurred_at >= p_period_start
  );

  -- product_funnel_events.id is a bigint identity; never RETURNING INTO a
  -- uuid here (20260819160000 is the scar).
  GET DIAGNOSTICS v_funnel_rows = ROW_COUNT;
  RETURN v_funnel_rows > 0;
END;
$$;

COMMENT ON FUNCTION public.record_usage_limit_event(uuid, text, integer, integer, integer, timestamptz) IS
  'Records one action-cap rejection. Always appends to usage_limit_events; '
  'appends the paywall_reached funnel row at most once per workspace per '
  'billing period and returns true only on the call that wrote it.';

REVOKE ALL ON FUNCTION public.record_usage_limit_event(uuid, text, integer, integer, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_usage_limit_event(uuid, text, integer, integer, integer, timestamptz) TO service_role;


-- ---------------------------------------------------------------------------
-- 4. triage_rules: a visible, self-lifting pause
--
-- disabled_reason (20260819170000) means "5 consecutive failures" and is
-- terminal: the user has to re-enable the rule. A plan-limit pause is the
-- opposite, it ends by itself on the 1st. Two columns, so the dashboard can
-- say "paused until Oct 1, Free allowance used" instead of "disabled".
--
-- triage_rules_due_idx is left as it is. now() is STABLE, not IMMUTABLE, so
-- `paused_until <= now()` cannot appear in a partial-index predicate, and a
-- predicate of `paused_until IS NULL` would drop a rule out of the index for
-- good the moment it was paused, which is the opposite of self-lifting. The
-- dispatcher's listDueRules() and claimRule() (mcp-server/index.ts triageStore)
-- MUST add `paused_until IS NULL OR paused_until <= now()` themselves; the
-- index still narrows the scan to enabled, live, unclaimed rules.
-- ---------------------------------------------------------------------------
ALTER TABLE public.triage_rules
  ADD COLUMN IF NOT EXISTS paused_reason text,
  ADD COLUMN IF NOT EXISTS paused_until  timestamptz;

COMMENT ON COLUMN public.triage_rules.paused_reason IS
  'Why the rule is paused. ''plan_limit'' is the only reason today: the '
  'workspace used its Free action allowance. Distinct from disabled_reason, '
  'which is terminal; a paused rule is skipped by the dispatcher until '
  'paused_until and then runs again with no manual action.';

COMMENT ON COLUMN public.triage_rules.paused_until IS
  'When the pause lifts (the next allowance period start). NULL = not paused. '
  'The dispatcher filters on this column itself: now() cannot be part of '
  'triage_rules_due_idx''s predicate.';


-- ---------------------------------------------------------------------------
-- 5. billing_email_sends: workspace-keyed usage emails
--
-- The three usage templates are queued by the mcp-server edge function, per
-- WORKSPACE and per allowance PERIOD, for owners who may have no Stripe
-- customer at all (that is the whole point of a Free allowance). Three
-- changes follow from that:
--
--   workspace_id + period_start   the new idempotency key, enforced by a
--                                 partial unique index so the edge function
--                                 can INSERT ... ON CONFLICT DO NOTHING.
--   stripe_customer_id nullable   with a CHECK that every row is keyed by at
--                                 least one of stripe_customer_id or
--                                 workspace_id. The existing
--                                 (stripe_customer_id, template, scope_key)
--                                 unique index keeps guarding Stripe-keyed
--                                 rows; NULLs are distinct in it, so
--                                 workspace-keyed rows never collide there.
--   category                      re-derived so the three new names are
--                                 transactional. A generated column cannot be
--                                 altered in place; it is dropped and re-added
--                                 with the extended expression. No view, index
--                                 or constraint depends on it (checked with
--                                 pg_depend before writing this).
--
-- Why transactional: "your service is about to stop" is an account-status
-- notice. It needs no opt-in and must not be suppressible, the same rule that
-- keeps a dunning notice out of the unsubscribe list. The category expression
-- is written so that ONLY winback_* is ever marketing; the new names are
-- listed explicitly to make the intent greppable, not because LIKE would have
-- classified them otherwise.
-- ---------------------------------------------------------------------------
ALTER TABLE public.billing_email_sends
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS period_start timestamptz;

COMMENT ON COLUMN public.billing_email_sends.workspace_id IS
  'Set for the workspace-keyed usage emails (usage_warning_80, '
  'usage_limit_reached, automation_paused_limit). NULL for the Stripe-keyed '
  'dunning, card-expiry, cancellation and win-back rows.';

COMMENT ON COLUMN public.billing_email_sends.period_start IS
  'The allowance period the usage email is about (workspace_action_allowance().'
  'period_start at queue time). With workspace_id and template it is the '
  'idempotency key: one email per workspace per template per period.';

ALTER TABLE public.billing_email_sends
  ALTER COLUMN stripe_customer_id DROP NOT NULL;

ALTER TABLE public.billing_email_sends
  DROP CONSTRAINT IF EXISTS billing_email_sends_keyed;
ALTER TABLE public.billing_email_sends
  ADD CONSTRAINT billing_email_sends_keyed
    CHECK (stripe_customer_id IS NOT NULL OR workspace_id IS NOT NULL);

-- The template allow-list. Same nine as 20260902130000 plus the three usage
-- templates. Reclassifying or renaming a template means editing this CHECK
-- and the category expression below in the same migration.
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
    'usage_warning_80', 'usage_limit_reached', 'automation_paused_limit'
  ));

-- DERIVED, never written. The table is small (dunning rows only, 180-day
-- retention), so the rewrite a STORED generated column implies is cheap.
ALTER TABLE public.billing_email_sends DROP COLUMN IF EXISTS category;
ALTER TABLE public.billing_email_sends
  ADD COLUMN category text GENERATED ALWAYS AS (
    CASE
      WHEN template LIKE 'winback\_%' THEN 'marketing'
      WHEN template IN ('usage_warning_80', 'usage_limit_reached', 'automation_paused_limit')
        THEN 'transactional'
      ELSE 'transactional'
    END
  ) STORED;

COMMENT ON COLUMN public.billing_email_sends.category IS
  'GENERATED, never written. Only winback_* is marketing; everything else, '
  'including the usage_* and automation_paused_limit notices, is a '
  'transactional service message that must NOT be suppressible. Reclassifying '
  'a template requires editing the CHECK on template in the same migration.';

-- THE idempotency guarantee for workspace-keyed rows: one (workspace, template,
-- period) is queued once. Partial, so the Stripe-keyed rows (workspace_id
-- NULL) are not in it and the edge function can name it in ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS billing_email_sends_workspace_template_period_idx
  ON public.billing_email_sends (workspace_id, template, period_start)
  WHERE workspace_id IS NOT NULL;

COMMENT ON TABLE public.billing_email_sends IS
  'Queue and send ledger for lifecycle email: billing (dunning, card expiry, '
  'cancellation save, win-back), keyed by Stripe customer, and the Free '
  'allowance notices (usage_warning_80, usage_limit_reached, '
  'automation_paused_limit), keyed by workspace and period. Rows are '
  'materialised at trigger time with their own send_after; the dispatcher only '
  'claims due rows. Idempotency: UNIQUE (stripe_customer_id, template, '
  'scope_key) for Stripe rows, UNIQUE (workspace_id, template, period_start) '
  'for workspace rows. See 20260902130000 and 20260912200000.';


-- ---------------------------------------------------------------------------
-- 6. Grants
--
-- SECURITY DEFINER plus Supabase's default EXECUTE-to-PUBLIC would let a
-- browser session read any workspace's usage by id over /rest/v1/rpc. The
-- dashboard reaches this through a server route holding the service role.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.workspace_action_allowance(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_action_allowance(uuid) TO service_role;
