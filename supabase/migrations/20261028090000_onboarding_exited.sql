-- ============================================================================
-- Setup dialog: record when someone closes it.
-- 20261028090000_onboarding_exited
--
-- Closing the dialog (X, Skip or Escape) left no row, so on the first day of
-- the onb_flow test no enrolled workspace had finished it, and the read-out
-- could not tell a closed dialog from a step that failed to move on. The API
-- logs showed two of the four workspaces that made a first call had closed the
-- dialog on the wait step, 7 and 35 seconds in, before that call landed.
--
--   1. product_funnel_events stage gains onboarding_exited, category = the
--      step it was closed on (step_*). Append-only, same block as
--      20261026152301.
--   2. growth_onboarding_steps counts it, so the band shows where the dialog
--      is closed. Same return type, so CREATE OR REPLACE; only the stage list
--      changes from 20261027213000.
--
-- mcp-server reads none of this, so self-host/db/00-schema.sql is unchanged.
-- Forward-only, re-runnable, one transaction. Apply with
-- `npx supabase db query --linked -f` and `migration repair` (never db push).
-- ============================================================================

BEGIN;

-- 1. Funnel vocabulary --------------------------------------------------------
DO $funnel$
DECLARE
  target   record;
  v_def    text;
  v_values text[];
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('product_funnel_events_stage_check', 'stage', ARRAY['onboarding_exited'])
    ) AS t(conname, col, additions)
  LOOP
    SELECT pg_get_constraintdef(c.oid)
      INTO v_def
      FROM pg_constraint c
     WHERE c.conrelid = 'public.product_funnel_events'::regclass
       AND c.conname = target.conname
       AND c.contype = 'c';

    IF v_def IS NULL THEN
      RAISE NOTICE '% does not exist, onboarding values not added.', target.conname;
      CONTINUE;
    END IF;

    IF v_def !~ ('^CHECK \(\(' || target.col || ' = ANY \(') THEN
      RAISE EXCEPTION '% is not a plain list, not rewritten: %', target.conname, v_def;
    END IF;

    SELECT array_agg(u.v ORDER BY t.n, u.k)
      INTO v_values
      FROM regexp_matches(v_def, '''((?:[^'']|'''')*)''(::text\[\])?', 'g') WITH ORDINALITY AS t(m, n)
      CROSS JOIN LATERAL unnest(
             CASE WHEN t.m[2] IS NULL
                  THEN ARRAY[replace(t.m[1], '''''', '''')]
                  ELSE replace(t.m[1], '''''', '''')::text[]
             END
           ) WITH ORDINALITY AS u(v, k);

    IF v_values IS NULL OR cardinality(v_values) = 0 THEN
      RAISE EXCEPTION '% has no readable values: %', target.conname, v_def;
    END IF;

    IF target.additions <@ v_values THEN
      CONTINUE;
    END IF;

    SELECT v_values || coalesce(array_agg(a.v ORDER BY a.n), ARRAY[]::text[])
      INTO v_values
      FROM unnest(target.additions) WITH ORDINALITY AS a(v, n)
     WHERE a.v <> ALL (v_values);

    EXECUTE format('ALTER TABLE public.product_funnel_events DROP CONSTRAINT %I', target.conname);
    EXECUTE format(
      'ALTER TABLE public.product_funnel_events ADD CONSTRAINT %I CHECK (%I = ANY (ARRAY[%s]))',
      target.conname,
      target.col,
      (SELECT string_agg(quote_literal(x.v) || '::text', ', ' ORDER BY x.n)
         FROM unnest(v_values) WITH ORDINALITY AS x(v, n))
    );
  END LOOP;
END;
$funnel$;

-- 2. The band counts it ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_onboarding_steps(
  p_internal_emails  text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
RETURNS TABLE (
  flow       text,
  convert    text,
  stage      text,
  category   text,
  workspaces bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH enrolled AS (
    SELECT w.id,
           COALESCE(f.variant_id, 'control') AS flow,
           COALESCE(c.variant_id, 'off') AS convert
    FROM public.workspaces w
    LEFT JOIN public.users u ON u.id = w.owner_id
    LEFT JOIN public.experiment_assignments f
      ON f.experiment_key = 'onb_flow' AND f.subject_id = replace(w.id::text, '-', '')
    LEFT JOIN public.experiment_assignments c
      ON c.experiment_key = 'onb_convert' AND c.subject_id = replace(w.id::text, '-', '')
    WHERE (f.subject_id IS NOT NULL OR c.subject_id IS NOT NULL)
      AND NOT public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains)
  )
  SELECT e.flow, e.convert, p.stage, p.category, count(DISTINCT p.workspace_id)
  FROM enrolled e
  JOIN public.product_funnel_events p ON p.workspace_id = e.id
  WHERE p.stage IN (
    'onboarding_step_viewed', 'onboarding_completed', 'onboarding_exited',
    'second_inbox_prompt_shown', 'second_inbox_prompt_clicked',
    'plan_summary_shown', 'plan_summary_dismissed', 'plan_summary_clicked',
    'usage_meter_shown', 'grace_end_note_shown'
  )
  GROUP BY GROUPING SETS ((e.flow, e.convert, p.stage, p.category), (e.flow, e.convert, p.stage))
  ORDER BY 1, 2, 3, 4 NULLS FIRST;
$$;

REVOKE ALL ON FUNCTION public.growth_onboarding_steps(text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_onboarding_steps(text[], text[]) TO service_role;

COMMIT;
