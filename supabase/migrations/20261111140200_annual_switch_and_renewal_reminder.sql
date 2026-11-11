-- ============================================================================
-- Annual switch card + annual renewal reminder (2026-11-11).
--
--   1. workspaces.annual_switch_dismissed_at / annual_switch_dismiss_count
--      The dismissible "switch to annual" notice on the Overview, per
--      workspace. A dismissed notice may come back ONCE, 60 days after the
--      first dismissal; after the second dismissal it stays hidden. The card
--      on the billing page ignores both columns (it is permanent).
--   2. product_funnel_events stage vocabulary: annual_switch_shown,
--      annual_switch_clicked, annual_switch_completed. Categories already
--      exist (dashboard_billing, surface_overview, personal_year, solo_year,
--      pro_year) and are unioned in anyway, so the file does not depend on
--      which earlier migration added them.
--   3. billing_email_sends.template gains 'annual_renewal_30': the service
--      notice 30 days before an annual subscription renews. Keyed on the
--      Stripe customer with scope_key '<sub id>:<period end unix seconds>',
--      so the existing UNIQUE (stripe_customer_id, template, scope_key) makes
--      "one per subscription and period" a database property. Transactional
--      by the generated `category` rule (only winback_% is marketing).
--   4. public.dispatch_annual_renewal_reminder() + a daily pg_cron job. Posts
--      to /api/internal/annual-renewal-reminder/dispatch only when some
--      user_billing row looks like an annual subscription renewing in 27 to
--      30 days. The route reads Stripe and decides; this only avoids calling
--      it on the ~360 days a year nothing is due.
--
-- Both product surfaces are dark by default: ANNUAL_SWITCH_CARD_ENABLED and
-- ANNUAL_RENEWAL_REMINDER_ENABLED are 'off' unless set. With the reminder
-- flag off the route answers `skipped` and writes nothing.
--
-- Forward-only and re-runnable.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Notice dismissal, per workspace.
--
-- Written by POST /api/billing/annual-switch through the service role only.
-- public.workspaces holds no table-level UPDATE for anon/authenticated
-- (20261016160100_workspaces_server_owned_writes.sql), so the columns are
-- server-owned without extra grants.
-- ---------------------------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS annual_switch_dismissed_at timestamptz,
  ADD COLUMN IF NOT EXISTS annual_switch_dismiss_count smallint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.workspaces.annual_switch_dismissed_at IS
  'Last time the owner dismissed the Overview "switch to annual" notice. The notice may return once, 60 days after the first dismissal.';
COMMENT ON COLUMN public.workspaces.annual_switch_dismiss_count IS
  'How many times the Overview "switch to annual" notice was dismissed. At 2 it never returns.';


-- ---------------------------------------------------------------------------
-- 2. product_funnel_events stage and category vocabulary, append-only.
--
-- Same block as 20261025010000_personal_pass.sql section 4: read the live
-- list, add what is missing, re-add the constraint with the union. Never a
-- restated list. A missing constraint is left missing.
-- ---------------------------------------------------------------------------
DO $funnel$
DECLARE
  target   record;
  v_def    text;
  v_values text[];
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('product_funnel_events_stage_check', 'stage', ARRAY[
        'annual_switch_shown', 'annual_switch_clicked', 'annual_switch_completed'
      ]),
      ('product_funnel_events_category_check', 'category', ARRAY[
        'dashboard_billing', 'surface_overview',
        'personal_year', 'solo_year', 'pro_year'
      ])
    ) AS t(conname, col, additions)
  LOOP
    SELECT pg_get_constraintdef(c.oid)
      INTO v_def
      FROM pg_constraint c
     WHERE c.conrelid = 'public.product_funnel_events'::regclass
       AND c.conname = target.conname
       AND c.contype = 'c';

    IF v_def IS NULL THEN
      RAISE NOTICE '% does not exist, annual switch values not added.', target.conname;
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


-- ---------------------------------------------------------------------------
-- 3. billing_email_sends template allow-list, append-only.
--
-- Same block as 20261025010100 section 1.
-- ---------------------------------------------------------------------------
DO $template$
DECLARE
  v_def    text;
  v_values text[];
  v_add    text[] := ARRAY[
    -- transactional: an annual subscription renews in 30 days
    'annual_renewal_30'
  ];
