-- ============================================================================
-- Onboarding WP-E: app_password_link_clicked (plan section 3, A4).
--
-- The onboarding inbox step shows each provider's steps up front, with an
-- external link per step ("Open 2-Step Verification", "Create app password").
-- One funnel row per click, so "never went to Google" can be told apart from
-- "went and got stuck" (report 33). Written from the browser through
-- POST /api/analytics/activation-event (lib/analytics/activation-events.ts).
--
--   stage        app_password_link_clicked
--   category     the provider panel; adds aol, gmx, web_de (panels the
--                dashboard modal never had)
--   entry_point  which link: two_step, app_passwords, imap_setting,
--                account_security, admin_consent
--
-- ADDITIVE: reads each live constraint and appends (same helper as
-- 20261026191717), so values other branches added survive. mcp-server writes
-- none of these, so self-host/db/00-schema.sql is unchanged. Re-runnable.
-- ============================================================================

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
  ARRAY['app_password_link_clicked']);

SELECT pg_temp.mcpe_extend_in_check(
  'public.product_funnel_events'::regclass, 'product_funnel_events_category_check', 'category',
  ARRAY['aol', 'gmx', 'web_de']);

SELECT pg_temp.mcpe_extend_in_check(
  'public.product_funnel_events'::regclass, 'product_funnel_events_entry_point_check', 'entry_point',
  ARRAY['two_step', 'app_passwords', 'imap_setting', 'account_security', 'admin_consent']);

DROP FUNCTION pg_temp.mcpe_extend_in_check(regclass, text, text, text[]);
