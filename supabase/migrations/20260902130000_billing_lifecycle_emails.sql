-- ============================================================
-- MCPEmails - billing lifecycle email queue + marketing suppression
-- 20260902130000_billing_lifecycle_emails
-- ============================================================
--
-- WHY
-- ---
-- There is no dunning. A declined renewal today produces exactly one visible
-- effect: `user_billing.subscription_status` flips to `past_due`, the webhook
-- deliberately keeps the customer entitled, and nobody, customer or founder,
-- is ever told. At five paying subscriptions a single declined $5 card is 22%
-- of MRR, so the cheapest revenue available is the revenue that already said
-- yes once.
--
-- WHAT THIS CREATES
-- -----------------
--   1. public.billing_email_sends - a queue AND a send ledger in one table.
--   2. public.email_suppressions  - the marketing opt-out list.
--
-- WHY ONE TABLE IS BOTH QUEUE AND LEDGER
-- --------------------------------------
-- The alternative is a ledger of what was sent plus a separate state machine
-- that decides what to send next, and the state machine is where duplicates
-- come from: it has to re-derive "is day 3 due yet" on every tick, from data
-- that Stripe is concurrently changing underneath it. Here the entire sequence
-- is materialised ONCE at trigger time, one row per email, each carrying its
-- own `send_after`. The dispatcher then has no decisions to make. It claims
-- due rows and sends them. A sequence that has been queued cannot be queued
-- again, because of:
--
--   UNIQUE (stripe_customer_id, template, scope_key)
--
-- which is the per-(customer, template, invoice) guarantee the brief asks for.
-- `scope_key` is the invoice id for the dunning series and the subscription id
-- for the cancellation series, so the same constraint covers both. Stripe
-- redelivering `invoice.payment_failed` five times inserts the sequence once
-- and conflicts four times. This sits BEHIND the existing
-- `stripe_webhook_events` event-id ledger, not instead of it: that one stops a
-- redelivered event id, this one stops two DIFFERENT events describing the
-- same failed invoice.
--
-- WHY `category` IS A GENERATED COLUMN
-- ------------------------------------
-- Dunning and payment-failure notices are transactional service messages under
-- the contract. They need no opt-in and they must NOT be suppressible: a
-- customer who unsubscribed from a win-back email in March must still be told
-- in June that their card was declined. The day-14 and day-30 win-back is
-- marketing-adjacent and needs the opposite treatment.
--
-- Keeping those two categories apart with a convention, or with a lookup table
-- somebody has to remember to populate, is exactly the mistake that ends with a
-- customer opted out of their own payment-failure notice. So the category is
-- not a value anybody writes. It is DERIVED from the template name by the
-- database, and only the `winback_*` templates can ever be marketing. Renaming
-- a template cannot silently reclassify it; the CHECK on `template` below has
-- to be edited first, in the same file as this rule.
--
-- WHY NOT pg_cron FOR THE DELAYS
-- ------------------------------
-- Nothing here is scheduled per-email. One cron job asks a dispatcher "is
-- anything due?", exactly as dispatch_scheduled_sends() and
-- dispatch_triage_rules() already do. See the companion migration
-- 20260902130100_schedule_billing_lifecycle.sql.
--
-- Related: 20260606000001_stripe_webhook_events.sql (the event-id ledger),
-- 20260606000000_user_level_billing.sql (user_billing, the owner resolution),
-- 20260819190000_schedule_triage_dispatch.sql (the dispatcher pattern copied).
-- ============================================================


