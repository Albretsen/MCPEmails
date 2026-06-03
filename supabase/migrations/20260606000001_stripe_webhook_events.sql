-- ============================================================
-- MCPEmails — Stripe webhook idempotency ledger
-- 20260606000001_stripe_webhook_events
--
-- WHY
--   The Stripe webhook had no event dedupe and no out-of-order guard. Stripe
--   retries and redelivers events, so a stale `customer.subscription.updated`
--   (status=past_due → free) could be replayed AFTER a newer `active` event and
--   clobber a paying customer back down to free.
--
-- WHAT
--   `stripe_webhook_events` records every processed Stripe event id. The webhook
--   does an INSERT ... ON CONFLICT DO NOTHING keyed by the Stripe `event.id`;
--   if the row already existed (0 rows inserted) the event is a duplicate and is
--   skipped. We also store the event's `created` timestamp so the handler can
--   ignore events older than the last-applied state for a given customer.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  -- Stripe event id, e.g. "evt_1abc...". The primary key gives us dedupe for free.
  event_id     text PRIMARY KEY,
  -- The Stripe event type, e.g. "customer.subscription.updated" (for debugging).
  event_type   text,
  -- The event's Stripe `created` time (unix → timestamptz). Used as the
  -- out-of-order watermark per customer.
  event_created timestamptz,
  -- The Stripe customer this event pertained to, if any (for the watermark).
  stripe_customer_id text,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_customer
  ON public.stripe_webhook_events (stripe_customer_id, event_created DESC)
  WHERE stripe_customer_id IS NOT NULL;

COMMENT ON TABLE public.stripe_webhook_events IS
  'Idempotency ledger for Stripe webhook delivery. INSERT ON CONFLICT DO '
  'NOTHING keyed by Stripe event_id; a 0-row insert means the event was already '
  'processed and must be skipped. See 20260606000001_stripe_webhook_events.sql.';

-- Service-role only: no RLS policies (the service-role client bypasses RLS).
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
