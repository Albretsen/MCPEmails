-- Billing funnel instrumentation.
--
-- The product funnel previously ended at `value_activation`: every stage from
-- signup to first successful tool call was measured, and nothing after it. That
-- made the revenue question unanswerable from data. It was impossible to
-- distinguish "nobody wants to pay" from "the upgrade button is broken",
-- because neither leaves a trace.
--
-- These stages close the funnel:
--   paywall_reached      : the action cap actually blocked a billable call.
--   pricing_viewed       : a signed-in user loaded a page showing the plans.
--   checkout_started     : POST /api/stripe/checkout ran (success = Stripe
--                          returned a hosted URL; failure carries the reason).
--   checkout_completed   : Stripe confirmed a paid checkout via webhook.
--   billing_portal_opened: an existing subscriber opened the Stripe portal.
--
-- Abandonment is derived, not stored: a workspace with `checkout_started`
-- (success) and no later `checkout_completed` abandoned Stripe's hosted page.
--
-- The no-sensitive-data contract is unchanged. No price id, amount, currency,
-- Stripe customer/session id, card detail, or billing address is recorded
-- here; only the bounded plan+interval category the user aimed at.

ALTER TABLE public.product_funnel_events DROP CONSTRAINT product_funnel_events_stage_check;
ALTER TABLE public.product_funnel_events ADD CONSTRAINT product_funnel_events_stage_check
  CHECK (stage IN (
    'onboarding_started', 'client_selected', 'provider_selected', 'inbox_connection',
    'connection_verified', 'credential_created', 'technical_activation',
    'value_activation', 'first_tool_call',
    -- Billing funnel
    'paywall_reached', 'pricing_viewed', 'checkout_started', 'checkout_completed',
    'billing_portal_opened'
  ));

ALTER TABLE public.product_funnel_events DROP CONSTRAINT product_funnel_events_category_check;
ALTER TABLE public.product_funnel_events ADD CONSTRAINT product_funnel_events_category_check
  CHECK (category IN (
    'gmail', 'outlook', 'fastmail', 'icloud', 'yahoo', 'zoho', 'yandex',
    'generic_imap', 'api_key', 'oauth', 'claude', 'chatgpt', 'cursor',
    'vscode', 'cline', 'windsurf', 'gemini', 'zed', 'jetbrains', 'raycast',
    'warp', 'curl', 'unknown',
    -- Billing: the plan+interval a checkout targeted ...
    'solo_month', 'solo_year', 'pro_month', 'pro_year',
    -- ... the plan a user was on when a paywall or portal event fired ...
    'free', 'solo', 'pro',
    -- ... and the surface a pricing view happened on.
    'pricing_page', 'dashboard_billing'
  ));

ALTER TABLE public.product_funnel_events DROP CONSTRAINT product_funnel_events_error_category_check;
ALTER TABLE public.product_funnel_events ADD CONSTRAINT product_funnel_events_error_category_check
  CHECK (error_category IS NULL OR error_category IN (
    'auth_failed', 'validation_failed', 'provider_denied', 'token_exchange_failed',
    'plan_limit', 'conflict', 'persistence_failed', 'unknown',
    -- Billing failure reasons. `price_not_configured` is the silent killer
    -- worth alerting on: it means an unset STRIPE_PRICE_* env var made the
    -- plan unbuyable, which looks identical to disinterest in aggregate.
    'price_not_configured', 'subscription_exists', 'stripe_error', 'no_customer'
  ));

-- ---------------------------------------------------------------------------
-- Reporting view: one row per workspace that reached any billing stage.
--
-- Deliberately a view, not a materialized table: the volume is tiny (a handful
-- of rows per workspace) and correctness matters more than speed here.
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
     > COUNT(*) FILTER (WHERE e.stage = 'checkout_completed'))                            AS abandoned_checkout
FROM public.workspaces w
JOIN public.product_funnel_events e ON e.workspace_id = w.id
WHERE e.stage IN ('paywall_reached', 'pricing_viewed', 'checkout_started', 'checkout_completed', 'billing_portal_opened')
GROUP BY w.id, w.plan;

-- The view reads a table with RLS enabled and no browser-facing policy, and is
-- only queried by service-role admin code. security_invoker keeps it that way:
-- without it the view would run as its (superuser) owner and bypass RLS.
ALTER VIEW public.billing_funnel_by_workspace SET (security_invoker = true);

CREATE INDEX IF NOT EXISTS product_funnel_events_billing_idx
  ON public.product_funnel_events (stage, occurred_at DESC)
  WHERE stage IN ('paywall_reached', 'pricing_viewed', 'checkout_started', 'checkout_completed', 'billing_portal_opened');
