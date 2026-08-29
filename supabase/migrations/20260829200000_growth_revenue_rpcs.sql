-- ===========================================================================
-- Revenue-stage RPCs for /admin/growth: upgrade pressure, inbox distribution
-- and acquisition channels.
--
-- WHY THIS FILE EXISTS
-- The page was built before the product had a price anyone could reach. It
-- measured the ACTION cap in four places (utilization bands, billable actions,
-- cap-hit workspaces, "near or over the cap"), which was the right thing to
-- measure while actions were the metered resource. The 2026-08-19 repricing
-- moved the value metric to CONNECTED INBOXES and demoted the action cap to a
-- silent abuse ceiling, and nothing on the page moved with it. The result is a
-- billing section whose every number is zero by construction: 259 of 260
-- workspaces sit in the bottom action band, nobody has ever hit that cap, and
-- the page therefore reports no upgrade pressure at all while 59 workspaces are
-- standing at the inbox ceiling right now.
--
-- `growth_upgrade_pressure` measures the gate that actually exists.
--
-- THE GRANDFATHER IS PART OF THE ANSWER, NOT A FOOTNOTE
-- Migration 20260819170500 gave every pre-repricing user unlimited inboxes
-- permanently. That is 164 free workspaces the inbox cap can never apply to,
-- 22 of which hold two or more inboxes and would be paying accounts under
-- current pricing. Any conversion rate computed over the whole estate is
-- therefore measured against a population most of which was never asked for
-- money. These functions split the two populations rather than averaging them,
-- for the same reason the billing funnel refuses to nest the cap stages: a
-- denominator that includes people who cannot be charged is not a denominator.
--
-- CAP SEMANTICS MATCH ENFORCEMENT EXACTLY
-- `checkInboxLimit` (src/lib/plans/check-inbox-limit.ts) counts inboxes with
-- `deleted_at IS NULL` per WORKSPACE, and treats a paid plan, a comped
-- entitlement or the grandfather as unlimited. This file uses the same three
-- exemptions and the same count, including inboxes whose status is not
-- 'active': a broken connection still occupies a slot, and a workspace whose
-- one inbox is failing is still refused a second one. Counting only active
-- inboxes here would report headroom the product does not grant.
--
-- The free cap is passed in as `p_free_inbox_cap` rather than written in SQL,
-- so it follows `PLANS.free.limits.maxInboxes` the way the action bands follow
-- `p_caps`. A pricing change moves this panel automatically.
--
-- ACQUISITION ATTRIBUTION IS PARTIAL AND SAYS SO
-- `workspaces.acquisition_source` was only instrumented on 2026-08-05 and even
-- since then lands null on roughly a third of signups (a direct hit with no
-- referrer and no utm carries nothing to attribute). `growth_acquisition_
-- channels` returns those as an explicit 'unattributed' row rather than
-- dropping them, so the mix is read against the real signup total and the
-- coverage gap is visible instead of inferred.
--
-- SECURITY
-- Same posture as 20260813140000 and 20260819090000: SECURITY INVOKER, EXECUTE
-- revoked from PUBLIC (anon and authenticated inherit through it) and granted
-- to service_role only. No function here returns an email address, a workspace
-- name, a workspace id or any free-text user content; output is counts plus
-- bounded server-authored category strings.
--
-- CONTRACT
-- `apps/web/src/lib/analytics/growth-types.ts` binds these OUT columns by name
-- and order. Generated database types do not cover functions, so changing a
-- column here without changing that file breaks the page silently.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- growth_upgrade_pressure(p_free_inbox_cap int)
--
-- One row describing the population the inbox paywall can actually reach.
--
-- "Capped" means a live workspace on the free plan whose owner holds neither
-- the permanent inbox grandfather nor an unexpired comped entitlement: the
-- exact set the cap is enforced against. "At the ceiling" means such a
-- workspace already holding `p_free_inbox_cap` inboxes, so its next connect
-- attempt is refused.
--
-- `at_ceiling_activated` is the number worth acting on. A workspace that hit
-- the ceiling without ever performing a mailbox operation is blocked by
-- onboarding, not by price; one that reached the ceiling AFTER getting value
-- out of the product is the only population an upgrade prompt can honestly be
-- measured against.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_upgrade_pressure(
  p_free_inbox_cap int DEFAULT 1
)
RETURNS TABLE (
  capped_workspaces int,
  at_ceiling int,
  at_ceiling_activated int,
  capped_activated int,
  grandfathered_workspaces int,
  grandfathered_over_free int,
  comped_workspaces int,
  paid_workspaces int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH live AS (
    SELECT
      w.id,
      w.owner_id,
      w.onboarding_value_activated_at IS NOT NULL AS activated,
      (
        SELECT count(*)
        FROM public.inboxes i
        WHERE i.workspace_id = w.id
          AND i.deleted_at IS NULL
      ) AS inboxes
    FROM public.workspaces w
    WHERE w.deleted_at IS NULL
  ),
  classified AS (
    SELECT
      live.activated,
      live.inboxes,
      COALESCE(e.unlimited_inboxes, false) AS grandfathered,
      COALESCE(
        e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now()),
        false
      ) AS comped,
      COALESCE(ub.plan, 'free') <> 'free' AS paid
    FROM live
    LEFT JOIN public.user_usage_entitlements e ON e.user_id = live.owner_id
    LEFT JOIN public.user_billing ub ON ub.user_id = live.owner_id
  ),
  -- One boolean per workspace, so the counters below cannot double count a
  -- workspace that is both comped and grandfathered (most comps are).
  flagged AS (
    SELECT
      activated,
      inboxes,
      paid,
      comped,
      grandfathered,
      (NOT paid AND NOT comped AND NOT grandfathered) AS capped
    FROM classified
  )
  SELECT
    count(*) FILTER (WHERE capped)::int,
    count(*) FILTER (WHERE capped AND inboxes >= greatest(p_free_inbox_cap, 1))::int,
    count(*) FILTER (WHERE capped AND inboxes >= greatest(p_free_inbox_cap, 1) AND activated)::int,
    count(*) FILTER (WHERE capped AND activated)::int,
    count(*) FILTER (WHERE grandfathered AND NOT paid AND NOT comped)::int,
    count(*) FILTER (WHERE grandfathered AND NOT paid AND NOT comped
                       AND inboxes > greatest(p_free_inbox_cap, 1))::int,
    count(*) FILTER (WHERE comped AND NOT paid)::int,
    count(*) FILTER (WHERE paid)::int
  FROM flagged;
