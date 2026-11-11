-- ============================================================
-- Monthly "your Free actions reset" email: the cron poke, and the funnel
-- category for its 3-month pass line.
--
-- WHAT THE EMAIL IS. apps/web/src/lib/email/free-reset-email.ts: owners of
-- metered Free workspaces refused by the monthly action allowance on 2+
-- distinct days last month, once per owner per month, 20% holdout. Ledger
-- rows go to lifecycle_email_sends (template 'free_reset', trigger_key
-- 'YYYY-MM'), whose status list already has 'holdout'
-- (20261024190500_activation_help_emails.sql). Nothing new there.
--
-- 1. public.dispatch_free_reset_email() posts to
--    /api/internal/free-reset-email/dispatch with the Vault dispatch_secret,
--    built from Vault app_base_url exactly like every dispatcher since
--    20261026175000_dispatch_urls_from_vault.sql. Empty body: the route picks
--    its own work.
-- 2. cron job dispatch-free-reset-email: the 2nd of each month at 07:05,
--    09:05 and 11:05 UTC. The later two only pick up what the first left
--    (ledger-idempotent). The route itself does nothing until
--    LIFECYCLE_EXPANSION_START_AT is set and in the past, and sends nothing
--    until LIFECYCLE_EXPANSION_DRY_RUN=false.
-- 3. product_funnel_events.category gains 'free_reset_email' (the pass line
--    in this email writes pass_offer_shown with it). Append only: the current
--    list is read and unioned, never restated.
-- ============================================================

CREATE OR REPLACE FUNCTION public.dispatch_free_reset_email()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault', 'extensions'
AS $function$
DECLARE
  v_url    text := public._app_base_url() || '/api/internal/free-reset-email/dispatch';
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
    RAISE WARNING 'dispatch_free_reset_email: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_free_reset_email: Vault secret "app_base_url" is not set, skipping.';
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

COMMENT ON FUNCTION public.dispatch_free_reset_email() IS
  'Posts to the Next.js Free reset email dispatcher on the 2nd of each month (cron job dispatch-free-reset-email). The route does nothing until LIFECYCLE_EXPANSION_START_AT is set and past.';

REVOKE EXECUTE ON FUNCTION public.dispatch_free_reset_email() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_free_reset_email() TO service_role;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-free-reset-email') THEN
    PERFORM cron.unschedule('dispatch-free-reset-email');
  END IF;
END;
$guard$;

SELECT cron.schedule(
  'dispatch-free-reset-email',
  '5 7,9,11 2 * *',
  $$SELECT public.dispatch_free_reset_email()$$
);

-- 3. Funnel vocabulary ---------------------------------------------------------
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
  'public.product_funnel_events'::regclass, 'product_funnel_events_category_check', 'category',
  ARRAY['free_reset_email']);

DROP FUNCTION pg_temp.mcpe_extend_in_check(regclass, text, text, text[]);
