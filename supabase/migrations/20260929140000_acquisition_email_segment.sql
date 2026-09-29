-- The business-domain segment, recorded where it can be measured.
--
-- WHY. Signups on a company's own domain pay at roughly three times the rate of
-- consumer signups (7.7% against 2.4% for signups since 2026-08-01), and the
-- product now treats them differently: the inbox paywall recommends Pro to them
-- and the Overview guide prompts a second work mailbox. Until now the segment
-- existed only as a boolean computed in the browser, so "did that change move
-- conversion?" could only be answered by re-deriving the classification in SQL
-- from auth.users, with a second consumer-domain list that would drift from the
-- one the paywall actually uses (apps/web/src/lib/segment/consumer-domains.mjs).
--
-- WHAT.
--
--   1. workspaces.acquisition_email_segment: the segment of the OWNER's signup
--      email, as classified by emailSegment() in that module, written once by
--      the app (apps/web/src/lib/segment/record-segment.ts) and never
--      overwritten. It sits with the other acquisition_* columns because it is
--      the same kind of fact: something true about how the workspace arrived,
--      fixed at signup. It is a WORD, never the address or the domain: the
--      bucket is what analysis needs, and the domain would be customer data in
--      an analytics column.
--
--      NULL means "not classified yet", which is every workspace created
--      before this column, until apps/web/scripts/backfill-email-segment.mjs is
--      run, and a new one until its owner's first dashboard render.
--
--   2. A funnel stage, `multi_inbox_prompt`, for the Overview guide's prompt to
--      connect a second work mailbox. outcome `started` = shown, `success` =
--      clicked, at most one of each per workspace (deduped in the app, like
--      pricing_viewed). category is the plan at that moment, from the existing
--      bounded vocabulary. No new category or error_category values.
--
-- The app tolerates this migration being unapplied: every write below is
-- best-effort and logged, and nothing reads the column on a request path.

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS acquisition_email_segment text;

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_acquisition_email_segment_check;
ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_acquisition_email_segment_check
  CHECK (
    acquisition_email_segment IS NULL
    OR acquisition_email_segment IN ('business', 'consumer', 'academic', 'unknown')
  );

COMMENT ON COLUMN public.workspaces.acquisition_email_segment IS
  'Segment of the owner''s signup email: business | consumer | academic | unknown. '
  'Set once by the app from emailSegment() in apps/web/src/lib/segment/consumer-domains.mjs; '
  'NULL = not classified yet.';

-- ---------------------------------------------------------------------------
-- 2. stage vocabulary
--
-- Current definition is 20260914120000, reproduced verbatim with one addition.
-- ---------------------------------------------------------------------------
ALTER TABLE public.product_funnel_events
  DROP CONSTRAINT IF EXISTS product_funnel_events_stage_check;
ALTER TABLE public.product_funnel_events
  ADD CONSTRAINT product_funnel_events_stage_check
  CHECK (stage IN (
    'onboarding_started', 'client_selected', 'provider_selected', 'inbox_connection',
    'connection_verified', 'credential_created', 'technical_activation',
    'value_activation', 'first_tool_call',
    -- Billing funnel
    'paywall_reached', 'pricing_viewed', 'checkout_started', 'checkout_completed',
    'billing_portal_opened',
    -- An existing subscriber's price was swapped in place, in either direction.
    'plan_upgraded', 'plan_downgraded',
    -- The Overview guide asked a business-domain workspace to connect a second
    -- work mailbox: started = shown, success = clicked.
    'multi_inbox_prompt'
  ));
