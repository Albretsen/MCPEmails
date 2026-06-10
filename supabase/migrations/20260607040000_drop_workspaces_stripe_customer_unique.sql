-- ============================================================
-- MCPEmails — Drop the UNIQUE constraint on workspaces.stripe_customer_id
-- 20260606000002_drop_workspaces_stripe_customer_unique
--
-- WHY
--   The original per-workspace billing model (20260525140000) added
--   `workspaces.stripe_customer_id text UNIQUE` plus a partial unique index,
--   back when one Stripe customer mapped to exactly one workspace.
--
--   The user-level billing migration (20260606000000) changed the model: one
--   Stripe customer belongs to the USER and is "reused across all their
--   workspaces" (see that migration's NOTE). The webhook handler
--   (api/stripe/webhook) projects the owner's customer id onto EVERY workspace
--   they own. For any owner with >1 workspace this violates the leftover UNIQUE
--   constraint (23505 duplicate key) — the workspace UPDATE throws, the handler
--   deletes the ledger row and returns 500, and Stripe retries forever. The bug
--   was latent until a real subscription first fired the live webhook.
--
-- WHAT THIS DOES
--   Drops both the implicit UNIQUE constraint (workspaces_stripe_customer_id_key)
--   and the partial unique index (idx_workspaces_stripe_customer_id). The column
--   is retained (still written for portal fallback / backward-compat), but it is
--   no longer unique — a single customer can now back all of a user's workspaces,
--   which is the intended user-level model.
-- ============================================================

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_stripe_customer_id_key;

DROP INDEX IF EXISTS public.idx_workspaces_stripe_customer_id;
