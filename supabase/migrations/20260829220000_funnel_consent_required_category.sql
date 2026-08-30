-- Add 'consent_required' to the product funnel error categories.
--
-- This is the dominant Outlook connection failure for business users and it
-- needs to be distinguishable from every other kind of failure, because the
-- remedy is completely different: nothing the user does can fix it, a tenant
-- administrator has to approve the app.
--
-- Since late 2025 Microsoft's managed default consent policy (the default for
-- every new tenant) excludes Mail.Read / Mail.ReadWrite / Mail.ReadBasic from
-- the delegated permissions an end user is allowed to consent to. A Microsoft
-- 365 employee clicking "Connect Outlook" is refused before ever reaching a
-- consent screen.
--
-- Folding that into 'provider_denied' would be actively misleading: that value
-- means the person looked at the consent screen and said no, which is a signal
-- about our product. This is a tenant policy that the person never got to
-- answer, which is a signal about their employer. Counting the two together
-- would read as users rejecting us.

-- IF EXISTS because this project has a diverged migration history and DDL is
-- routinely applied to prod directly, so this file has to survive being run a
-- second time by a later `db push`.
ALTER TABLE public.product_funnel_events
  DROP CONSTRAINT IF EXISTS product_funnel_events_error_category_check;

ALTER TABLE public.product_funnel_events
  ADD CONSTRAINT product_funnel_events_error_category_check
  CHECK (error_category IS NULL OR error_category IN (
    'auth_failed', 'validation_failed', 'provider_denied', 'token_exchange_failed',
    'plan_limit', 'conflict', 'persistence_failed', 'unknown',
    -- Blocked by the mailbox provider's own consent policy before the user
    -- could answer. Recovery is an administrator action, not a user action.
    'consent_required',
    'price_not_configured', 'subscription_exists', 'stripe_error', 'no_customer'
  ));
