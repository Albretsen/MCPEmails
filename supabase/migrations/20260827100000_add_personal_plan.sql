-- ===========================================================================
-- Add the `personal` billing plan (display name "Personal", $5/mo, $48/yr,
-- 3 connected inboxes, 1 member). It sits between `free` and `solo` in the
-- ladder.
--
-- NAMING TRAP, restated here because every future reader hits it:
--   id `solo`     is sold as "Pro"
--   id `pro`      is sold as "Team"
--   id `personal` is the first id whose display name matches it.
-- Nothing about free / solo / pro / enterprise is changed by this migration.
--
-- Forward-only: every object below is dropped and recreated, or replaced. No
-- previously applied migration file is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. workspaces.plan CHECK constraint  (THE HARD BLOCKER)
--
-- Added by 20260526000004 as `workspaces_plan_check` over
-- ('free','solo','pro','enterprise'). Until 'personal' is allowed here the
-- Stripe webhook cannot project the entitlement onto the workspace, so a paid
-- Personal checkout takes the customer's money and then fails silently on the
-- write-back.
-- ---------------------------------------------------------------------------
ALTER TABLE public.workspaces DROP CONSTRAINT IF EXISTS workspaces_plan_check;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_plan_check
    CHECK (plan IN ('free', 'personal', 'solo', 'pro', 'enterprise'));


-- ---------------------------------------------------------------------------
-- 2. product_funnel_events.category CHECK constraint
--
-- Current definition is 20260813100000 (which itself replaced the one from
-- 20260805010000). Reproduced verbatim with three additions:
--   'personal_month' / 'personal_year' : the plan+interval a checkout targeted
--   'personal'                         : the plan a user was on when a paywall
--                                        or portal event fired
-- The stage and error_category constraints are untouched: neither enumerates
-- plan ids.
--
-- Without this, `record_usage_limit_event` (section 3) would raise 23514 on
-- every Personal paywall hit, and because its whole body is one transaction
-- the abort would roll back the usage_limit_events row alongside it.
-- ---------------------------------------------------------------------------
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
    'pricing_page', 'dashboard_billing'
  ));


-- ---------------------------------------------------------------------------
-- 3. record_usage_limit_event()
--
-- Current definition is 20260819160000 (which fixed the uuid/bigint return bug
-- in 20260819150000). Body reproduced unchanged except for the category
-- narrowing, which listed only ('solo','pro') and therefore filed every
-- Personal customer's cap rejection under 'free' -- making a paying tier look
-- like churnless free usage in the funnel.
--
-- The ELSE 'free' fallback is kept deliberately: it is the guard that keeps an
-- unrecognised plan id from violating the category constraint and aborting the
-- metering insert with it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_usage_limit_event(
  p_workspace_id  uuid,
  p_plan          text,
  p_used_actions  integer,
  p_cap           integer,
  p_meter_version integer,
  p_period_start  timestamptz
)
RETURNS TABLE (funnel_row_written boolean)
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

  GET DIAGNOSTICS v_funnel_rows = ROW_COUNT;
  RETURN QUERY SELECT v_funnel_rows > 0;
END;
$$;

COMMENT ON FUNCTION public.record_usage_limit_event(uuid, text, integer, integer, integer, timestamptz) IS
  'Records one action-cap rejection. Always appends to usage_limit_events; appends the paywall_reached funnel row at most once per workspace per billing period.';

