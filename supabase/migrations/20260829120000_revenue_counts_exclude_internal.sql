-- ===========================================================================
-- Make "paying" mean money received.
--
-- WHY THIS FILE EXISTS
-- On 2026-08-29 /admin/growth and the kiosk both read "1 paying customer".
-- The single row was the owner's own test account on a 100%-off-forever Stripe
-- subscription created to exercise the new Personal tier. It pays nothing, and
-- real paying customers were still zero. Two separate defects produced that
-- one wrong number:
--
--   1. An internal account was counted as a customer. Every other growth
--      surface that returns aggregates already excludes internal accounts by
--      taking the address list as an argument (see growth_retention_curve in
--      20260819140000). growth_revenue_counts never did, so the headline
--      revenue figure was the one place ours could pose as theirs.
--
--   2. A 100%-off subscription writes exactly the same `workspaces.plan` value
--      as a real purchase. The existing `comped_scale` entitlement check
--      catches comps granted through support, but NOT comps granted as a
--      Stripe discount.
--
-- THE DISCOUNT IS NOT IN THIS DATABASE  (read before trusting these numbers)
-- The webhook (apps/web/app/api/stripe/webhook/route.ts) persists customer id,
-- subscription id, subscription status, plan and the period bounds. It never
-- persists the amount, the coupon, the discount or the price actually charged;
-- `session.amount_total` is read once and handed to the confirmation email,
-- then dropped. So for an EXTERNAL account, no query against this database can
-- separate a full-price subscriber from a 100%-off one. To close that hole for
-- real, the webhook would have to store, per subscription, either the recurring
-- amount actually charged after discounts or an explicit comp flag derived from
-- the coupon (`discount.coupon.percent_off = 100`), and this function would
-- then filter on it. Until such a column exists, the guarantee below is:
-- comped-by-entitlement is excluded, internal is excluded, and an external
-- Stripe discount would still count as revenue.
--
-- WHAT DELIBERATELY DOES NOT CHANGE
-- Signup, activation, engagement and usage counters are untouched. Internal
-- accounts are real load and must keep appearing there. This migration narrows
-- the REVENUE counters only, and the accounts it removes are not hidden: they
-- are reported in their own new columns.
--
-- Forward-only. No previously applied migration file is edited.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. growth_is_internal_email(email, emails, domains)
--
-- The predicate growth_retention_curve spells out inline, lifted into one
-- place so the revenue counter cannot drift away from it. The list itself
-- still arrives as an argument and is never written into SQL: this repository
-- is public and the addresses are personal (GROWTH_INTERNAL_EMAILS, read by
-- apps/web/src/lib/analytics/internal-accounts.ts).
--
-- One addition over the inline version: a plus tag is stripped before the
-- address is compared. `bjellanda+test@gmail.com` is the same mailbox as
-- `bjellanda@gmail.com`, so if the base address is ours the tagged one is ours
-- too. That is exactly how the account in the incident above was created, and
-- without this rule every future +test account has to be remembered by hand.
-- Domain matching is unchanged.
--
-- An owner with no users row cannot be matched and counts as EXTERNAL, which
-- matches isInternalAccount() and the retention curve: overstating external
-- usage is the safe direction to be wrong in.
--
-- NOTE: growth_retention_curve keeps its own inline copy of this predicate and
-- still compares addresses exactly. The two agree on every address without a
-- plus tag. Pointing it at this helper is a safe follow-up, kept out of this
-- migration so a revenue fix cannot move the retention curve.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_is_internal_email(
  p_email text,
  p_internal_emails text[],
  p_internal_domains text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH addr AS (
    SELECT
      lower(coalesce(p_email, '')) AS full_address,
      -- 'name+anything@host' -> 'name@host'. Addresses without a tag are
      -- returned unchanged.
      regexp_replace(lower(coalesce(p_email, '')), '\+[^@]*@', '@') AS untagged
  )
  SELECT coalesce(
    a.full_address <> ''
    AND (
      EXISTS (
        SELECT 1 FROM unnest(coalesce(p_internal_emails, '{}')) AS e(address)
        WHERE lower(e.address) IN (a.full_address, a.untagged)
      )
      OR EXISTS (
        SELECT 1 FROM unnest(coalesce(p_internal_domains, '{}')) AS d(domain)
        WHERE a.full_address LIKE '%' || lower(d.domain)
      )
    ),
    false
  )
  FROM addr a;
$$;

COMMENT ON FUNCTION public.growth_is_internal_email(text, text[], text[]) IS
  'True when an owner address is one of ours (exact match, plus-tag-insensitive, or on an internal domain). The address list is passed in from GROWTH_INTERNAL_EMAILS, never stored in SQL.';

REVOKE ALL ON FUNCTION public.growth_is_internal_email(text, text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_is_internal_email(text, text[], text[]) TO service_role;


-- ---------------------------------------------------------------------------
-- 2. growth_revenue_counts(p_internal_emails, p_internal_domains)
--
-- Current definition is 20260827100000 (which replaced 20260813170000 to add
-- the Personal tier). Both arguments default to '{}', so an existing zero-arg
-- call keeps resolving and keeps its old meaning: pass nothing and nothing is
-- excluded as internal.
--
-- The eight existing columns keep their exact names and are never repurposed;
-- the admin page and the kiosk read them by name. Their contents change only
-- where the fix requires it:
--
--   paying_workspaces  ) paid plan, no comped entitlement, AND NOT INTERNAL.
--   paying_owners      ) The internal filter is the new part.
--   paying_personal    )
--   paying_solo        )
--   paying_scale       )
--
--   comped_workspaces  ) UNCHANGED. A comp is a billing fact about a real
--   comped_owners      ) person, and several comped accounts are external
--                        users given a free plan for good feedback. Filtering
--                        internal out of here would hide comps rather than
--                        report them.
--   free_workspaces      UNCHANGED. It is a population count feeding the plan
--                        mix chart, not a revenue figure, and it must keep
--                        seeing internal accounts.
--
-- Two columns are APPENDED (appended, not inserted, so any positional consumer
-- keeps working) to keep the excluded accounts visible rather than invisible:
--
--   internal_workspaces         every live workspace owned by an internal
--                               account, on any plan.
--   internal_paying_workspaces  the subset on a paid plan with no comped
--                               entitlement: precisely the rows the new filter
--                               removes from paying_workspaces. When the page
--                               says "0 paying, 1 internal" this is the 1.
--
-- DROP before CREATE: the return column list changes and CREATE OR REPLACE
-- cannot alter a function's return type (42P13). The drop discards grants, so
-- they are restated below.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.growth_revenue_counts();

