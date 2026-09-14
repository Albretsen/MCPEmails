-- Expansion revenue, made countable.
--
-- THE DEFECT. An existing subscriber who changes plan does not go through
-- Stripe Checkout: `runCheckout` swaps the price on the live subscription and
-- Stripe invoices the proration immediately. Until today that path recorded
--
--     checkout_started / failure / subscription_exists
--
-- on the CONFIRMED pass, one line above the call that performs the swap. So a
-- successful, invoiced, paid upgrade left exactly one trace in the funnel, and
-- that trace said the checkout had failed.
--
-- It happened for real on 2026-09-14. Workspace dbed58c7 bought Personal at
-- 10:21:50Z, hit Personal's three-inbox ceiling at 10:46 while connecting a
-- fourth mailbox, and upgraded to Pro (`solo`). Stripe confirms it
-- (customer.subscription.updated + invoice.payment_succeeded at 10:46:33Z for
-- cus_VG36Z1e0hyTiDe) and both `user_billing` and `workspaces.plan` moved to
-- `solo`. The funnel held a single failure row. Two consequences, both live:
-- expansion revenue was invisible, and the one real checkout failure the board
-- had ever shown was not a failure at all.
--
-- THE SHAPE CHOSEN, and why it is not `checkout_completed`. That stage is what
-- `billing_funnel_by_workspace` exposes as `paid_at`, and
-- `growth_experiment_readout` (20260903120000) reads `paid_at IS NOT NULL` as
-- "this workspace converted". Filing plan changes there would count every
-- DOWNGRADE as a new sale, permanently, inside an experiment read-out.
--
-- Two stages rather than one `plan_changed`, for the same reason: a single
-- bucket cannot separate expansion from contraction, and separating them is the
-- entire point of measuring this at all. The direction is decided in the
-- application by `planCommitmentRank` (plans.ts), which orders (plan, interval)
-- pairs tier-first and then by commitment length: personal/month ->
-- personal/year is an upgrade on the same tier, and pro/month -> solo/year is a
-- downgrade despite the longer commitment. Deliberately not a comparison of
-- yearly revenue, since every annual price in the catalogue is discounted and
-- that reading would file a customer committing to a year as contraction.
--
-- `category` on these rows is the plan+interval the change landed ON, in the
-- same bounded vocabulary a checkout target uses. `outcome` says what happened
-- to the money: `success` = swapped, invoiced and paid; `started` = Stripe holds
-- it as a pending update until the invoice is paid, so the customer is still on
-- the plan they had; `failure` = the call to Stripe threw and nothing moved.
--
-- The no-sensitive-data contract is unchanged: no price id, amount, currency,
-- invoice, customer or subscription id is recorded here.

-- ---------------------------------------------------------------------------
-- 1. stage vocabulary
--
-- Current definition is 20260813100000, reproduced verbatim with two additions.
-- The category and error_category constraints are untouched: these rows reuse
-- the existing plan+interval categories and carry no new failure reason.
-- ---------------------------------------------------------------------------
ALTER TABLE public.product_funnel_events
  DROP CONSTRAINT IF EXISTS product_funnel_events_stage_check;
ALTER TABLE public.product_funnel_events
  ADD CONSTRAINT product_funnel_events_stage_check
  CHECK (stage IN (
    'onboarding_started', 'client_selected', 'provider_selected', 'inbox_connection',
    'connection_verified', 'credential_created', 'technical_activation',
    'value_activation', 'first_tool_call',
    -- Billing funnel
    'paywall_reached', 'pricing_viewed', 'checkout_started', 'checkout_completed',
    'billing_portal_opened',
    -- An existing subscriber's price was swapped in place, in either direction.
    'plan_upgraded', 'plan_downgraded'
  ));

-- ---------------------------------------------------------------------------
-- 2. Correct the one mis-recorded row.
--
-- Scoped to a single event by its full signature rather than to a pattern, and
-- deliberately so. The only other `checkout_started / failure /
-- subscription_exists` rows in production are two from our own test account on
-- 2026-08-29, which predate the in-place swap and were genuine refusals; a
-- pattern-wide rewrite would silently reclassify them as customer upgrades.
-- Re-running this migration is a no-op, because the row it matches no longer
-- matches after the first pass.
--
-- personal_month -> solo_month is $5/mo -> $15/mo: an upgrade.
-- ---------------------------------------------------------------------------
UPDATE public.product_funnel_events
SET stage          = 'plan_upgraded',
    outcome        = 'success',
    error_category = NULL