REVOKE ALL ON FUNCTION public.record_usage_limit_event(uuid, text, integer, integer, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_usage_limit_event(uuid, text, integer, integer, integer, timestamptz) TO service_role;


-- ---------------------------------------------------------------------------
-- 4. growth_revenue_counts()
--
-- Defined in 20260813170000_growth_active_workspaces.sql. `paying_workspaces`
-- and `paying_owners` filtered on plan IN ('solo','pro'), so a Personal
-- customer would have been invisible in the headline paying figure -- the same
-- class of under-count the comped-is-not-paid note in that file warns about,
-- in the opposite direction.
--
-- Also adds `paying_personal` beside the existing per-tier counters. The
-- existing names are load-bearing and keep their exact meanings:
--   paying_solo  = plan 'solo'  (sold as "Pro")
--   paying_scale = plan 'pro'   (sold as "Team")
-- Appended at the end rather than inserted, so any positional consumer of the
-- result keeps working.
--
-- DROP before CREATE: the return column list changes, and CREATE OR REPLACE
-- cannot alter a function's return type (42P13).
--
-- growth_active_workspaces() in the same file needs no change: it selects
-- w.plan through generically and does not enumerate plan ids.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.growth_revenue_counts();

CREATE FUNCTION public.growth_revenue_counts()
RETURNS TABLE (
  paying_workspaces int,
  paying_owners int,
  comped_workspaces int,
  comped_owners int,
  free_workspaces int,
  paying_solo int,
  paying_scale int,
  paying_personal int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH scoped AS (
    SELECT
      w.id,
      w.owner_id,
      coalesce(w.plan, 'free') AS plan,
      -- See the note on growth_active_workspaces: a NULL here would make every
      -- `NOT is_comped` filter below drop the account instead of counting it.
      coalesce(e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now()), false) AS is_comped
    FROM public.workspaces w
    LEFT JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
    WHERE w.deleted_at IS NULL
  )
  SELECT
    count(*) FILTER (WHERE plan IN ('personal', 'solo', 'pro') AND NOT is_comped)::int AS paying_workspaces,
    count(DISTINCT owner_id) FILTER (WHERE plan IN ('personal', 'solo', 'pro') AND NOT is_comped)::int AS paying_owners,
    count(*) FILTER (WHERE is_comped)::int AS comped_workspaces,
    count(DISTINCT owner_id) FILTER (WHERE is_comped)::int AS comped_owners,
    count(*) FILTER (WHERE plan = 'free' AND NOT is_comped)::int AS free_workspaces,
    count(*) FILTER (WHERE plan = 'solo' AND NOT is_comped)::int AS paying_solo,
    count(*) FILTER (WHERE plan = 'pro' AND NOT is_comped)::int AS paying_scale,
    count(*) FILTER (WHERE plan = 'personal' AND NOT is_comped)::int AS paying_personal
  FROM scoped;
$$;

-- Same posture as 20260813170000: SECURITY INVOKER, service-role only. This
-- reads `user_usage_entitlements`, so an accidental grant would leak the
-- customer list. The DROP above discarded the old grants, so restate them.
REVOKE ALL ON FUNCTION public.growth_revenue_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_revenue_counts() TO service_role;


-- ---------------------------------------------------------------------------
-- 5. growth_utilization_bands()  -- NO CHANGE, deliberately.
--
-- Checked against 20260819090000. Its `p_caps` plan->cap map is NOT built in
-- SQL: it is a jsonb argument supplied by the web caller, which builds it from
-- Object.keys(PLANS) in apps/web/src/lib/analytics/growth-queries.ts. Personal
-- therefore inherits its 25000 ceiling automatically once the TypeScript
-- catalogue gains the plan; adding it here would create a second, divergent
-- source of truth for a cap.
--
-- Its two `plan <> 'free'` branches choose the stored Stripe billing period
-- over the calendar month. `'personal' <> 'free'` is already true, so Personal
-- is already treated as paying there. No change.
--
-- 6. The pro > solo > free ranking at 20260606000000:93-94 -- NO CHANGE.
-- That is a one-time backfill INSERT ... ON CONFLICT DO NOTHING that seeded
-- user_billing from pre-existing per-workspace billing on 2026-06-06. It is
-- not a live projection and cannot observe a Personal subscriber, since no
-- workspace carried plan 'personal' before this migration. The live projection
-- of user_billing.plan onto workspaces.plan happens in the Stripe webhook, in
-- application code. user_billing.plan is plain text with no CHECK, so it
-- accepts 'personal' as-is.
-- ---------------------------------------------------------------------------
