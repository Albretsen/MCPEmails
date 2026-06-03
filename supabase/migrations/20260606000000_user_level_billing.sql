-- ============================================================
-- MCPEmails — User-level billing (subscription tied to the owner)
-- 20260606000000_user_level_billing
--
-- WHY
--   The subscription was previously modelled per-workspace: the Stripe
--   customer + plan lived on a single `workspaces` row, and the webhook only
--   updated that one workspace. That had two bugs:
--     1. A user who owns several workspaces (allowed once they pay) only saw
--        the plan on the originally-subscribed workspace.
--     2. On cancellation, *inherited* `pro` workspaces stayed stuck on `pro`
--        forever because the webhook only downgraded the one subscribed row.
--
--   Founder's intent: "The subscription has to be tied to the user." A paying
--   owner's entitlement must apply to EVERY workspace they own, and cancelling
--   must downgrade ALL of them.
--
-- WHAT THIS DOES
--   Introduces `public.user_billing` — one row per user — as the single source
--   of truth for that user's Stripe customer + subscription state. The webhook
--   resolves the owner from the Stripe customer, upserts this row, and then
--   propagates the resulting plan to every workspace where `owner_id = <user>`.
--
--   `workspaces.plan` is KEPT as the per-workspace projection of the owner's
--   entitlement so that the many existing readers (dashboard, edge function,
--   RPC gate, RLS) keep working unchanged. It is now derived, not authoritative.
--
-- NOTE
--   `workspaces.stripe_customer_id` is intentionally left in place (it is still
--   written by the webhook for backward-compat and to avoid a destructive data
--   migration). It is no longer the lookup key; `user_billing.stripe_customer_id`
--   is. A future cleanup migration may drop the workspace column.
-- ============================================================

-- ── user_billing: one row per user ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_billing (
  user_id                uuid PRIMARY KEY
                           REFERENCES public.users(id) ON DELETE CASCADE,
  -- The single Stripe Customer for this user, reused across all their
  -- workspaces. One customer per user (not per workspace).
  stripe_customer_id     text UNIQUE,
  -- The active/most-recent Stripe Subscription for this user.
  stripe_subscription_id text,
  -- Raw Stripe subscription status (active | trialing | past_due | unpaid |
  -- canceled | incomplete | incomplete_expired | paused). NULL = no sub yet.
  -- Used for the dunning grace period (past_due/unpaid stay entitled).
  subscription_status    text,
  -- The plan the user is entitled to: 'free' | 'solo' | 'pro' ('pro' = Team).
  -- This is what gets projected onto every workspace the user owns.
  plan                   text NOT NULL DEFAULT 'free',
  -- Current period end (unix→timestamptz), for showing renewal/expiry later.
  current_period_end     timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_billing_stripe_customer_id
  ON public.user_billing (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

COMMENT ON TABLE public.user_billing IS
  'Single source of truth for a user''s Stripe customer + subscription. The '
  'entitlement is projected onto workspaces.plan for every workspace the user '
  'owns. See 20260606000000_user_level_billing.sql.';

-- moddatetime trigger to keep updated_at fresh (extension already enabled).
DROP TRIGGER IF EXISTS user_billing_updated_at ON public.user_billing;
CREATE TRIGGER user_billing_updated_at
  BEFORE UPDATE ON public.user_billing
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

-- ── RLS: a user may read (but not write) their own billing row ──────────────
-- All writes go through the service-role client in the webhook / checkout.
ALTER TABLE public.user_billing ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_billing_select_own ON public.user_billing;
CREATE POLICY user_billing_select_own
  ON public.user_billing
  FOR SELECT
  USING (user_id = auth.uid());

-- ── Backfill from existing per-workspace billing ───────────────────────────
-- For every workspace that already has a Stripe customer, seed the owner's
-- user_billing row. If an owner somehow has two billed workspaces, the first
-- (by created_at) wins the customer id; their entitlement is the best plan
-- across their owned workspaces (pro > solo > free).
INSERT INTO public.user_billing (user_id, stripe_customer_id, plan)
SELECT DISTINCT ON (w.owner_id)
       w.owner_id,
       w.stripe_customer_id,
       (
         SELECT CASE
                  WHEN bool_or(w2.plan = 'pro')  THEN 'pro'
                  WHEN bool_or(w2.plan = 'solo') THEN 'solo'
                  ELSE 'free'
                END
         FROM public.workspaces w2
         WHERE w2.owner_id = w.owner_id
           AND w2.deleted_at IS NULL
       )
FROM public.workspaces w
WHERE w.stripe_customer_id IS NOT NULL
  AND w.deleted_at IS NULL
ORDER BY w.owner_id, w.created_at ASC
ON CONFLICT (user_id) DO NOTHING;
