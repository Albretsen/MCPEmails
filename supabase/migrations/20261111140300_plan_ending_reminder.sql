-- ============================================================================
-- Plan-ending reminder: one factual email 4 to 6 days before a scheduled stop,
-- with "Keep my plan" and "Pause instead" links to the billing page.
-- Code: apps/web/src/lib/billing/plan-ending-reminder.ts.
--
--   1. billing_email_sends.template gains 'plan_ending_5d' (transactional:
--      the GENERATED category only marks winback_* as marketing). One row per
--      subscription and stop date, scope_key '<sub id>:<stop unix seconds>',
--      on the existing (stripe_customer_id, template, scope_key) unique
--      index. Holdout rows are inserted cancelled with cancel_reason
--      'holdout', so the index dedupes both arms.
--   2. product_funnel_events vocabulary: stages plan_ending_reminder_sent,
--      plan_ending_reminder_holdout, plan_kept; entry_point values
--      plan_ending_email, cancel_email, billing_page (plan_kept and
--      pause_started carry where the click came from).
--   3. The experiment 'plan_ending_reminder', 50/50, unit = the Stripe
--      subscription (subject id = first 32 hex of sha256('plan_ending:' ||
--      sub id)). Seeded 'running': PLAN_ENDING_REMINDER_ENABLED=on is what
--      starts assignments; off and dry_run assign nobody.
--   4. public.dispatch_plan_ending_reminder() and a daily pg_cron job
--      (08:15 UTC) that posts to /api/internal/plan-ending-reminder. The
--      route returns at once while the flag is off.
--
-- Append-only and re-runnable: every CHECK is extended from its live
-- definition, never restated.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1 + 2. CHECK vocabularies, append-only.
-- Same helper as 20261026233917_onboarding_flow_b.sql: reads the values the
-- live constraint allows, unions the additions, keeps an `IS NULL OR` arm if
-- the constraint had one. A missing constraint is left missing.
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
    RAISE NOTICE '% does not exist, values not added.', p_constraint;
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
  'public.billing_email_sends'::regclass, 'billing_email_sends_template_check', 'template',
  ARRAY['plan_ending_5d']);

SELECT pg_temp.mcpe_extend_in_check(
  'public.product_funnel_events'::regclass, 'product_funnel_events_stage_check', 'stage',
  ARRAY['plan_ending_reminder_sent', 'plan_ending_reminder_holdout', 'plan_kept']);

SELECT pg_temp.mcpe_extend_in_check(
  'public.product_funnel_events'::regclass, 'product_funnel_events_entry_point_check', 'entry_point',
  ARRAY['plan_ending_email', 'cancel_email', 'billing_page']);

DROP FUNCTION pg_temp.mcpe_extend_in_check(regclass, text, text, text[]);


-- ---------------------------------------------------------------------------
-- 3. The experiment.
-- ---------------------------------------------------------------------------
INSERT INTO public.experiments (key, name, description, status, variants, started_at)
VALUES (
  'plan_ending_reminder',
  'Plan-ending reminder, 5 days before a scheduled stop',
  'Unit is the Stripe subscription (subject = first 32 hex of sha256(''plan_ending:'' || subscription id)). Eligible: a scheduled stop 4 to 6 days away, not paused, owner not internal or deleted, owner workspace made a successful MCP call in the last 7 days. holdout gets nothing (funnel plan_ending_reminder_holdout); reminder gets plan_ending_5d (funnel plan_ending_reminder_sent). Outcome: plan_kept, pause_started, and whether the subscription renews. Only assigns while PLAN_ENDING_REMINDER_ENABLED=on.',
  'running',
  '[{"id":"holdout","label":"No reminder","weight":50},{"id":"reminder","label":"Plan-ending reminder","weight":50}]'::jsonb,
  now()
)
ON CONFLICT (key) DO NOTHING;


-- ---------------------------------------------------------------------------
-- 4. Daily dispatcher. Same shape as dispatch_first_30_days()
-- (20261026175000_dispatch_urls_from_vault.sql): base URL and secret from
-- Vault, fire-and-forget pg_net post, empty body.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE OR REPLACE FUNCTION public.dispatch_plan_ending_reminder()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  v_url    text := public._app_base_url() || '/api/internal/plan-ending-reminder';
  v_secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret
      INTO v_secret
      FROM vault.decrypted_secrets
     WHERE name = 'dispatch_secret'
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_secret := NULL;
  END;

  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'dispatch_plan_ending_reminder: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_plan_ending_reminder: Vault secret "app_base_url" is not set, skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',      'application/json',
                 'X-Dispatch-Secret', v_secret
               ),
    body    := '{}'::jsonb
  );
END;
$function$;

COMMENT ON FUNCTION public.dispatch_plan_ending_reminder() IS
  'Called by pg_cron daily at 08:15 UTC. Posts to /api/internal/plan-ending-reminder, '
  'which queues plan_ending_5d for subscriptions stopping in 4 to 6 days. '
  'The route does nothing while PLAN_ENDING_REMINDER_ENABLED is off.';

REVOKE ALL ON FUNCTION public.dispatch_plan_ending_reminder() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_plan_ending_reminder() TO service_role;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-plan-ending-reminder') THEN
    PERFORM cron.unschedule('dispatch-plan-ending-reminder');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'dispatch-plan-ending-reminder',
  '15 8 * * *',
  $$SELECT public.dispatch_plan_ending_reminder()$$
);