CREATE FUNCTION public.growth_revenue_counts(
  p_internal_emails text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
RETURNS TABLE (
  paying_workspaces int,
  paying_owners int,
  comped_workspaces int,
  comped_owners int,
  free_workspaces int,
  paying_solo int,
  paying_scale int,
  paying_personal int,
  internal_workspaces int,
  internal_paying_workspaces int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH scoped AS (
    SELECT
      w.id,
      w.owner_id,
      coalesce(w.plan, 'free') AS plan,
      -- coalesce for the same reason as before: a NULL here would make every
      -- `NOT is_comped` filter drop the account instead of counting it.
      coalesce(e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now()), false) AS is_comped,
      public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains) AS is_internal
    FROM public.workspaces w
    LEFT JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
    LEFT JOIN public.users u ON u.id = w.owner_id
    WHERE w.deleted_at IS NULL
  ),
  -- One name for "this is money", so the five paying counters cannot drift
  -- apart from each other the way the plan lists did before 20260827100000.
  flagged AS (
    SELECT
      s.*,
      (s.plan IN ('personal', 'solo', 'pro') AND NOT s.is_comped AND NOT s.is_internal) AS is_paying
    FROM scoped s
  )
  SELECT
    count(*) FILTER (WHERE is_paying)::int AS paying_workspaces,
    count(DISTINCT owner_id) FILTER (WHERE is_paying)::int AS paying_owners,
    count(*) FILTER (WHERE is_comped)::int AS comped_workspaces,
    count(DISTINCT owner_id) FILTER (WHERE is_comped)::int AS comped_owners,
    count(*) FILTER (WHERE plan = 'free' AND NOT is_comped)::int AS free_workspaces,
    count(*) FILTER (WHERE is_paying AND plan = 'solo')::int AS paying_solo,
    count(*) FILTER (WHERE is_paying AND plan = 'pro')::int AS paying_scale,
    count(*) FILTER (WHERE is_paying AND plan = 'personal')::int AS paying_personal,
    count(*) FILTER (WHERE is_internal)::int AS internal_workspaces,
    count(*) FILTER (WHERE is_internal AND NOT is_comped AND plan IN ('personal', 'solo', 'pro'))::int
      AS internal_paying_workspaces
  FROM flagged;
$$;

COMMENT ON FUNCTION public.growth_revenue_counts(text[], text[]) IS
  'Paying versus comped versus free workspaces. Paying means a paid plan held by an external owner with no comped_scale entitlement. A 100%-off Stripe discount is NOT visible here: the webhook stores no amount or coupon, so an external discounted subscription still counts as paying.';

-- Same posture as 20260813170000 and 20260827100000: SECURITY INVOKER,
-- service-role only. It reads user_usage_entitlements and users.email, so an
-- accidental grant would leak the customer list. The DROP above discarded the
-- old grants, so restate them.
REVOKE ALL ON FUNCTION public.growth_revenue_counts(text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_revenue_counts(text[], text[]) TO service_role;
