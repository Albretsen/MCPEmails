-- ============================================================================
-- Personal 3-month pass, PR 2: the two service notices and the holdout test.
--
-- Builds on 20261025010000_personal_pass.sql (user_passes, funnel vocabulary).
--
--   1. billing_email_sends.template gains 'pass_ending_7d' and 'pass_ended',
--      appended to whatever the live CHECK already allows.
--      Both are transactional service notices about a purchase (the end of a
--      fixed-term contract), so the GENERATED category stays 'transactional'
--      for them without any change to its expression: only winback_* is
--      marketing. They are keyed on the Stripe customer like the dunning rows,
--      with scope_key = the user_passes id, so the existing unique index
--      (stripe_customer_id, template, scope_key) makes "exactly two per pass"
--      a database property.
--
--   2. The holdout experiment 'personal_pass_3m' in the experiments system
--      (20260903120000_experiments.sql). Unit: the workspace, as a subject id
--      (the workspace uuid without its dashes, which is 32 lowercase hex).
--      Variant 0 is the control by convention: 'holdout' sees today's
--      surfaces. 'pass' sees the pass line under the subscription options.
--      50/50. Seeded 'running' because the env switch PERSONAL_PASS_ENABLED
--      is what turns the test on: at 'off' (the default) nothing calls the
--      experiment at all, so nobody is assigned while the switch is off.
--
-- Forward-only and re-runnable.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Template allow-list, append-only.
--
-- Other sessions add templates to this CHECK from migrations that may land
-- before or after this one, so the list is never written out here: the block
-- reads the values the live constraint allows, adds the two pass notices that
-- are missing, and re-adds the constraint with the union. Running it twice
-- changes nothing. If the constraint is missing it is left missing (a
-- pass-only list would refuse every other template).
-- ---------------------------------------------------------------------------
DO $template$
DECLARE
  v_def    text;
  v_values text[];
  v_add    text[] := ARRAY[
    -- transactional: a 3-month Personal pass ends in 7 days, or has ended
    'pass_ending_7d', 'pass_ended'
  ];
BEGIN
  SELECT pg_get_constraintdef(c.oid)
    INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.billing_email_sends'::regclass
     AND c.conname = 'billing_email_sends_template_check'
     AND c.contype = 'c';

  IF v_def IS NULL THEN
    RAISE NOTICE 'billing_email_sends_template_check does not exist, pass templates not added.';
    RETURN;
  END IF;

  -- Only a plain list is rewritten. Anything else (an OR, a NULL arm) would
  -- lose its meaning here, so the migration stops instead.
  IF v_def !~ '^CHECK \(\(template = ANY \(' THEN
    RAISE EXCEPTION 'billing_email_sends_template_check is not a plain list, not rewritten: %', v_def;
  END IF;

  -- Every quoted literal in the definition, in order. pg_get_constraintdef
  -- prints either ARRAY['a'::text, ...] or '{a,...}'::text[]; the second
  -- form is one literal that holds the whole list, so it is cast and unnested.
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

  -- Keep the existing order, append only what is missing.
  SELECT v_values || coalesce(array_agg(t.a ORDER BY t.n), ARRAY[]::text[])
    INTO v_values
    FROM unnest(v_add) WITH ORDINALITY AS t(a, n)
   WHERE t.a <> ALL (v_values);

  -- Written as ARRAY['a'::text, ...], the same form production prints.
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
-- 2. The holdout experiment.
-- ---------------------------------------------------------------------------
INSERT INTO public.experiments (key, name, description, status, variants, started_at)
VALUES (
  'personal_pass_3m',
  'Personal 3-month pass, post-decline holdout',
  'Unit is the workspace (uuid without dashes). Eligible: a Free workspace with no entitled subscription that meets a post-decline trigger (abandoned Personal checkout, 72 h at the action or inbox cap, paywall follow-up step 3). holdout sees today''s surfaces; pass also sees the 3-month pass below the subscription options. Only assigns while PERSONAL_PASS_ENABLED=holdout.',
  'running',
  '[{"id":"holdout","label":"Today''s surfaces","weight":50},{"id":"pass","label":"Pass offered below the subscription","weight":50}]'::jsonb,
  now()
)
ON CONFLICT (key) DO NOTHING;
