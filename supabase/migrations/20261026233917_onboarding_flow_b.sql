-- ============================================================================
-- Onboarding WP-H: Flow B, the three calm payment moments (plan section 5,
-- Documents/plans/onboarding-research-20261026.md). Gated on onb_convert = on
-- (v1: internal accounts only, apps/web/src/lib/onboarding/variant.ts).
--
--   1. workspaces.plan_summary_dismissed_at   B2: the plan summary card's X
--      workspaces.grace_end_note_seen_at      B3a: the grace-end note's X
--      Both are rewound by Settings > Reset onboarding (internal accounts).
--   2. onboarding_convert_on(workspace): the same gate the web uses, readable
--      by mcp-server. An internal owner (growth_is_internal_email), or a
--      stored onb_convert = 'on' assignment, or a concluded experiment whose
--      winner is 'on'.
--   3. claim_usage_meter_note(workspace, level, period_start): mcp-server's
--      one short usage line at 80% and 100% (B3b). True on exactly one call
--      per workspace, level and billing period, and only when convert is on.
--      The claim IS the funnel row (usage_meter_shown, category chat_<level>).
--   4. usage_month_summary(workspace, since): B3c. What the workspace got done
--      this period (reads, drafts, sends), counted off action_usage, for the
--      cap refusal. Empty counts unless convert is on.
--   5. product_funnel_events vocabulary, append-only:
--        stages     second_inbox_prompt_shown, second_inbox_prompt_clicked,
--                   plan_summary_shown, plan_summary_dismissed,
--                   plan_summary_clicked, usage_meter_shown,
--                   grace_end_note_shown
--        categories surface_onboarding, surface_overview,
--                   level_50, level_80, level_100, chat_80, chat_100
--        entry_point second_inbox (the dashboard connect modal opened from
--                   the onboarding "Connect your other inbox" card)
--
-- self-host/db/00-schema.sql gains stubs for the two functions mcp-server
-- calls (claim answers false, the summary answers nothing). Forward-only and
-- re-runnable.
-- ============================================================================

-- 1. Dismissal stamps ------------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS plan_summary_dismissed_at timestamptz,
  ADD COLUMN IF NOT EXISTS grace_end_note_seen_at timestamptz;

COMMENT ON COLUMN public.workspaces.plan_summary_dismissed_at IS
  'Onboarding B2: when the plan summary card was dismissed (X or Continue on Free). Never shown again after this.';
COMMENT ON COLUMN public.workspaces.grace_end_note_seen_at IS
  'Onboarding B3a: when the one in-product grace-end note was dismissed.';

-- 2. The convert gate -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.onboarding_convert_on(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.workspaces w
      JOIN public.users u ON u.id = w.owner_id
     WHERE w.id = p_workspace_id
       AND w.deleted_at IS NULL
       AND (
         public.growth_is_internal_email(u.email)
         OR EXISTS (
           SELECT 1 FROM public.experiment_assignments a
            WHERE a.experiment_key = 'onb_convert'
              AND a.subject_id = replace(w.id::text, '-', '')
              AND a.variant_id = 'on'
         )
         OR EXISTS (
           SELECT 1 FROM public.experiments e
            WHERE e.key = 'onb_convert'
              AND e.status = 'concluded'
              AND e.winner_variant_id = 'on'
         )
       )
  );
$$;

COMMENT ON FUNCTION public.onboarding_convert_on(uuid) IS
  'Onboarding Flow B gate for server code without the web helper: internal owner, a stored onb_convert=on assignment, or a concluded experiment won by on.';