-- ---------------------------------------------------------------------------
-- The queue / ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.billing_email_sends (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Who. The Stripe customer is the stable key (it survives an email change),
  -- `user_id` is the best-effort join back into our own tables and may be NULL
  -- if the owner could not be resolved at queue time.
  stripe_customer_id     text NOT NULL,
  user_id                uuid REFERENCES public.users(id) ON DELETE CASCADE,

  -- The address resolved at QUEUE time, deliberately. If a customer changes
  -- their billing email midway through a dunning sequence we would rather
  -- finish the sequence to the address that was on the failing invoice than
  -- send half of it to one mailbox and half to another.
  recipient              text NOT NULL,

  -- Which email. The CHECK is the whole classification scheme; see the
  -- generated `category` below.
  template               text NOT NULL CHECK (template IN (
                           -- transactional: the payment is broken or about to be
                           'dunning_1', 'dunning_3', 'dunning_7', 'dunning_14',
                           'card_expiry_30', 'card_expiry_7',
                           -- transactional: they cancelled, we ask one question
                           'cancel_ask',
                           -- marketing-adjacent: they are already gone
                           'winback_14', 'winback_30'
                         )),

  -- DERIVED, never written. Only a winback_* template can be marketing, and
  -- the dispatcher consults the suppression list for marketing rows only.
  category               text GENERATED ALWAYS AS (
                           CASE WHEN template LIKE 'winback\_%' THEN 'marketing'
                                ELSE 'transactional' END
                         ) STORED,

  -- What this email is ABOUT. The invoice id for the dunning series, the
  -- subscription id for the cancellation and win-back series, the payment
  -- method id plus expiry for the card-expiry warnings. Combined with
  -- (customer, template) it is the idempotency key.
  scope_key              text NOT NULL,

  -- When it becomes due. `dunning_1` is queued with send_after = now(), which
  -- puts it inside the "within 60 minutes" window on the next dispatcher tick.
  send_after             timestamptz NOT NULL,

  -- Terminal states. Exactly one of these is non-NULL on a finished row.
  sent_at                timestamptz,
  cancelled_at           timestamptz,
  -- Why it was cancelled: 'payment_recovered', 'subscription_reactivated',
  -- 'subscription_deleted', 'suppressed', 'card_replaced', 'no_longer_due',
  -- 'undeliverable', 'manual'.
  cancel_reason          text,

  -- Dispatch bookkeeping.
  claimed_at             timestamptz,
  attempts               smallint NOT NULL DEFAULT 0,
  last_error             text,
  resend_id              text,

  -- Everything the composer needs that is not worth a column: plan id,
  -- interval, amount, currency, Stripe decline code and message, hosted
  -- invoice url, period end, card brand and last4. Read, never queried on.
  payload                jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  -- A row is pending, sent, or cancelled. Never two at once.
  CONSTRAINT billing_email_sends_single_outcome
    CHECK (sent_at IS NULL OR cancelled_at IS NULL)
);

-- THE idempotency guarantee. One (customer, template, thing-it-is-about) can
-- only ever be queued once, so a Stripe redelivery, a second event type
-- describing the same failure, and a concurrent dispatcher all collapse to one
-- email. A customer receiving four copies of "your payment failed" is a
-- support incident; this is the constraint that makes it impossible.
CREATE UNIQUE INDEX IF NOT EXISTS billing_email_sends_identity
  ON public.billing_email_sends (stripe_customer_id, template, scope_key);

-- The dispatcher's only query: what is due, oldest first.
CREATE INDEX IF NOT EXISTS billing_email_sends_due
  ON public.billing_email_sends (send_after)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;

-- Cancelling a whole in-flight sequence when the payment recovers.
CREATE INDEX IF NOT EXISTS billing_email_sends_open_scope
  ON public.billing_email_sends (stripe_customer_id, scope_key)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;

DROP TRIGGER IF EXISTS billing_email_sends_updated_at ON public.billing_email_sends;
CREATE TRIGGER billing_email_sends_updated_at
  BEFORE UPDATE ON public.billing_email_sends
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at);

COMMENT ON TABLE public.billing_email_sends IS
  'Queue and send ledger for billing lifecycle email (dunning, card expiry, '
  'cancellation save, win-back). The whole sequence is materialised at trigger '
  'time, one row per email, each with its own send_after; the dispatcher only '
  'claims due rows. UNIQUE (stripe_customer_id, template, scope_key) is the '
  'idempotency guarantee. See 20260902130000_billing_lifecycle_emails.sql.';

COMMENT ON COLUMN public.billing_email_sends.category IS
  'GENERATED, never written. Only winback_* is marketing; everything else is a '
  'transactional service message that must NOT be suppressible. Reclassifying '
  'a template requires editing the CHECK on template in the same migration.';

