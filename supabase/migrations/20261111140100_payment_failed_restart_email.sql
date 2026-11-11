-- ============================================================================
-- payment_failed_restart: the restart email after a card-failure cancel.
--
-- When Stripe ends a subscription because its retries ran out
-- (cancellation_details.reason = 'payment_failed') and the owner made a
-- successful MCP call in the last 7 days, the webhook queues one service email
-- with a link to restart the same plan (src/lib/billing/payment-restart.ts,
-- behind PAYMENT_RESTART_EMAIL_ENABLED, default off).
--
-- Keyed like the dunning rows: stripe_customer_id, with scope_key = the ended
-- subscription id, so the existing unique index (stripe_customer_id, template,
-- scope_key) makes "one per ended subscription" a database property. The
-- GENERATED category stays 'transactional' without any change to its
-- expression: only winback_* is marketing.
--
-- Template allow-list, append-only: the block reads the values the live CHECK
-- allows, adds the one that is missing and re-adds the constraint with the
-- union (same pattern as 20261025010100_personal_pass_surfaces.sql). Running
-- it twice changes nothing. Forward-only and re-runnable.
-- ============================================================================

DO $template$
DECLARE
  v_def    text;
  v_values text[];
  v_add    text[] := ARRAY[
    -- transactional: the plan ended on a failed card; one link to restart it
    'payment_failed_restart'
  ];
BEGIN
  SELECT pg_get_constraintdef(c.oid)
    INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.billing_email_sends'::regclass
     AND c.conname = 'billing_email_sends_template_check'
     AND c.contype = 'c';

  IF v_def IS NULL THEN
    RAISE NOTICE 'billing_email_sends_template_check does not exist, payment_failed_restart not added.';
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

  -- Already complete: leave the constraint untouched.
  IF v_add <@ v_values THEN
    RETURN;
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
