-- ============================================================================
-- 2026-10-24: why a subscriber cancelled, asked only after the cancel is done.
--
-- Plan: Documents/plans/pause-downgrade-20261024.md, sections 4 and 6. The
-- reason is never asked on /cancel or in the Stripe portal. It is asked in the
-- post-cancel email (one-tap links to /billing/feedback, recorded only when the
-- reader presses Send) and, later, on the Billing card in dashboard Settings.
--
-- 1. public.cancellation_feedback: one answer per cancellation.
--      reason  a fixed vocabulary (src/lib/billing/cancel-reasons.ts).
--      detail  optional typed text, capped at 500 characters.
--      source  'cancel_email' (signed link) or 'billing_card' (signed in).
--    UNIQUE NULLS NOT DISTINCT (subscription_id, period_end): a resubmit is an
--    upsert that replaces the answer, including for a cancellation queued
--    without a period end. Service-role only: RLS on, no policies, no grants
--    to anon or authenticated. Rows go with the user (ON DELETE CASCADE), so a
--    deleted account does not leave its typed text behind.
--
-- 2. product_funnel_events: stages 'cancel_reason_submitted' (category = the
--    reason) and 'retention_option_clicked' (category 'pause' | 'downgrade'),
--    and those categories.
--
--    The two CHECKs are WIDENED IN PLACE rather than restated: the current
--    value lists are read from the catalog and the new values are added to
--    them. The pause/downgrade work changes the same constraints in parallel;
--    restating a hand-copied list here would silently drop whatever another
--    migration added before this one ran. On top of origin/main as of today the
--    result is the 20261019150000 stage list and the 20260827100000 category
--    list plus the values above. A later migration that restates either list
--    by hand must copy it from the catalog, not from an older file.
--
-- Forward-only, one transaction, safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. cancellation_feedback
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cancellation_feedback (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_customer_id text,
  user_id            uuid REFERENCES public.users(id) ON DELETE CASCADE,
  subscription_id    text NOT NULL,
  period_end         timestamptz,
  reason             text NOT NULL
    CHECK (reason IN (
      'too_expensive', 'not_using_enough', 'missing_feature', 'reliability',
      'switched_tool', 'temporary_need', 'other'
    )),
  detail             text
    CHECK (detail IS NULL OR char_length(detail) <= 500),
  source             text NOT NULL
    CHECK (source IN ('billing_card', 'cancel_email')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cancellation_feedback_one_per_cancellation
    UNIQUE NULLS NOT DISTINCT (subscription_id, period_end)
);

COMMENT ON TABLE public.cancellation_feedback IS
  'Why a subscriber cancelled, answered after the cancellation was done (post-cancel email link or Billing card). '
  'One row per cancellation (subscription_id, period_end); a resubmit replaces the answer. reason is a fixed vocabulary; '
  'detail is optional user-typed text (max 500 chars). Service-role only.';

CREATE INDEX IF NOT EXISTS idx_cancellation_feedback_created
  ON public.cancellation_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cancellation_feedback_user
  ON public.cancellation_feedback (user_id) WHERE user_id IS NOT NULL;

ALTER TABLE public.cancellation_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cancellation_feedback FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cancellation_feedback TO service_role;


-- ---------------------------------------------------------------------------
-- 2. product_funnel_events: widen the stage and category CHECKs in place
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  target  record;
  def     text;
  cur_vals text[];
  wanted_sql text;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('product_funnel_events_stage_check', 'stage',
        ARRAY['cancel_reason_submitted', 'retention_option_clicked']),
      ('product_funnel_events_category_check', 'category',
        ARRAY['too_expensive', 'not_using_enough', 'missing_feature', 'reliability',
              'switched_tool', 'temporary_need', 'other', 'pause', 'downgrade'])
    ) AS t(conname, col, additions)
  LOOP
    SELECT pg_get_constraintdef(c.oid) INTO def
      FROM pg_constraint c
     WHERE c.conrelid = 'public.product_funnel_events'::regclass
       AND c.conname = target.conname;
    IF def IS NULL THEN
      -- Never replace a missing list with only the new values: that would
      -- reject every existing stage or category.
      RAISE EXCEPTION '% not found on product_funnel_events', target.conname;
    END IF;

    -- Postgres prints an IN list back as ARRAY['a'::text, 'b'::text]; an
    -- array literal would come back as '{a,b}'::text[]. Read either: every
    -- quoted token, with a '{...}' token split on its commas.
    SELECT coalesce(array_agg(btrim(v)), '{}') INTO cur_vals
      FROM regexp_matches(def, '''([^'']+)''', 'g') AS m,
           LATERAL unnest(
             CASE WHEN m[1] LIKE '{%}' THEN string_to_array(btrim(m[1], '{}'), ',') ELSE ARRAY[m[1]] END
           ) AS v;
    IF array_length(cur_vals, 1) IS NULL THEN
      RAISE EXCEPTION 'could not read the value list of %: %', target.conname, def;
    END IF;

    SELECT string_agg(quote_literal(v), ', ' ORDER BY v) INTO wanted_sql
      FROM (SELECT DISTINCT unnest(cur_vals || target.additions) AS v) s;

    EXECUTE format('ALTER TABLE public.product_funnel_events DROP CONSTRAINT %I', target.conname);
    -- Written as IN (...), the same shape every earlier migration used, so
    -- the catalog prints it as ARRAY['a'::text, ...] like before.
    EXECUTE format(
      'ALTER TABLE public.product_funnel_events ADD CONSTRAINT %I CHECK (%I IN (%s))',
      target.conname, target.col, wanted_sql
    );
  END LOOP;
END
$$;
