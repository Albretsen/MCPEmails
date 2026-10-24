-- ============================================================================
-- Personal 3-month pass, PR 2: the two service notices and the holdout test.
--
-- Builds on 20261024170000_personal_pass.sql (user_passes, funnel vocabulary).
--
--   1. billing_email_sends.template gains 'pass_ending_7d' and 'pass_ended'.
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
-- 1. Template allow-list. The current definition is 20260912200000,
--    reproduced verbatim with the two pass notices added.
-- ---------------------------------------------------------------------------
ALTER TABLE public.billing_email_sends
  DROP CONSTRAINT IF EXISTS billing_email_sends_template_check;
ALTER TABLE public.billing_email_sends
  ADD CONSTRAINT billing_email_sends_template_check CHECK (template IN (
    -- transactional: the payment is broken or about to be
    'dunning_1', 'dunning_3', 'dunning_7', 'dunning_14',
    'card_expiry_30', 'card_expiry_7',
    -- transactional: they cancelled, we ask one question
    'cancel_ask',
    -- marketing-adjacent: they are already gone
    'winback_14', 'winback_30',
    -- transactional: the Free allowance is 80% used, used up, or paused a rule
    'usage_warning_80', 'usage_limit_reached', 'automation_paused_limit',
    -- transactional: a 3-month Personal pass ends in 7 days, or has ended
    'pass_ending_7d', 'pass_ended'
  ));


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