$$;

-- ---------------------------------------------------------------------------
-- growth_inbox_distribution()
--
-- Live workspaces by how many inboxes they hold, split by whether the inbox
-- cap can reach them. Four bands, always all four, so the chart keeps a stable
-- shape while the estate grows into the upper ones.
--
-- Read the `capped` column against the `exempt` one: they are the same
-- histogram over two populations that are priced completely differently, and
-- averaging them is how "97% of workspaces are on Free" came to look like a
-- demand signal rather than a grandfather clause.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_inbox_distribution()
RETURNS TABLE (
  band text,
  band_index int,
  capped int,
  exempt int,
  paid int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH live AS (
    SELECT
      w.id,
      w.owner_id,
      (
        SELECT count(*)
        FROM public.inboxes i
        WHERE i.workspace_id = w.id
          AND i.deleted_at IS NULL
      ) AS inboxes
    FROM public.workspaces w
    WHERE w.deleted_at IS NULL
  ),
  classified AS (
    SELECT
      live.inboxes,
      COALESCE(ub.plan, 'free') <> 'free' AS paid,
      (
        COALESCE(e.unlimited_inboxes, false)
        OR COALESCE(
             e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now()),
             false
           )
      ) AS exempt
    FROM live
    LEFT JOIN public.user_usage_entitlements e ON e.user_id = live.owner_id
    LEFT JOIN public.user_billing ub ON ub.user_id = live.owner_id
  ),
  bands AS (
    SELECT * FROM (VALUES
      ('0 inboxes', 0, 0, 0),
      ('1 inbox',   1, 1, 1),
      ('2-3',       2, 2, 3),
      ('4+',        3, 4, 2147483647)
    ) AS b(band, band_index, lo, hi)
  )
  SELECT
    bands.band,
    bands.band_index,
    count(c.*) FILTER (WHERE NOT c.paid AND NOT c.exempt)::int,
    count(c.*) FILTER (WHERE NOT c.paid AND c.exempt)::int,
    count(c.*) FILTER (WHERE c.paid)::int
  FROM bands
  LEFT JOIN classified c ON c.inboxes BETWEEN bands.lo AND bands.hi
  GROUP BY bands.band, bands.band_index
  ORDER BY bands.band_index;
$$;

-- ---------------------------------------------------------------------------
-- growth_acquisition_channels(p_days int)
--
-- Where signups came from in the window, and what each channel did next.
--
-- Attribution is first-touch and only exists from 2026-08-05, so every
-- unattributed workspace is reported as its own 'unattributed' row instead of
-- being dropped. A channel table whose rows do not sum to the signup count is
-- a channel table that will eventually be read as if they did.
--
-- `returned` uses the page's single definition of the word: active on more
-- than one UTC day. It is computed from `activity_log`, which is purged at 90
-- days, so a window longer than that would divide real signups by a decaying
-- activity denominator; callers clamp to 90.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_acquisition_channels(
  p_days int DEFAULT 28
)
RETURNS TABLE (
  source text,
  signups int,
  activated int,
  returned int,
  paying int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH cohort AS (
    SELECT
      w.id,
      COALESCE(nullif(w.acquisition_source, ''), 'unattributed') AS source,
      w.onboarding_value_activated_at IS NOT NULL AS activated,
      COALESCE(ub.plan, 'free') <> 'free'
        AND NOT COALESCE(
              e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now()),
              false
            ) AS paying
    FROM public.workspaces w
    LEFT JOIN public.user_billing ub ON ub.user_id = w.owner_id
    LEFT JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
    WHERE w.deleted_at IS NULL
      AND w.created_at >= (now() - make_interval(days => greatest(p_days, 1)))
  ),
  active_days AS (
    SELECT
      a.workspace_id,
      count(DISTINCT (a.created_at AT TIME ZONE 'UTC')::date) AS days
    FROM public.activity_log a
    WHERE a.status = 'success'
      AND a.workspace_id IN (SELECT id FROM cohort)
    GROUP BY 1
  )
  SELECT
    cohort.source,
    count(*)::int,
    count(*) FILTER (WHERE cohort.activated)::int,
    count(*) FILTER (WHERE COALESCE(active_days.days, 0) > 1)::int,
    count(*) FILTER (WHERE cohort.paying)::int
  FROM cohort
  LEFT JOIN active_days ON active_days.workspace_id = cohort.id
  GROUP BY cohort.source
  ORDER BY 2 DESC, 1;
$$;

-- ---------------------------------------------------------------------------
-- Execution rights. PUBLIC is revoked first because anon and authenticated
-- inherit the default grant through it, so naming those two alone would leave
-- it in place.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.growth_upgrade_pressure(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_inbox_distribution() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_acquisition_channels(int) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.growth_upgrade_pressure(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_inbox_distribution() TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_acquisition_channels(int) TO service_role;