BEGIN
  SELECT pg_get_constraintdef(c.oid)
    INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.billing_email_sends'::regclass
     AND c.conname = 'billing_email_sends_template_check'
     AND c.contype = 'c';

  IF v_def IS NULL THEN
    RAISE NOTICE 'billing_email_sends_template_check does not exist, annual_renewal_30 not added.';
    RETURN;
  END IF;

  IF v_def !~ '^CHECK \(\(template = ANY \(' THEN
    RAISE EXCEPTION 'billing_email_sends_template_check is not a plain list, not rewritten: %', v_def;
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
    RAISE EXCEPTION 'billing_email_sends_template_check has no readable values: %', v_def;
  END IF;

  IF v_add <@ v_values THEN
    RETURN;
  END IF;

  SELECT v_values || coalesce(array_agg(t.a ORDER BY t.n), ARRAY[]::text[])
    INTO v_values
    FROM unnest(v_add) WITH ORDINALITY AS t(a, n)
   WHERE t.a <> ALL (v_values);

  ALTER TABLE public.billing_email_sends
    DROP CONSTRAINT billing_email_sends_template_check;
  EXECUTE format(
    'ALTER TABLE public.billing_email_sends ADD CONSTRAINT billing_email_sends_template_check CHECK (template = ANY (ARRAY[%s]))',
    (SELECT string_agg(quote_literal(v) || '::text', ', ' ORDER BY n)
       FROM unnest(v_values) WITH ORDINALITY AS t(v, n))
  );
END;
$template$;


-- ---------------------------------------------------------------------------
-- 4. dispatch_annual_renewal_reminder() and its daily schedule.
--
-- The early return is a cheap guess from stored fields: a live subscription
-- whose stored period is longer than 300 days (annual) and ends 27 to 30 days
-- from now. The window is a few days wide so a missed run still reaches the
-- renewal; the ledger's unique key keeps it to one email. The route asks
-- Stripe for the real interval and amount before queueing anything.
--
-- The URL comes from Vault (20261026175000_dispatch_urls_from_vault.sql),
-- never a literal host.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE OR REPLACE FUNCTION public.dispatch_annual_renewal_reminder()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  v_url    text := public._app_base_url() || '/api/internal/annual-renewal-reminder/dispatch';
  v_secret text;
BEGIN
  IF NOT EXISTS (
       SELECT 1
         FROM public.user_billing b
        WHERE b.subscription_status IN ('active', 'trialing')
          AND b.stripe_subscription_id IS NOT NULL
          AND b.current_period_end >  now() + interval '27 days'
          AND b.current_period_end <= now() + interval '30 days'
          AND b.current_period_start IS NOT NULL
          AND b.current_period_end - b.current_period_start > interval '300 days'
     )
  THEN
    RETURN;
  END IF;

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
    RAISE WARNING 'dispatch_annual_renewal_reminder: Vault secret "dispatch_secret" is not set, skipping.';
    RETURN;
  END IF;

  IF v_url IS NULL THEN
    RAISE WARNING 'dispatch_annual_renewal_reminder: Vault secret "app_base_url" is not set, skipping.';
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
$$;

COMMENT ON FUNCTION public.dispatch_annual_renewal_reminder() IS
  'Called by pg_cron daily. Posts to /api/internal/annual-renewal-reminder/dispatch '
  'only when a stored annual period ends in 27 to 30 days. Secret from Vault '
  '(name=''dispatch_secret''), URL from _app_base_url().';

REVOKE ALL ON FUNCTION public.dispatch_annual_renewal_reminder() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_annual_renewal_reminder() TO service_role;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-annual-renewal-reminder') THEN
    PERFORM cron.unschedule('dispatch-annual-renewal-reminder');
  END IF;
END;
$guard$;

-- 07:20 UTC daily (08:20 Oslo in winter, 09:20 in summer).
SELECT cron.schedule(
  'dispatch-annual-renewal-reminder',
  '20 7 * * *',
  $$SELECT public.dispatch_annual_renewal_reminder()$$
);