REVOKE ALL ON FUNCTION public.onboarding_convert_on(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.onboarding_convert_on(uuid) TO service_role;

-- 3. The usage line in tool results -------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_usage_meter_note(
  p_workspace_id uuid,
  p_level integer,
  p_period_start timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_category text;
BEGIN
  IF p_level NOT IN (80, 100) OR p_period_start IS NULL THEN
    RETURN false;
  END IF;
  IF NOT public.onboarding_convert_on(p_workspace_id) THEN
    RETURN false;
  END IF;
  v_category := 'chat_' || p_level::text;
  -- One claim at a time per workspace, so two concurrent calls cannot both
  -- see "not yet" and both say it.
  PERFORM pg_advisory_xact_lock(hashtextextended('usage_meter_note:' || p_workspace_id::text, 0));
  IF EXISTS (
    SELECT 1 FROM public.product_funnel_events
     WHERE workspace_id = p_workspace_id
       AND stage = 'usage_meter_shown'
       AND category = v_category
       AND occurred_at >= p_period_start
  ) THEN
    RETURN false;
  END IF;
  INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category)
  VALUES (p_workspace_id, 'usage_meter_shown', 'success', v_category);
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.claim_usage_meter_note(uuid, integer, timestamptz) IS
  'mcp-server: claim the one short usage line at 80% or 100% of the Free allowance for this period. True only for the call that wrote the usage_meter_shown row. Flow B (onb_convert = on) only.';

REVOKE ALL ON FUNCTION public.claim_usage_meter_note(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_usage_meter_note(uuid, integer, timestamptz) TO service_role;

-- 4. What they got done this month ---------------------------------------------------
-- Tool names are the metered operation names mcp-server writes to
-- action_usage (BILLABLE_TOOL_NAMES). Counts only, no content.
CREATE OR REPLACE FUNCTION public.usage_month_summary(p_workspace_id uuid, p_since timestamptz)
RETURNS TABLE (reads integer, drafts integer, sends integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    count(*) FILTER (WHERE au.tool_name IN ('email_read', 'email_read_batch', 'email_extract', 'email_original'))::integer,
    count(*) FILTER (WHERE au.tool_name IN ('draft_create', 'draft_reply', 'draft_update'))::integer,
    count(*) FILTER (WHERE au.tool_name IN ('email_send', 'email_reply', 'email_forward', 'draft_send'))::integer
  FROM public.action_usage au
  WHERE au.workspace_id = p_workspace_id
    AND au.billable
    AND au.occurred_at >= p_since
    AND public.onboarding_convert_on(p_workspace_id);
$$;

COMMENT ON FUNCTION public.usage_month_summary(uuid, timestamptz) IS
  'mcp-server cap refusal (Flow B): reads, drafts and sends since the period start. Zeros unless onboarding_convert_on.';

REVOKE ALL ON FUNCTION public.usage_month_summary(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.usage_month_summary(uuid, timestamptz) TO service_role;

-- 5. Funnel vocabulary ----------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.mcpe_extend_in_check(
  p_table regclass,
  p_constraint text,
  p_column text,
  p_values text[]
) RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  def      text;
  existing text[];
  merged   text[];
  nullable boolean;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  WHERE c.conname = p_constraint AND c.conrelid = p_table;

  IF def IS NULL THEN
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT s ORDER BY s) INTO existing
  FROM (
    SELECT m[1] AS s FROM regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') AS m
    UNION
    SELECT trim(both '"' from x) FROM regexp_matches(def, '''\{([^}]*)\}''', 'g') AS a,
      unnest(string_to_array(a[1], ',')) AS x
  ) found
  WHERE s ~ '^[a-z0-9_]+$';

  IF existing IS NULL OR array_length(existing, 1) IS NULL THEN
    RAISE EXCEPTION '% has no readable value list: %', p_constraint, def;
  END IF;

  IF p_values <@ existing THEN
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT v ORDER BY v) INTO merged
  FROM unnest(existing || p_values) AS v;

  nullable := def ILIKE '%' || p_column || ' IS NULL%';

  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', p_table, p_constraint);
  EXECUTE format(
    'ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s%I IN (%s))',
    p_table,
    p_constraint,
    CASE WHEN nullable THEN format('%I IS NULL OR ', p_column) ELSE '' END,
    p_column,
    (SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(merged) AS v)
  );
END
$fn$;

SELECT pg_temp.mcpe_extend_in_check(
  'public.product_funnel_events'::regclass, 'product_funnel_events_stage_check', 'stage',
  ARRAY['second_inbox_prompt_shown', 'second_inbox_prompt_clicked',
        'plan_summary_shown', 'plan_summary_dismissed', 'plan_summary_clicked',
        'usage_meter_shown', 'grace_end_note_shown']);

SELECT pg_temp.mcpe_extend_in_check(
  'public.product_funnel_events'::regclass, 'product_funnel_events_category_check', 'category',
  ARRAY['surface_onboarding', 'surface_overview',
        'level_50', 'level_80', 'level_100', 'chat_80', 'chat_100']);

SELECT pg_temp.mcpe_extend_in_check(
  'public.product_funnel_events'::regclass, 'product_funnel_events_entry_point_check', 'entry_point',
  ARRAY['second_inbox']);

DROP FUNCTION pg_temp.mcpe_extend_in_check(regclass, text, text, text[]);
