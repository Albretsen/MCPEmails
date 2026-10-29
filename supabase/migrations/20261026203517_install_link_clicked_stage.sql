-- ============================================================
-- install_link_clicked funnel stage (2026-10-26, onboarding WP-D)
--
-- The dashboard client guide now leads with a one-click install button
-- (Add to Claude, Add to Cursor, Install in VS Code), built by
-- apps/web/src/lib/clients/install-links.mjs. A click writes one
-- product_funnel_events row through POST /api/analytics/activation-event:
-- stage 'install_link_clicked', category = the client id, outcome 'success'.
-- Every client id is already allowed by the category CHECK.
--
-- ADDITIVE: reads the live constraint and appends, the same helper as
-- 20261026191717_onboarding_measurement.sql, so stages other branches added
-- survive. self-host/db/00-schema.sql is not touched: product_funnel_events
-- is hosted-only there and mcp-server never writes this stage.
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
  ARRAY['install_link_clicked']);

DROP FUNCTION pg_temp.mcpe_extend_in_check(regclass, text, text, text[]);
