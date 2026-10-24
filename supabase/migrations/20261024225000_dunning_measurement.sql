-- Failed-payment measurement (2026-10-24), for /admin/growth/dunning.
--
-- Three small additions, all nullable or vocabulary-only, all written by the
-- service role from the Stripe webhook or a Next route. Nothing reads them to
-- decide what a workspace may do. mcp-server reads none of them, so the
-- self-host schema is unchanged.
--
--   1. billing_email_sends.recovered_by: on a dunning sequence cancelled as
--      payment_recovered, whether the customer acted ('customer') or Stripe's
--      own retry got the money ('retry'). 'unknown' when the webhook could not
--      tell. Heuristic in apps/web/app/api/stripe/webhook/route.ts
--      (recoveredBy).
--   2. stripe_webhook_events.cancellation_reason: Stripe's
--      cancellation_details.reason on customer.subscription.deleted
--      ('payment_failed', 'cancellation_requested', 'payment_disputed'), so the
--      involuntary share of churn can be counted by month. Older deletion rows
--      stay NULL: Stripe did not tell us then, and the page labels them so.
--   3. product_funnel_events stage 'payment_fix_clicked': the failed-payment
--      banner's button (/api/stripe/payment-fix).
--
-- Idempotent.

ALTER TABLE public.billing_email_sends
  ADD COLUMN IF NOT EXISTS recovered_by text;

ALTER TABLE public.billing_email_sends DROP CONSTRAINT IF EXISTS billing_email_sends_recovered_by_check;
ALTER TABLE public.billing_email_sends ADD CONSTRAINT billing_email_sends_recovered_by_check
  CHECK (recovered_by IS NULL OR recovered_by IN ('customer', 'retry', 'unknown'));

COMMENT ON COLUMN public.billing_email_sends.recovered_by IS
  'Dunning rows only, set when the sequence is cancelled as payment_recovered: customer = the customer acted (new payment method or a 3-D Secure confirmation), retry = an automatic retry on the same method, unknown = could not tell.';

ALTER TABLE public.stripe_webhook_events
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

ALTER TABLE public.stripe_webhook_events DROP CONSTRAINT IF EXISTS stripe_webhook_events_cancellation_reason_len;
ALTER TABLE public.stripe_webhook_events ADD CONSTRAINT stripe_webhook_events_cancellation_reason_len
  CHECK (cancellation_reason IS NULL OR char_length(cancellation_reason) <= 64);

COMMENT ON COLUMN public.stripe_webhook_events.cancellation_reason IS
  'customer.subscription.deleted only: Stripe cancellation_details.reason, or ''none'' when Stripe gave none. NULL on rows from before 2026-10-24 and on every other event type.';

-- ---------------------------------------------------------------------------
-- stage vocabulary: 'payment_fix_clicked'
--
-- ADDITIVE, NOT VERBATIM. Other open branches also redefine this constraint
-- (new stages of their own), and a migration that restates a fixed list drops
-- whatever was added since. This reads the live definition, keeps every stage
-- already in it, and appends 'payment_fix_clicked' if it is missing. A later
-- migration that restates its own fixed list can still drop it; the webhook
-- and route only lose the funnel row then (the insert is best-effort).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  def text;
  stages text[];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  WHERE c.conname = 'product_funnel_events_stage_check'
    AND c.conrelid = 'public.product_funnel_events'::regclass;

  -- No constraint at all: nothing restricts the stage, nothing to add.
  IF def IS NULL THEN
    RETURN;
  END IF;

  -- Postgres prints the list as ARRAY['a'::text, ...]; an array literal
  -- '{a,b}'::text[] is read too, in case a constraint was written that way.
  SELECT array_agg(DISTINCT s ORDER BY s) INTO stages
  FROM (
    SELECT m[1] AS s FROM regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') AS m
    UNION
    SELECT trim(both '"' from x) FROM regexp_matches(def, '''\{([^}]*)\}''', 'g') AS a,
      unnest(string_to_array(a[1], ',')) AS x
  ) found
  WHERE s ~ '^[a-z0-9_]+$';

  IF stages IS NULL OR array_length(stages, 1) IS NULL THEN
    RAISE EXCEPTION 'product_funnel_events_stage_check has no readable stage list: %', def;
  END IF;

  IF 'payment_fix_clicked' = ANY (stages) THEN
    RETURN;
  END IF;

  stages := array_append(stages, 'payment_fix_clicked');

  ALTER TABLE public.product_funnel_events
    DROP CONSTRAINT product_funnel_events_stage_check;
  EXECUTE format(
    'ALTER TABLE public.product_funnel_events ADD CONSTRAINT product_funnel_events_stage_check CHECK (stage IN (%s))',
    (SELECT string_agg(quote_literal(s), ', ' ORDER BY s) FROM unnest(stages) AS s)
  );
END
$$;
