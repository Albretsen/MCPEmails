-- ============================================================
-- Onboarding measurement fixes (2026-10-26, onboarding WP-A)
--
-- These change the baseline the onboarding A/B test is read against, so they
-- ship to everyone before the test starts.
--
--   1. product_funnel_events gains stage 'signup_completed' and the signup
--      method categories 'email', 'google', 'github', 'microsoft'.
--   2. A second AFTER INSERT trigger on auth.users writes one
--      signup_completed row per new account, from the database, for every
--      signup method. The Vercel `signup_completed` event fires in the
--      browser (on the dashboard, from ?signup_method=) and loses most Safari
--      and iOS Google signups. This row is the source of truth for signups by
--      method; the browser event stays only as a convenience.
--   3. Backfill: one signup_completed row per existing account, dated the
--      account's first workspace.
--   4. Correct the activation markers that an empty inbox_list (or another
--      call that succeeds with no inbox) wrote for workspaces that had no
--      mailbox yet. mcp-server stops writing them in the same change
--      (markFirstProductUse / countsAsFirstProductUse). The old values are
--      kept in activation_marker_corrections_20261026.
--   5. Document how automation-runner calls are told apart in activity_log,
--      on the retention queries themselves.
--
-- WHY A SECOND TRIGGER INSTEAD OF EDITING handle_new_user(). That function
-- has no ALTER and other branches redefine it whole (acquisition sources,
-- referrals); copying it here would race them. Triggers of the same timing
-- fire in name order, and 'on_auth_user_created' sorts before
-- 'on_auth_user_created_signup_completed', so the workspace already exists
-- when this one runs.
--
-- self-host/db/00-schema.sql is not touched: product_funnel_events is a
-- hosted-only table there, and mcp-server writes none of the new values.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. Vocabulary. ADDITIVE: reads the live constraint and appends, the same
--    helper as 20261025090000_referrals.sql, so stages and categories other
--    branches added survive.
-- ---------------------------------------------------------------------------
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
  ARRAY['signup_completed']);

SELECT pg_temp.mcpe_extend_in_check(
  'public.product_funnel_events'::regclass, 'product_funnel_events_category_check', 'category',
  ARRAY['email', 'google', 'github', 'microsoft']);

DROP FUNCTION pg_temp.mcpe_extend_in_check(regclass, text, text, text[]);


