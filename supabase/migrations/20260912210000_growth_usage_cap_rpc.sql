-- ===========================================================================
-- Growth board RPCs for the Free action allowance: the "Usage cap" band on
-- /admin/growth and the /admin/growth/usage-cap sub-page.
-- 20260912210000_growth_usage_cap_rpc
--
-- Design: docs/PLAN-free-action-cap-150.md, Phase 6. Schema it reads:
-- 20260912200000_free_action_cap_150.sql (free_action_cap_exempt, the
-- workspace-keyed billing_email_sends rows, triage_rules.paused_*).
--
-- THREE FUNCTIONS, ONE SET OF RULES
-- ---------------------------------
-- growth_usage_cap_states()     one row per live workspace with an external
--                               owner, carrying the allowance state. The
--                               other two are views over it, so the band and
--                               the sub-page can never bucket a workspace
--                               differently.
-- growth_usage_cap_overview()   one row of counts for the band.
-- growth_usage_cap_workspaces() the rows worth a person's attention: at or
--                               past half the allowance.
--
-- THE RULES MUST MATCH workspace_action_allowance(uuid)
-- ----------------------------------------------------
-- workspace_action_allowance() is the one source of truth for a single
-- workspace and is what the edge function enforces from. It is STABLE and
-- cheap, but it is a per-row plpgsql call, and calling it once per workspace
-- from a set-returning report is a correlated loop over the whole estate on
-- every render. So the SAME rules are written here set-based:
--
--   exempt         free_action_cap_exempt, OR an unexpired comped_scale
--                  entitlement on the owner, OR a live (unrevoked, unexpired)
--                  workspace_usage_exemptions row. Precedence early > comped
--                  > exemption, as there.
--   cap            150 for a non-exempt Free workspace (c_free_cap there).
--   grace          created_at + 7 days (c_grace there); in grace while
--                  now() < grace_ends_at.
--   window         the UTC calendar month; the counting window opens at
--                  least(greatest(month_start, grace_ends_at), month_end).
--   used           a row COUNT of billable action_usage at meter_version 1
--                  inside [period_start, period_end), never SUM(quantity).
--
-- If either constant or any of those clauses changes in the allowance
-- function, change it here in the same migration, and re-run the cross-check
-- below, which asks both implementations about every workspace and compares
-- them row by row. It is written here rather than in
-- scripts/verify-action-allowance.sql because that script is Phase 1's and
-- predates these functions. Every column must read t:
--
--   SELECT s.workspace_id, s.state,
--          (s.used = a.used)                     AS used_agrees,
--          (s.period_start = a.period_start)     AS window_agrees,
--          (s.cap IS NOT DISTINCT FROM a.cap)    AS cap_agrees,   -- 'paid' excepted
--          (s.state LIKE 'exempt%' ) = a.exempt  AS exempt_agrees
--   FROM public.growth_usage_cap_states('{}', '{}') s
--   CROSS JOIN LATERAL public.workspace_action_allowance(s.workspace_id) a;
--
-- Run on the local stack against fixtures covering every state (2026-09-13:
-- early member, support exemption, comped owner, grace, under half, half,
-- warn, capped, paid), all nine agreed.
--
-- Paid plans are reported with state 'paid' and no cap: their ceilings are
-- silent abuse limits, not this panel's subject, and reproducing the Stripe
-- period lookup here for a number nobody reads would be a second copy of the
-- rule with no reader.
--
-- WHO IS COUNTED
-- --------------
-- Live workspaces (deleted_at IS NULL) whose owner is not one of our own
-- accounts, tested with growth_is_internal_email() exactly as
-- growth_people_counts and growth_user_signup_days do. The list is passed in
-- as parameters because this repository is public and the addresses are
-- personal. The funnel and the retention pair do NOT filter on plan: a capped
-- workspace that then bought Personal is the whole point of the funnel, and
-- dropping it the moment it converts would make the last rung read zero.
--
-- SECURITY
-- --------
-- SECURITY DEFINER because the states function reads users.email to exclude
-- internal accounts and to give the sub-page an owner to name; EXECUTE is
-- revoked from PUBLIC (anon and authenticated inherit through it) and granted
-- to service_role only, the same posture as 20260819090000. The overview
-- returns only counts. The workspaces function returns an owner email and is
-- read only by the operator sub-page behind the ADMIN_EMAILS session; the
-- wall board reads the overview alone.
--
-- CONTRACT
-- --------
-- apps/web/src/lib/analytics/growth-types.ts binds these OUT columns by name.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- growth_usage_cap_states(p_internal_emails, p_internal_domains)
--
-- states, in the order the band prints them:
--   'exempt_early'    free_action_cap_exempt: existed at launch, never metered
--   'exempt_support'  comped owner or a live support exemption
--   'paid'            not on Free; no cap reported
--   'grace'           Free, non-exempt, still inside the first 7 days
--   'under_half'      counting, used < 50% of cap
--   'half'            50% <= used < 80%
--   'warn'            80% <= used < 100% (the 80% email has been earned)
--   'capped'          used >= cap: every billable call is refused until
--                     period_end
--
-- The 80% boundary is used * 100 >= cap * 80, i.e. used >= 120 at cap 150,
-- which is the same crossing the edge function sends usage_warning_80 on
-- (used === ceil(0.8 * cap)).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_usage_cap_states(
  p_internal_emails  text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
RETURNS TABLE (
  workspace_id    uuid,
  owner_id        uuid,
  owner_email     text,
  workspace_name  text,
  plan            text,
  created_at      timestamptz,
  state           text,
  used            int,
  cap             int,
  remaining       int,
  period_start    timestamptz,
  period_end      timestamptz,
  grace_ends_at   timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH consts AS (
    -- MUST equal c_free_cap, c_grace and c_meter_version in
    -- workspace_action_allowance() (20260912200000).
    SELECT 150::int AS free_cap, interval '7 days' AS grace, 1::int AS meter_version
  ),
  month AS (
    SELECT
      date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc' AS starts,
      (date_trunc('month', now() AT TIME ZONE 'utc') + interval '1 month') AT TIME ZONE 'utc' AS ends
  ),
  scoped AS (
    SELECT
      w.id,
      w.owner_id,
      u.email AS owner_email,
      w.display_name,
      coalesce(w.plan, 'free') AS plan,
      w.created_at,
      w.free_action_cap_exempt AS early,
      EXISTS (
        SELECT 1 FROM public.user_usage_entitlements e
        WHERE e.user_id = w.owner_id
          AND e.kind = 'comped_scale'
          AND (e.expires_at IS NULL OR e.expires_at > now())
      ) AS comped,
      EXISTS (
        SELECT 1 FROM public.workspace_usage_exemptions x
        WHERE x.workspace_id = w.id
          AND x.revoked_at IS NULL
          AND (x.expires_at IS NULL OR x.expires_at > now())
      ) AS exempted
    FROM public.workspaces w
    JOIN public.users u ON u.id = w.owner_id
    WHERE w.deleted_at IS NULL
      AND NOT public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains)
  ),
  windowed AS (
    SELECT
      s.*,
      (s.early OR s.comped OR s.exempted) AS exempt,
      c.free_cap,
      c.meter_version,
      m.ends AS period_end,
      CASE WHEN s.plan = 'free' AND NOT (s.early OR s.comped OR s.exempted)
        THEN s.created_at + c.grace END AS grace_ends_at,
      -- Exempt and paid rows report the plain month so `used` still means
      -- something on the sub-page; the metered Free window opens after grace
      -- and never after the month ends.
      CASE WHEN s.plan = 'free' AND NOT (s.early OR s.comped OR s.exempted)
        THEN LEAST(GREATEST(m.starts, s.created_at + c.grace), m.ends)
        ELSE m.starts END AS period_start
    FROM scoped s
    CROSS JOIN consts c
    CROSS JOIN month m
  ),
  counted AS (
    SELECT
      wd.*,
      (
        SELECT count(*)::int
        FROM public.action_usage a
        WHERE a.workspace_id = wd.id
          AND a.billable
          AND a.meter_version = wd.meter_version
          AND a.occurred_at >= wd.period_start
          AND a.occurred_at <  wd.period_end
      ) AS used
    FROM windowed wd
  )
  SELECT
    c.id            AS workspace_id,
    c.owner_id,
    c.owner_email,
    c.display_name  AS workspace_name,
    c.plan,
    c.created_at,
    CASE
      WHEN c.early                          THEN 'exempt_early'
      WHEN c.exempt                         THEN 'exempt_support'
      WHEN c.plan <> 'free'                 THEN 'paid'
      WHEN now() < c.grace_ends_at          THEN 'grace'
      WHEN c.used >= c.free_cap             THEN 'capped'
      WHEN c.used * 100 >= c.free_cap * 80  THEN 'warn'
      WHEN c.used * 100 >= c.free_cap * 50  THEN 'half'
      ELSE 'under_half'
    END AS state,
    c.used,
    CASE WHEN c.plan = 'free' AND NOT c.exempt THEN c.free_cap END AS cap,
    CASE WHEN c.plan = 'free' AND NOT c.exempt THEN GREATEST(c.free_cap - c.used, 0) END AS remaining,
    c.period_start,
    c.period_end,
    c.grace_ends_at
  FROM counted c;
$$;

COMMENT ON FUNCTION public.growth_usage_cap_states(text[], text[]) IS
  'One row per live, externally owned workspace with its Free action allowance '
  'state, computed set-based with the SAME rules as workspace_action_allowance(). '
  'Feeds growth_usage_cap_overview and growth_usage_cap_workspaces. Service-role only.';


-- ---------------------------------------------------------------------------
-- growth_usage_cap_overview(p_window_days, p_internal_emails, p_internal_domains)
--
-- One row. The state counts are a snapshot of now; everything else is over
-- the trailing window.
--
-- FUNNEL. A workspace enters at its first refusal (usage_limit_events) inside
-- the window, and each later rung is "has that funnel event AFTER that
-- refusal". The rungs are not required to be sequential: the dashboard banner
-- links straight to checkout, so checkout_started without pricing_viewed is
-- a real path and must not be dropped for skipping a rung.
--
-- RETENTION PAIR. Did being refused make people leave? Capped: non-exempt
-- post-launch workspaces whose first refusal is at least 7 days old; retained
-- if ANY call reached the product on a later UTC day within those 7 days. A
-- refused call counts as coming back, because refusing them and then
-- reporting that they did not return would be circular. Uncapped: never
-- refused, same signup weeks (Monday-based, UTC), anchored at the end of
-- their grace week, which is the day metering began for them and the nearest
-- thing they have to the capped group's event. Both read activity_log, which
-- is purged at 90 days; the cap launched on 2026-09-12, so nothing is lost
-- before December.
--
-- EMAILS. `queued` is rows created in the window whatever became of them;
-- `sent` is rows whose sent_at is in the window.
--
-- PAUSES. `rules_paused_now` is the live count. `pauses_window` counts
-- automation_paused_limit rows created in the window, which is at most one
-- per workspace per period (the unique index), so it is "workspaces whose
-- rules were paused", not a rule count.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_usage_cap_overview(
  p_window_days      int    DEFAULT 28,
  p_internal_emails  text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
RETURNS TABLE (
  in_grace                  int,
  under_half                int,
  half                      int,
  warn                      int,
  capped                    int,
  metered                   int,
  exempt_early              int,
  exempt_support            int,
  refused_workspaces_window int,
  refusals_window           int,
  email_80_queued           int,
  email_80_sent             int,
  email_100_queued          int,
  email_100_sent            int,
  email_pause_queued        int,
  email_pause_sent          int,
  funnel_capped             int,
  funnel_pricing_viewed     int,
  funnel_checkout_started   int,
  funnel_checkout_completed int,
  capped_eligible           int,
  capped_retained           int,
  uncapped_eligible         int,
  uncapped_retained         int,
  rules_paused_now          int,
  workspaces_paused_now     int,
  pauses_window             int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT now() - make_interval(days => greatest(coalesce(p_window_days, 28), 1)) AS since
  ),
  states AS (
    SELECT * FROM public.growth_usage_cap_states(p_internal_emails, p_internal_domains)
  ),
  -- Externally owned workspaces, live or not: the funnel and the retention
  -- pair must keep a workspace that converted or was deleted after the event.
  external AS (
    SELECT w.id, w.created_at, w.free_action_cap_exempt
    FROM public.workspaces w
    JOIN public.users u ON u.id = w.owner_id
    WHERE NOT public.growth_is_internal_email(u.email, p_internal_emails, p_internal_domains)
  ),
  state_counts AS (
    SELECT
      count(*) FILTER (WHERE s.state = 'grace')::int          AS in_grace,
      count(*) FILTER (WHERE s.state = 'under_half')::int     AS under_half,
      count(*) FILTER (WHERE s.state = 'half')::int           AS half,
      count(*) FILTER (WHERE s.state = 'warn')::int           AS warn,
      count(*) FILTER (WHERE s.state = 'capped')::int         AS capped,
      count(*) FILTER (WHERE s.state = 'exempt_early')::int   AS exempt_early,
      count(*) FILTER (WHERE s.state = 'exempt_support')::int AS exempt_support
    FROM states s
  ),
  refusals AS (
    SELECT
      count(DISTINCT l.workspace_id)::int AS refused_workspaces_window,
      count(*)::int                       AS refusals_window
    FROM public.usage_limit_events l
    JOIN external x ON x.id = l.workspace_id
    CROSS JOIN bounds b
    WHERE l.occurred_at >= b.since
  ),
  emails AS (
    SELECT
      count(*) FILTER (WHERE e.template = 'usage_warning_80'        AND e.created_at >= b.since)::int AS email_80_queued,
      count(*) FILTER (WHERE e.template = 'usage_warning_80'        AND e.sent_at    >= b.since)::int AS email_80_sent,
      count(*) FILTER (WHERE e.template = 'usage_limit_reached'     AND e.created_at >= b.since)::int AS email_100_queued,
      count(*) FILTER (WHERE e.template = 'usage_limit_reached'     AND e.sent_at    >= b.since)::int AS email_100_sent,
      count(*) FILTER (WHERE e.template = 'automation_paused_limit' AND e.created_at >= b.since)::int AS email_pause_queued,
      count(*) FILTER (WHERE e.template = 'automation_paused_limit' AND e.sent_at    >= b.since)::int AS email_pause_sent
    FROM public.billing_email_sends e
    JOIN external x ON x.id = e.workspace_id
    CROSS JOIN bounds b
  ),
  -- First refusal per workspace inside the window: the funnel's entry rung.
  capped_window AS (
    SELECT l.workspace_id, min(l.occurred_at) AS first_cap
    FROM public.usage_limit_events l
    JOIN external x ON x.id = l.workspace_id
    CROSS JOIN bounds b
    WHERE l.occurred_at >= b.since
    GROUP BY l.workspace_id
  ),
  funnel AS (
    SELECT
      count(*)::int AS funnel_capped,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.product_funnel_events f
        WHERE f.workspace_id = c.workspace_id AND f.stage = 'pricing_viewed' AND f.occurred_at >= c.first_cap
      ))::int AS funnel_pricing_viewed,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.product_funnel_events f
        WHERE f.workspace_id = c.workspace_id AND f.stage = 'checkout_started' AND f.outcome = 'success'
          AND f.occurred_at >= c.first_cap
      ))::int AS funnel_checkout_started,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.product_funnel_events f
        WHERE f.workspace_id = c.workspace_id AND f.stage = 'checkout_completed' AND f.occurred_at >= c.first_cap
      ))::int AS funnel_checkout_completed
    FROM capped_window c
  ),
  -- Retention. Post-launch (non-exempt) external workspaces only, because the
  -- exempt ones cannot be capped and would only ever land on one side.
  first_refusal AS (
    SELECT l.workspace_id, min(l.occurred_at) AS first_cap
    FROM public.usage_limit_events l
    GROUP BY l.workspace_id
  ),
  capped_cohort AS (
    SELECT
      x.id AS workspace_id,
      r.first_cap AS anchor,
      date_trunc('week', x.created_at AT TIME ZONE 'utc') AS signup_week
    FROM external x
    JOIN first_refusal r ON r.workspace_id = x.id
    WHERE NOT x.free_action_cap_exempt
      AND r.first_cap + interval '7 days' <= now()
  ),
  uncapped_cohort AS (
    SELECT
      x.id AS workspace_id,
      x.created_at + interval '7 days' AS anchor
    FROM external x
    WHERE NOT x.free_action_cap_exempt
      AND NOT EXISTS (SELECT 1 FROM first_refusal r WHERE r.workspace_id = x.id)
      AND x.created_at + interval '14 days' <= now()
      AND date_trunc('week', x.created_at AT TIME ZONE 'utc') IN (SELECT signup_week FROM capped_cohort)
  ),
  retention AS (
    SELECT
      (SELECT count(*) FROM capped_cohort)::int AS capped_eligible,
      (SELECT count(*) FROM capped_cohort c WHERE EXISTS (
        SELECT 1 FROM public.activity_log a
        WHERE a.workspace_id = c.workspace_id
          AND a.created_at > c.anchor
          AND a.created_at <= c.anchor + interval '7 days'
          AND (a.created_at AT TIME ZONE 'utc')::date > (c.anchor AT TIME ZONE 'utc')::date
      ))::int AS capped_retained,
      (SELECT count(*) FROM uncapped_cohort)::int AS uncapped_eligible,
      (SELECT count(*) FROM uncapped_cohort c WHERE EXISTS (
        SELECT 1 FROM public.activity_log a
        WHERE a.workspace_id = c.workspace_id
          AND a.created_at > c.anchor
          AND a.created_at <= c.anchor + interval '7 days'
          AND (a.created_at AT TIME ZONE 'utc')::date > (c.anchor AT TIME ZONE 'utc')::date
      ))::int AS uncapped_retained
  ),
  pauses AS (
    SELECT
      count(*)::int                       AS rules_paused_now,
      count(DISTINCT r.workspace_id)::int AS workspaces_paused_now
    FROM public.triage_rules r
    JOIN states s ON s.workspace_id = r.workspace_id
    WHERE r.deleted_at IS NULL
      AND r.paused_reason = 'plan_limit'
      AND r.paused_until > now()
  ),
  pause_window AS (
    SELECT count(*)::int AS pauses_window
    FROM public.billing_email_sends e
    JOIN external x ON x.id = e.workspace_id
    CROSS JOIN bounds b
    WHERE e.template = 'automation_paused_limit'
      AND e.created_at >= b.since
  )
  SELECT
    sc.in_grace,
    sc.under_half,
    sc.half,
    sc.warn,
    sc.capped,
    (sc.in_grace + sc.under_half + sc.half + sc.warn + sc.capped)::int AS metered,
    sc.exempt_early,
    sc.exempt_support,
    rf.refused_workspaces_window,
    rf.refusals_window,
    em.email_80_queued,
    em.email_80_sent,
    em.email_100_queued,
    em.email_100_sent,
    em.email_pause_queued,
    em.email_pause_sent,
    fu.funnel_capped,
    fu.funnel_pricing_viewed,
    fu.funnel_checkout_started,
    fu.funnel_checkout_completed,
    re.capped_eligible,
    re.capped_retained,
    re.uncapped_eligible,
    re.uncapped_retained,
    pa.rules_paused_now,
    pa.workspaces_paused_now,
    pw.pauses_window
  FROM state_counts sc, refusals rf, emails em, funnel fu, retention re, pauses pa, pause_window pw;
