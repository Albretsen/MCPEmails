-- ============================================================
-- Connector-first funnel stages (2026-10-26, onboarding WP-G)
--
-- The OAuth consent screen (/authorize) now sends a signed-out visitor to
-- /signup instead of /login, and for workspaces in the new onboarding flow it
-- shows the inbox connect step before the permissions card. Four stages, at
-- most one row each per workspace (apps/web/src/lib/onboarding/authorize-funnel.ts):
--
--   authorize_signup_redirect     a new account made through the signup
--                                 redirect came back to the consent screen
--   authorize_inbox_step_viewed   the inbox step was shown inside consent
--   authorize_inbox_connected     an inbox was connected inside consent
--   authorize_skipped             "Skip, connect later" was pressed
--
-- category = the AI app's chip id (claude, chatgpt, cursor, vscode, ...),
-- 'unknown' when it is not known. Every such value is already allowed.
--
-- ADDITIVE: the same helper as 20261026203517_install_link_clicked_stage.sql
-- reads the live constraint and appends, so stages other branches added
-- survive. self-host/db/00-schema.sql is not touched: product_funnel_events
-- is hosted-only there and mcp-server never writes these stages.
-- ============================================================
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
  ARRAY['authorize_signup_redirect', 'authorize_inbox_step_viewed', 'authorize_inbox_connected', 'authorize_skipped']);

DROP FUNCTION pg_temp.mcpe_extend_in_check(regclass, text, text, text[]);