-- ---------------------------------------------------------------------------
-- 2. signup_completed, written by the database
--
-- The method is the auth provider GoTrue stamps on the new user:
-- 'email' (password signup, invites, magic links), 'google', 'github', and
-- 'azure' for Microsoft. Anything else, or nothing, is 'unknown'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.signup_method_category(p_provider text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE lower(coalesce(p_provider, ''))
    WHEN 'email' THEN 'email'
    WHEN 'google' THEN 'google'
    WHEN 'github' THEN 'github'
    WHEN 'azure' THEN 'microsoft'
    ELSE 'unknown'
  END;
$$;

REVOKE ALL ON FUNCTION public.signup_method_category(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_signup_completed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_workspace_id uuid;
BEGIN
  SELECT w.id INTO v_workspace_id
  FROM public.workspaces w
  WHERE w.owner_id = NEW.id
  ORDER BY w.created_at
  LIMIT 1;

  IF v_workspace_id IS NOT NULL THEN
    INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category, error_category, occurred_at)
    VALUES (
      v_workspace_id, 'signup_completed', 'success',
      public.signup_method_category(NEW.raw_app_meta_data->>'provider'),
      NULL, now()
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A measurement row must never cost us a signup.
  RAISE WARNING 'record_signup_completed failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.record_signup_completed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created_signup_completed ON auth.users;
CREATE TRIGGER on_auth_user_created_signup_completed
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.record_signup_completed();


-- ---------------------------------------------------------------------------
-- 3. Backfill, once per account, dated its first workspace. Idempotent.
-- ---------------------------------------------------------------------------
INSERT INTO public.product_funnel_events (workspace_id, stage, outcome, category, error_category, occurred_at)
SELECT f.id, 'signup_completed', 'success',
       public.signup_method_category(au.raw_app_meta_data->>'provider'),
       NULL, f.created_at
FROM (
  SELECT DISTINCT ON (w.owner_id) w.id, w.owner_id, w.created_at
  FROM public.workspaces w
  ORDER BY w.owner_id, w.created_at
) f
JOIN auth.users au ON au.id = f.owner_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.product_funnel_events e
  WHERE e.workspace_id = f.id AND e.stage = 'signup_completed'
);


-- ---------------------------------------------------------------------------
-- 4. Activation markers written by a call made with no mailbox
--
-- Until this change, markFirstProductUse set analytics_first_tool_used_at,
-- onboarding_technical_activated_at and the first_tool_call /
-- technical_activation funnel rows on the first successful tool call, even
-- when that call was an inbox_list answering an empty list to a workspace
-- that had never connected an inbox. About 2% of signups were "activated"
-- that way, and every read-out built on those markers (activation_segments,
-- growth_activation_funnel, growth_daily_metrics, the growth user views)
-- inherited it. Correcting the rows fixes all of them at once without
-- redefining each function.
--
-- A marker is a no-inbox one when the first tool had no inbox provider and no
-- inbox (live or deleted) existed in the workspace when it was written.
-- The corrected first use is the value-activation time: the first successful
-- call against a real inbox. Without one, the workspace never activated.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.activation_marker_corrections_20261026 (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  old_first_tool_used_at timestamptz,
  old_technical_activated_at timestamptz,
  old_first_tool_name text,
  old_first_tool_provider text,
  old_first_tool_client text,
  old_first_tool_path text,
  old_onboarding_stage text,
  new_first_tool_used_at timestamptz,
  corrected_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.activation_marker_corrections_20261026 ENABLE ROW LEVEL SECURITY;
-- No policy: operators read it with the service role.
COMMENT ON TABLE public.activation_marker_corrections_20261026 IS
  'Activation markers that a tool call with no connected inbox wrote, as they were before migration 20261026191717 corrected them. new_first_tool_used_at is the value-activation time they were moved to, NULL when the workspace never made a call against a real inbox.';

INSERT INTO public.activation_marker_corrections_20261026 (
  workspace_id, old_first_tool_used_at, old_technical_activated_at, old_first_tool_name,
  old_first_tool_provider, old_first_tool_client, old_first_tool_path, old_onboarding_stage,
  new_first_tool_used_at
)
SELECT w.id, w.analytics_first_tool_used_at, w.onboarding_technical_activated_at, w.analytics_first_tool_name,
       w.analytics_first_tool_provider, w.analytics_first_tool_client, w.analytics_first_tool_path, w.onboarding_stage,
       w.onboarding_value_activated_at
FROM public.workspaces w
WHERE w.analytics_first_tool_used_at IS NOT NULL
  AND coalesce(w.analytics_first_tool_provider, 'unknown') = 'unknown'
  AND (w.analytics_first_inbox_connected_at IS NULL
       OR w.analytics_first_inbox_connected_at > w.analytics_first_tool_used_at)
  AND NOT EXISTS (
    SELECT 1 FROM public.inboxes i
    WHERE i.workspace_id = w.id AND i.created_at <= w.analytics_first_tool_used_at
  )
ON CONFLICT (workspace_id) DO NOTHING;

-- Funnel rows first, while the old timestamps are still on hand. The rows
-- markFirstProductUse wrote carry the marker's exact occurred_at.
-- Value-activated later: move both rows to the first real call.
UPDATE public.product_funnel_events e
SET occurred_at = c.new_first_tool_used_at
FROM public.activation_marker_corrections_20261026 c
WHERE e.workspace_id = c.workspace_id
  AND e.stage IN ('first_tool_call', 'technical_activation')
  AND e.occurred_at = c.old_first_tool_used_at
  AND c.new_first_tool_used_at IS NOT NULL;

-- Never made a real call: the rows record something that did not happen.
DELETE FROM public.product_funnel_events e
USING public.activation_marker_corrections_20261026 c
WHERE e.workspace_id = c.workspace_id
  AND e.stage IN ('first_tool_call', 'technical_activation')
  AND e.occurred_at = c.old_first_tool_used_at
  AND c.new_first_tool_used_at IS NULL;

UPDATE public.workspaces w
SET analytics_first_tool_used_at = c.new_first_tool_used_at,
    onboarding_technical_activated_at = c.new_first_tool_used_at,
    -- The tool name described the no-inbox call; the real first call's name
    -- was never recorded. Client and path still describe the connection
    -- when there was a later real call; without one they are cleared too.
    analytics_first_tool_name = CASE WHEN c.new_first_tool_used_at IS NULL THEN NULL ELSE w.analytics_first_tool_name END,
    analytics_first_tool_provider = CASE WHEN c.new_first_tool_used_at IS NULL THEN NULL ELSE w.analytics_first_tool_provider END,
    analytics_first_tool_client = CASE WHEN c.new_first_tool_used_at IS NULL THEN NULL ELSE w.analytics_first_tool_client END,
    analytics_first_tool_path = CASE WHEN c.new_first_tool_used_at IS NULL THEN NULL ELSE w.analytics_first_tool_path END,
    onboarding_stage = CASE
      WHEN w.onboarding_value_activated_at IS NOT NULL THEN 'value_activation'
      WHEN w.onboarding_credential_issued_at IS NOT NULL THEN 'credential_issued'
      WHEN w.onboarding_inbox_connected_at IS NOT NULL THEN 'inbox_connected'
      WHEN w.onboarding_client_selected_at IS NOT NULL THEN 'client_selected'
      ELSE 'started'
    END
FROM public.activation_marker_corrections_20261026 c
WHERE w.id = c.workspace_id
  AND w.analytics_first_tool_used_at IS NOT DISTINCT FROM c.old_first_tool_used_at;


-- ---------------------------------------------------------------------------
-- 5. Automation runs in activity_log
--
-- The unattended automation (triage) runner writes its activity_log rows
-- with user_agent = 'mcp-emails-triage-runner' (mcp-server writeActivityLog,
-- serverAgent). Since 2026-10-20 no client User-Agent is stored, so that is
-- the only non-NULL value written; older rows also hold client agents.
-- A user-initiated call is therefore:
--   coalesce(user_agent, '') <> 'mcp-emails-triage-runner'
-- action_usage has no such marker: read retention from activity_log.
-- None of the retention functions below apply the filter today; a read-out
-- that must not reward a single automation (week-4 retention in the
-- onboarding test) adds it.
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN public.activity_log.user_agent IS
  'Fixed server marker, never a client header (client agents are not stored since 2026-10-20). ''mcp-emails-triage-runner'' marks an unattended automation run; user-initiated calls are coalesce(user_agent, '''') <> ''mcp-emails-triage-runner''.';

DO $$
DECLARE
  f regprocedure;
  note constant text := ' Automation runs: activity_log rows with user_agent = ''mcp-emails-triage-runner'' are unattended automation runs and are counted here. For user-initiated activity add coalesce(user_agent, '''') <> ''mcp-emails-triage-runner''.';
  existing text;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('growth_cohort_retention', 'growth_retention_curve', 'experiment_stats',
                        'growth_active_workspaces', 'growth_engagement_bands')
  LOOP
    existing := obj_description(f::oid, 'pg_proc');
    IF existing IS NULL OR position('mcp-emails-triage-runner' IN existing) = 0 THEN
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', f, coalesce(existing, '') || note);
    END IF;
  END LOOP;
END
$$;