WHERE workspace_id   = 'dbed58c7-7d2d-4800-9f98-ee9fd8488261'
  AND stage          = 'checkout_started'
  AND outcome        = 'failure'
  AND error_category = 'subscription_exists'
  AND category       = 'solo_month'
  AND occurred_at    = '2026-09-14 10:46:29.637786+00';

-- ---------------------------------------------------------------------------
-- 3. Reporting view
--
-- CREATE OR REPLACE only tolerates new columns APPENDED to the existing list,
-- so the four additions go at the end and every existing column keeps its name,
-- type and position. Readers that select by name are unaffected.
--
-- `paid_at` and `checkouts_completed` deliberately still count ONLY
-- `checkout_completed`. A plan change is not a new sale in either direction,
-- and `first_upgrade_at` is the column to join on for expansion.
--
-- `abandoned_checkout` is likewise untouched and is now correct for this cohort
-- for the first time: the plan-change path no longer writes a `checkout_started`
-- row of any outcome, so an upgrading subscriber can no longer be counted as
-- having started a checkout they never finished.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.billing_funnel_by_workspace AS
SELECT
  w.id AS workspace_id,
  w.plan,
  MIN(e.occurred_at) FILTER (WHERE e.stage = 'paywall_reached')                          AS first_paywall_at,
  MIN(e.occurred_at) FILTER (WHERE e.stage = 'pricing_viewed')                           AS first_pricing_view_at,
  MIN(e.occurred_at) FILTER (WHERE e.stage = 'checkout_started' AND e.outcome = 'success') AS first_checkout_at,
  MIN(e.occurred_at) FILTER (WHERE e.stage = 'checkout_completed')                       AS paid_at,
  COUNT(*) FILTER (WHERE e.stage = 'paywall_reached')                                    AS paywall_hits,
  COUNT(*) FILTER (WHERE e.stage = 'pricing_viewed')                                     AS pricing_views,
  COUNT(*) FILTER (WHERE e.stage = 'checkout_started' AND e.outcome = 'success')          AS checkouts_started,
  COUNT(*) FILTER (WHERE e.stage = 'checkout_started' AND e.outcome = 'failure')          AS checkouts_failed,
  COUNT(*) FILTER (WHERE e.stage = 'checkout_completed')                                  AS checkouts_completed,
  -- A started checkout with no completion is an abandonment on Stripe's page.
  (COUNT(*) FILTER (WHERE e.stage = 'checkout_started' AND e.outcome = 'success')
     > COUNT(*) FILTER (WHERE e.stage = 'checkout_completed'))                            AS abandoned_checkout,
  -- Expansion and contraction, counted separately and never as sales.
  MIN(e.occurred_at) FILTER (WHERE e.stage = 'plan_upgraded' AND e.outcome = 'success')    AS first_upgrade_at,
  COUNT(*) FILTER (WHERE e.stage = 'plan_upgraded' AND e.outcome = 'success')              AS plan_upgrades,
  COUNT(*) FILTER (WHERE e.stage = 'plan_downgraded' AND e.outcome = 'success')            AS plan_downgrades,
  -- A confirmed change that Stripe threw on, or that it is holding unpaid as a
  -- pending update. Both are somebody who agreed to an amount and did not get
  -- the plan, which is the most expensive failure on this path.
  COUNT(*) FILTER (WHERE e.stage IN ('plan_upgraded', 'plan_downgraded')
                     AND e.outcome <> 'success')                                          AS plan_changes_unfinished
FROM public.workspaces w
JOIN public.product_funnel_events e ON e.workspace_id = w.id
WHERE e.stage IN ('paywall_reached', 'pricing_viewed', 'checkout_started', 'checkout_completed',
                  'billing_portal_opened', 'plan_upgraded', 'plan_downgraded')
GROUP BY w.id, w.plan;

-- Re-asserted rather than assumed: the view reads a table with RLS enabled and
-- no browser-facing policy, and without security_invoker it would run as its
-- (superuser) owner and bypass RLS.
ALTER VIEW public.billing_funnel_by_workspace SET (security_invoker = true);

-- ---------------------------------------------------------------------------
-- 4. Index
--
-- The partial index from 20260813100000 lists the stages in its predicate, so
-- the two new ones fall outside it. DROP first: `CREATE INDEX IF NOT EXISTS`
-- matches on name alone and would silently keep the old, narrower predicate.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.product_funnel_events_billing_idx;
CREATE INDEX product_funnel_events_billing_idx
  ON public.product_funnel_events (stage, occurred_at DESC)
  WHERE stage IN ('paywall_reached', 'pricing_viewed', 'checkout_started', 'checkout_completed',
                  'billing_portal_opened', 'plan_upgraded', 'plan_downgraded');
