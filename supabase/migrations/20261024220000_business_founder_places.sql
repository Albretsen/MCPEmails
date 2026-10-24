-- ===========================================================================
-- Business founder price: the place counter and its runtime flag.
-- 20261024220000_business_founder_places
--
-- Business is sold at a founder price ($29 a month, $278.40 a year) to the
-- first 20 Business subscriptions, from 2026-11-09 to 2026-12-31 23:59 Oslo.
-- The window and the cap are enforced in apps/web/src/lib/stripe/founder-offer.ts;
-- this migration holds the two facts that code needs from the database:
--
--   1. business_founder_places: one row per Stripe subscription on a founder
--      price, written by the Stripe webhook once the subscription is paid.
--      Places left = 20 minus the rows. Never written by hand, never deleted
--      or decremented: a refund or a cancel does not give a place back, so the
--      public counter only ever goes down. The table also answers "does this
--      owner already have a founder subscription" (one per owner).
--      service_role may only SELECT and INSERT it.
--   2. pricing_switches('business_founder_price'), the runtime flag. Seeded
--      OFF, so this migration changes nothing a customer sees.
--
-- record_business_founder_place() is the one writer. It skips internal
-- accounts (growth_is_internal_email), so our own test purchases never take a
-- place, and it is idempotent: Stripe retries and repeated
-- customer.subscription.updated events conflict on the primary key.
--
-- mcp-server never reads either, so the self-host schema does not carry them.
--
-- Forward-only, every step safe to re-run.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.business_founder_places (
  stripe_subscription_id text PRIMARY KEY,
  -- No foreign key on purpose: deleting an account must not delete the row
  -- and hand the place back.
  owner_id               uuid NOT NULL,
  "interval"             text NOT NULL CHECK ("interval" IN ('month', 'year')),
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS business_founder_places_owner_idx
  ON public.business_founder_places (owner_id);

-- Server-owned: RLS on, no policies, no grants to anon/authenticated. The
-- service role reads and inserts; it may not UPDATE or DELETE a row, so no
-- code path can give a place back. (It keeps TRUNCATE, REFERENCES, TRIGGER
-- and MAINTAIN like on every public table; see api_roles_no_truncate.sql.)
ALTER TABLE public.business_founder_places ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.business_founder_places FROM PUBLIC, anon, authenticated;
REVOKE UPDATE, DELETE ON TABLE public.business_founder_places FROM service_role;
GRANT SELECT, INSERT ON TABLE public.business_founder_places TO service_role;

COMMENT ON TABLE public.business_founder_places IS
  'One row per Business subscription sold at the 2026 founder price. Written '
  'only by the Stripe webhook through record_business_founder_place(); never '
  'updated or deleted. Places left = 20 minus count(*).';

-- ---------------------------------------------------------------------------
-- The one writer. Returns true when a row was inserted, false when the owner
-- is internal or the subscription already holds a place.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_business_founder_place(
  p_subscription_id text,
  p_owner_id uuid,
  p_interval text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email text;
BEGIN
  IF p_subscription_id IS NULL OR p_subscription_id = '' OR p_owner_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT u.email INTO v_email FROM public.users u WHERE u.id = p_owner_id;
  IF v_email IS NOT NULL AND public.growth_is_internal_email(v_email) THEN
    RETURN false;
  END IF;

  INSERT INTO public.business_founder_places (stripe_subscription_id, owner_id, "interval")
  VALUES (p_subscription_id, p_owner_id, p_interval)
  ON CONFLICT (stripe_subscription_id) DO NOTHING;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.record_business_founder_place(text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_business_founder_place(text, uuid, text) TO service_role;

COMMENT ON FUNCTION public.record_business_founder_place(text, uuid, text) IS
  'Records a paid founder-price Business subscription. Skips internal accounts; '
  'idempotent on the subscription id.';

-- ---------------------------------------------------------------------------
-- The runtime flag. Seeded OFF. ON CONFLICT DO NOTHING so a re-run never
-- turns off an offer that is running.
-- ---------------------------------------------------------------------------
INSERT INTO public.pricing_switches (key, enabled, note)
VALUES ('business_founder_price', false,
        'Business founder price ($29 / $278.40) for the first 20 Business '
        'subscriptions, 2026-11-09 to 2026-12-31 Oslo. The window and the cap '
        'are also enforced in code.')
ON CONFLICT (key) DO NOTHING;