COMMENT ON COLUMN public.billing_email_sends.scope_key IS
  'What the email is about: Stripe invoice id (dunning), subscription id '
  '(cancellation + win-back), payment method id and expiry (card expiry).';

-- Service-role only. Nothing in the browser reads or writes this.
ALTER TABLE public.billing_email_sends ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- Marketing suppression: DELIBERATELY NOT DEFINED HERE
-- ---------------------------------------------------------------------------
--
-- An earlier draft of this migration created its own `email_suppressions`
-- table keyed on the email address. It was deleted before it ever ran, because
-- 20260902140000_lifecycle_email_preferences.sql already adds exactly
-- this, better:
--
--   users.unsubscribed_at          global opt-out
--   users.unsubscribed_categories  per-category, CHECKed against
--                                  ('lifecycle', 'product_update', 'research')
--   users.unsubscribe_token        unguessable uuid for the unauthenticated
--                                  one-click link
--
-- and /api/email/unsubscribe already implements RFC 8058 one-click against it.
--
-- Two opt-out systems is worse than either one of them alone. A reader who
-- unsubscribes from a founder email and then receives a win-back has not been
-- given a broken link, they have been given a broken promise, and no amount of
-- correctness in either table fixes that. So the win-backs in this file use the
-- `lifecycle` category on the shared columns, and this migration adds no
-- suppression storage at all.
--
-- The split that DOES matter is still enforced here, in the generated
-- `category` column above: only a `winback_*` template ever consults those
-- preferences. A payment-failure notice does not read them and cannot be
-- switched off by them.

-- ---------------------------------------------------------------------------
-- The atomic claim
-- ---------------------------------------------------------------------------
--
-- WHY AN RPC AND NOT A SELECT-THEN-UPDATE FROM THE ROUTE
-- -----------------------------------------------------
-- pg_net fires the dispatcher and returns immediately, so a slow run and the
-- next cron tick can overlap. Two dispatchers that each SELECT the due rows and
-- then UPDATE them both see the same rows, and the customer gets two copies of
-- "your payment failed". Claiming has to be one statement.
--
-- FOR UPDATE SKIP LOCKED makes a concurrent claim take the NEXT rows instead of
-- blocking on these, so an overlap costs nothing and duplicates nothing.
--
-- TWO ESCAPE HATCHES ARE BUILT IN:
--   attempts < 5           a row that fails five times stops being retried and
--                          stays visible in the table rather than being retried
--                          forever against a permanently bad address.
--   claimed_at lease       a dispatcher that dies mid-send leaves a claimed but
--                          unsent row; after 15 minutes it becomes claimable
--                          again. That is deliberately longer than any single
--                          dispatcher run, and the Resend Idempotency-Key on
--                          the send is what makes re-claiming safe: a row whose
--                          email actually went out before the crash is
--                          collapsed by Resend rather than delivered twice.

CREATE OR REPLACE FUNCTION public.claim_billing_emails(p_limit integer DEFAULT 25)
RETURNS SETOF public.billing_email_sends
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.billing_email_sends AS b
     SET claimed_at = now(),
         attempts   = b.attempts + 1
   WHERE b.id IN (
           SELECT id
             FROM public.billing_email_sends
            WHERE sent_at IS NULL
              AND cancelled_at IS NULL
              AND send_after <= now()
              AND attempts < 5
              AND (claimed_at IS NULL OR claimed_at < now() - INTERVAL '15 minutes')
            ORDER BY send_after
            LIMIT GREATEST(1, LEAST(p_limit, 200))
              FOR UPDATE SKIP LOCKED
         )
  RETURNING b.*;
$$;

COMMENT ON FUNCTION public.claim_billing_emails(integer) IS
  'Atomically claims up to p_limit due billing lifecycle emails and returns '
  'them. One statement, FOR UPDATE SKIP LOCKED, so two overlapping dispatcher '
  'runs can never claim the same row. Service-role only.';

-- SECURITY DEFINER plus Supabase default grants would let anon or a browser
-- session claim (and therefore consume) queued emails through /rest/v1/rpc.
REVOKE EXECUTE ON FUNCTION public.claim_billing_emails(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_billing_emails(integer) TO service_role;
