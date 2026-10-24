-- ============================================================================
-- 2026-10-24: the abandoned-checkout reminder, measured.
--
-- When a Stripe Checkout session expires unpaid, the webhook writes ONE row to
-- `lifecycle_email_sends` for the buyer (see
-- apps/web/src/lib/email/abandoned-checkout.ts):
--
--   template     abandoned_checkout_<plan>_<interval>, e.g. abandoned_checkout_personal_month
--   trigger_key  the expired Checkout session id
--   status       sent / failed / claimed for the send arm,
--                skipped + detail 'holdout' for the 20% holdout arm
--
-- These three columns record what happened next, for BOTH arms, so the
-- holdout comparison is a single query on this table:
--
--   recovered_at          when the same user completed a checkout within 30
--                         days of the reminder row
--   recovered_session_id  that completed Checkout session
--   recovered_via_link    true when the completed session was opened from the
--                         reminder's own link (its metadata.recovered_from
--                         names this row's trigger_key)
--
-- Additive, nullable, no default: older writers are unaffected.
-- ============================================================================

ALTER TABLE public.lifecycle_email_sends
  ADD COLUMN IF NOT EXISTS recovered_at timestamptz,
  ADD COLUMN IF NOT EXISTS recovered_session_id text,
  ADD COLUMN IF NOT EXISTS recovered_via_link boolean;

COMMENT ON COLUMN public.lifecycle_email_sends.recovered_at IS
  'Abandoned-checkout rows only: when the user completed a checkout within 30 days of this row. Set for sent and holdout rows alike.';
COMMENT ON COLUMN public.lifecycle_email_sends.recovered_session_id IS
  'Abandoned-checkout rows only: the completed Stripe Checkout session.';
COMMENT ON COLUMN public.lifecycle_email_sends.recovered_via_link IS
  'Abandoned-checkout rows only: true when that session came from the reminder link (metadata.recovered_from = trigger_key).';