$$;

COMMENT ON FUNCTION public.growth_usage_cap_overview(int, text[], text[]) IS
  'The "Usage cap" band on /admin/growth: workspaces by allowance state now, '
  'refusals, usage emails, the refusal-to-checkout funnel and the capped versus '
  'uncapped 7-day retention pair over the window, and automation pauses. '
  'Counts only. Service-role only.';


-- ---------------------------------------------------------------------------
-- growth_usage_cap_workspaces(p_internal_emails, p_internal_domains)
--
-- The Free workspaces at or past half their allowance, most used first. This
-- is the roster the operator acts on (an exemption, a reply, a look at the
-- account), so it carries the owner's address; the band on the wall board
-- must print only the domain column, or nothing from this function at all.
--
-- `emails_sent` and `emails_queued` list the usage templates for THIS period
-- (billing_email_sends.period_start = the allowance period_start), sent and
-- still pending respectively. `refusals` counts usage_limit_events since the
-- period opened. `paused_rules` is the live plan_limit pause count.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_usage_cap_workspaces(
  p_internal_emails  text[] DEFAULT '{}',
  p_internal_domains text[] DEFAULT '{}'
)
RETURNS TABLE (
  workspace_id    uuid,
  owner_id        uuid,
  owner_email     text,
  owner_domain    text,
  workspace_name  text,
  state           text,
  used            int,
  cap             int,
  remaining       int,
  period_start    timestamptz,
  period_end      timestamptz,
  created_at      timestamptz,
  last_action_at  timestamptz,
  refusals        int,
  emails_sent     text,
  emails_queued   text,
  paused_rules    int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    s.workspace_id,
    s.owner_id,
    s.owner_email,
    split_part(s.owner_email, '@', 2) AS owner_domain,
    s.workspace_name,
    s.state,
    s.used,
    s.cap,
    s.remaining,
    s.period_start,
    s.period_end,
    s.created_at,
    (
      SELECT max(a.occurred_at) FROM public.action_usage a
      WHERE a.workspace_id = s.workspace_id AND a.billable
    ) AS last_action_at,
    (
      SELECT count(*)::int FROM public.usage_limit_events l
      WHERE l.workspace_id = s.workspace_id AND l.occurred_at >= s.period_start
    ) AS refusals,
    (
      SELECT string_agg(e.template, ', ' ORDER BY e.sent_at)
      FROM public.billing_email_sends e
      WHERE e.workspace_id = s.workspace_id
        AND e.period_start = s.period_start
        AND e.sent_at IS NOT NULL
    ) AS emails_sent,
    (
      SELECT string_agg(e.template, ', ' ORDER BY e.created_at)
      FROM public.billing_email_sends e
      WHERE e.workspace_id = s.workspace_id
        AND e.period_start = s.period_start
        AND e.sent_at IS NULL
        AND e.cancelled_at IS NULL
    ) AS emails_queued,
    (
      SELECT count(*)::int FROM public.triage_rules r
      WHERE r.workspace_id = s.workspace_id
        AND r.deleted_at IS NULL
        AND r.paused_reason = 'plan_limit'
        AND r.paused_until > now()
    ) AS paused_rules
  FROM public.growth_usage_cap_states(p_internal_emails, p_internal_domains) s
  WHERE s.state IN ('half', 'warn', 'capped')
  ORDER BY s.used DESC, s.created_at ASC;
$$;

COMMENT ON FUNCTION public.growth_usage_cap_workspaces(text[], text[]) IS
  'Free workspaces at or past half their action allowance this period, with '
  'owner, usage, refusals, usage emails and paused rules. Names people: read by '
  'the /admin/growth/usage-cap sub-page only. Service-role only.';


-- ---------------------------------------------------------------------------
-- Execution rights. PUBLIC first, because anon and authenticated inherit the
-- default grant through it.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.growth_usage_cap_states(text[], text[])          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_usage_cap_overview(int, text[], text[])   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.growth_usage_cap_workspaces(text[], text[])      FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.growth_usage_cap_states(text[], text[])        TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_usage_cap_overview(int, text[], text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.growth_usage_cap_workspaces(text[], text[])    TO service_role;
