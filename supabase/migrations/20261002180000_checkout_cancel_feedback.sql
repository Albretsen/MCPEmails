-- ============================================================================
-- 2026-10-02: why a started checkout was abandoned, in the buyer's own words.
--
-- The billing funnel can see THAT a checkout was abandoned (a successful
-- `checkout_started` with no `checkout_completed`) and nothing about why. Since
-- 2026-09-01, 12 of 48 workspaces that opened Stripe's page left without
-- paying, several within a minute, and the only thing the product said on
-- their return was a five second toast. The dashboard now asks one question
-- instead, and this table is where the answer lands.
--
-- Why a table and not `product_funnel_events`: that table is a bounded
-- vocabulary by design (every column is a CHECK-constrained category), and the
-- "Other" answer is free text. Widening the funnel to hold prose would break
-- the no-free-text contract every reader of it relies on.
--
-- What is stored:
--   reason   one of a fixed set, chosen by the user.
--   detail   only for `other`: what they typed, capped at 500 characters.
--   target   the plan+interval of the checkout they came back from, read
--            server-side from their latest `checkout_started`. Never taken
--            from the browser.
--
-- Service-role only. RLS is enabled with no member policy on purpose, the same
-- position as `triage_seen_messages`: the rows have no user-facing surface, the
-- write goes through /api/analytics/checkout-feedback, and the read is ours.
-- Rows go when the workspace or the user does.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.checkout_cancel_feedback (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reason       text NOT NULL
    CHECK (reason IN ('price_too_high', 'compare_plans', 'want_to_try_first', 'payment_method', 'just_checking_price', 'other')),
  detail       text
    CHECK (detail IS NULL OR (reason = 'other' AND char_length(detail) BETWEEN 1 AND 500)),
  target       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.checkout_cancel_feedback IS
  'One row per answer to the "what stopped you?" card shown on return from an abandoned Stripe checkout. reason is a fixed vocabulary; detail is user-typed free text (reason = other only, max 500 chars); target is the plan+interval of the checkout they left, read server-side. Service-role only.';

CREATE INDEX IF NOT EXISTS idx_checkout_cancel_feedback_workspace_created
  ON public.checkout_cancel_feedback (workspace_id, created_at DESC);

ALTER TABLE public.checkout_cancel_feedback ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.checkout_cancel_feedback FROM anon, authenticated;

-- Each answer also emails the owner through the existing system-event
-- pipeline (emit_system_event -> system-notify), as event type
-- 'checkout.feedback'. The payload is ids and the fixed reason only; the
-- notifier reads the typed text and the account details at send time.
COMMENT ON COLUMN public.system_events.event_type IS
  'Event name the system-notify Edge Function renders a template for. Known values: '
  '''user.signup'' (a new user was provisioned), ''automation.auto_disabled'' '
  '(a triage_rules row switched itself off after 5 consecutive failed runs) and '
  '''checkout.feedback'' (someone answered the card shown after an abandoned Stripe checkout). '
  'An event_type with no matching template is recorded and marked failed, never delivered.';
