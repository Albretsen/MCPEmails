-- ============================================================
-- Migration: add_stripe_to_workspaces
-- Adds Stripe billing columns to the workspaces table.
-- stripe_customer_id  — the Stripe Customer object ID (cus_...)
-- All other Stripe state (subscription ID, status, price) is
-- stored and synced via the webhook handler (task 20.3).
-- ============================================================

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS stripe_customer_id text UNIQUE;

-- Index for fast lookup by customer ID (used in webhook handler).
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_stripe_customer_id
  ON public.workspaces (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

COMMENT ON COLUMN public.workspaces.stripe_customer_id IS
  'Stripe Customer ID (cus_...). Null until the user initiates checkout.';
