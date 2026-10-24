-- ============================================================================
-- Park inboxes above Free's cap when a cancelled plan ends, and the one
-- swap a day of a parked inbox.
-- 20261025020000_park_on_cancel_swap
-- ============================================================================
--
-- WHY. Documents/plans/pause-downgrade-20261024.md, decision D3 and section
-- 2.4. A plain cancel to Free now parks the inboxes above Free's cap, the same
-- way a pause or a switch to Personal does, but only for a cancellation
-- scheduled after BILLING_PARK_ON_CANCEL_ENABLED went on. Nobody who
-- cancelled earlier is affected, so the moment is recorded per subscription.
-- And a parked inbox can be swapped with an active one from the Inboxes page,
-- at most once a day per workspace.
--
-- WHAT.
--   1. user_billing.park_on_end_subscription_id / park_on_end_marked_at:
--      the Stripe subscription whose end parks inboxes, and when the webhook
--      first saw its cancellation scheduled with the flag on. Both or
--      neither. Cleared when the cancellation is undone. Only the service
--      role writes user_billing, so a customer cannot clear their own marker.
--   2. workspaces.inbox_swapped_at: the last swap of a parked inbox. The
--      swap route claims it with a conditional update, so two clicks cannot
--      both swap. workspaces has no user write grant at all
--      (20261016160100), so a customer cannot reset it.
--
-- DEPLOY ORDER. Apply before the web push. The web code reads these columns
-- in their own queries and skips the work on an unknown-column error, so
-- applying late only delays a feature that is off by default.
--
-- Idempotent: IF NOT EXISTS columns, constraint dropped and re-added.
-- ============================================================================

ALTER TABLE public.user_billing
  ADD COLUMN IF NOT EXISTS park_on_end_subscription_id text,
  ADD COLUMN IF NOT EXISTS park_on_end_marked_at       timestamptz;

ALTER TABLE public.user_billing DROP CONSTRAINT IF EXISTS user_billing_park_on_end_pair_check;
ALTER TABLE public.user_billing
  ADD CONSTRAINT user_billing_park_on_end_pair_check
  CHECK ((park_on_end_subscription_id IS NULL) = (park_on_end_marked_at IS NULL));

COMMENT ON COLUMN public.user_billing.park_on_end_subscription_id IS
  'Stripe subscription whose end parks inboxes above Free''s cap (decision D3). '
  'Set when its cancellation was scheduled with BILLING_PARK_ON_CANCEL_ENABLED on; '
  'cleared on undo. See apps/web/src/lib/billing/park-on-cancel.ts.';
COMMENT ON COLUMN public.user_billing.park_on_end_marked_at IS
  'When park_on_end_subscription_id was set.';

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS inbox_swapped_at timestamptz;

COMMENT ON COLUMN public.workspaces.inbox_swapped_at IS
  'Last swap of a parked inbox with an active one (one per rolling 24 hours). '
  'Written by /api/inboxes/swap-parked only.';
