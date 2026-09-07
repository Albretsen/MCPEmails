-- ============================================================================
-- 2026-09-02: the plumbing a lifecycle email needs before it may be sent once.
--
-- This migration adds three things, all of which must exist BEFORE the first
-- non-transactional email leaves the building:
--
--   1. An opt-out on the user record: a global `unsubscribed_at` plus a
--      per-category array, so "stop the founder emails" and "stop everything
--      that is not a receipt" are separate answers to separate questions.
--   2. A stable, unguessable unsubscribe token, so the one-click List-Unsubscribe
--      endpoint works for someone who is not logged in and never has to accept
--      a user id in a URL.
--   3. A send ledger keyed on (user_id, template, trigger_key), inserted with
--      ON CONFLICT DO NOTHING, exactly like `stripe_webhook_events`. A 0-row
--      insert means "already sent, skip". An email arriving twice is worse
--      than it never arriving.
--
-- This is infrastructure, not a campaign. It is what any lifecycle (non
-- transactional) email needs in order to be sendable at all: the billing
-- dunning sequence in 20260902130000 reads the same opt-out columns through
-- `isSuppressed`, and the same one-click endpoint serves both.
--
-- A companion `bonus_inboxes` grant and an engaged-free-user segment function
-- were drafted alongside this on 2026-09-02 for a "personal ask" campaign that
-- was subsequently dropped. They were removed on 2026-09-07 before this
-- migration was ever applied; nothing here depends on them, and
-- `effective_workspace_plan` is left exactly as 20260819170500 wrote it.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1 + 2. Email preferences on the user record.
--
-- These live on `public.users` rather than in a side table because they are a
-- property of the person, they are read on every single send, and a join is a
-- place for a bug to hide in the one code path that must never send twice.
-- ---------------------------------------------------------------------------

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz,
  ADD COLUMN IF NOT EXISTS unsubscribed_categories text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS unsubscribe_token uuid NOT NULL DEFAULT gen_random_uuid();

COMMENT ON COLUMN public.users.unsubscribed_at IS
  'Global opt-out from every non-transactional email. Set by the one-click List-Unsubscribe endpoint. NULL = subscribed. Receipts, invites and security mail ignore this column and must keep sending.';

COMMENT ON COLUMN public.users.unsubscribed_categories IS
  'Per-category opt-out. Currently understood: lifecycle (founder and product-usage mail), product_update, research. A category listed here is suppressed even when unsubscribed_at is NULL.';

COMMENT ON COLUMN public.users.unsubscribe_token IS
  'Unguessable per-user token for the unauthenticated one-click unsubscribe link. Never a user id in a URL. Rotate by UPDATE ... SET unsubscribe_token = gen_random_uuid().';

-- Only the known categories may be stored. A typo in a category name would
-- otherwise read as "not opted out" forever and keep mailing someone who asked
-- us to stop, which is the one failure mode that is not recoverable.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_unsubscribed_categories_known;
ALTER TABLE public.users
  ADD CONSTRAINT users_unsubscribed_categories_known
  CHECK (unsubscribed_categories <@ ARRAY['lifecycle', 'product_update', 'research']::text[]);

-- The token is the only lookup key the unsubscribe endpoint has.
CREATE UNIQUE INDEX IF NOT EXISTS users_unsubscribe_token_key
  ON public.users (unsubscribe_token);

-- ---------------------------------------------------------------------------
-- 3. The send ledger.
--
-- Same shape and the same reasoning as `stripe_webhook_events`: the writer does
-- INSERT ... ON CONFLICT DO NOTHING and treats a 0-row result as "already
-- handled". The primary key is the dedupe.
--
--   template     which email, e.g. 'personal_ask_2026_09'.
--   trigger_key  which INSTANCE of it. For a one-shot campaign this is the
--                campaign id; for a recurring trigger it would be the thing
--                that fired (a month, a milestone). It exists so that "send
--                this template again next quarter" does not require a new
--                template name or a manual purge of the ledger.
--
-- `sent_at` is when we handed it to Resend, not when it was delivered. Resend's
-- message id is recorded so a support question about one specific email has an
-- answer that is not a guess.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.lifecycle_email_sends (
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  template      text NOT NULL,
  trigger_key   text NOT NULL,
  email         text NOT NULL,
  provider_message_id text,
  status        text NOT NULL DEFAULT 'sent'
                CHECK (status IN ('sent', 'failed', 'skipped')),
  detail        text,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, template, trigger_key)
);

COMMENT ON TABLE public.lifecycle_email_sends IS
  'Idempotency ledger for lifecycle (non-transactional) email. INSERT ON CONFLICT DO NOTHING keyed by (user_id, template, trigger_key); a 0-row insert means this person already has this email and must be skipped. Rows with status failed are deliberately KEPT: a failed attempt is still an attempt, and a blind retry is how someone gets two copies.';

COMMENT ON COLUMN public.lifecycle_email_sends.trigger_key IS
  'Which instance of the template fired. A one-shot campaign uses its campaign id; a recurring trigger uses the period or milestone that fired.';

CREATE INDEX IF NOT EXISTS idx_lifecycle_email_sends_template
  ON public.lifecycle_email_sends (template, trigger_key, sent_at DESC);

-- Operator-only. No policies, so PostgREST exposes nothing to an authenticated
-- user; the service-role client bypasses RLS and keeps working.
ALTER TABLE public.lifecycle_email_sends ENABLE ROW LEVEL SECURITY;
