-- ===========================================================================
-- Pro inbox cap (10 for new buyers) and the Business plan.
-- 20261019150000_pro_inbox_cap_and_business
--
-- Decided 2026-10-19: Pro (slug `solo`) is capped at 10 connected inboxes for
-- new customers; every workspace on Pro at the cutover keeps unlimited. Team
-- (slug `pro`) becomes Business, billed per mailbox above 10. The inbox cap
-- itself is a number in TypeScript (`resolvePlanLimits`, plans.ts); this
-- migration holds the two facts the number needs from the database:
--
--   1. workspaces.pro_unlimited_inboxes_exempt, the per-workspace promise to
--      the Pro customers who bought before the cap. Same shape as
--      free_action_cap_exempt. NOT backfilled here: the backfill is
--      docs/sql/pro-cap-cutover.sql, run on cutover day, so a workspace that
--      upgrades between this apply and the cutover is not missed.
--   2. pricing_switches('pro_inbox_cap'), the kill switch. Seeded OFF, so this
--      migration changes nothing a customer sees. The cutover SQL backfills the
--      exemption and turns the switch on in one transaction. Turning it off
--      again makes every Pro workspace unlimited at once, with no deploy.
--   3. effective_workspace_plan() gains `pro_unlimited_inboxes`: the flag OR
--      the switch being off. The TypeScript side reads it only when the plan
--      is `solo`.
--   4. usage_limit_events.limit_kind ('actions' | 'inboxes') plus
--      record_inbox_cap_event(), so a Pro cap hit is a row in the same table
--      as an action-cap refusal and the two can still be told apart. The
--      admin readers that mean "action cap" are given the filter (5, 6).
--   5. product_funnel_events stage 'paywall_clicked': the inbox-cap offer was
--      clicked. Shown is the existing paywall_reached row.
--
-- Forward-only, one transaction, every step safe to re-run.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. workspaces.pro_unlimited_inboxes_exempt
--
-- No column grant for anon/authenticated: 20261016160100 made every workspaces
-- column server-owned, and a new column inherits that (no grant, no write).
-- ---------------------------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS pro_unlimited_inboxes_exempt boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.workspaces.pro_unlimited_inboxes_exempt IS
  'True for every workspace on Pro (plan solo) at the 2026-10 Pro inbox cap '
  'cutover: it keeps unlimited connected inboxes on Pro. New workspaces default '
  'false and get the 10-inbox cap. Set by docs/sql/pro-cap-cutover.sql, and by '
  'the kill-switch runbook if the cap is withdrawn. Read through '
  'effective_workspace_plan().pro_unlimited_inboxes.';


-- ---------------------------------------------------------------------------
-- 2. pricing_switches: runtime pricing switches, flipped with one UPDATE.
--
-- Server-owned: RLS on, no policies, no grants to anon/authenticated. Only
-- definer functions and the service role read it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pricing_switches (
  key        text PRIMARY KEY,
  enabled    boolean NOT NULL,
  note       text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pricing_switches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pricing_switches FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pricing_switches TO service_role;

COMMENT ON TABLE public.pricing_switches IS
  'Runtime pricing switches. pro_inbox_cap: when false, every Pro workspace '
  'resolves to unlimited inboxes (the kill switch). Flip with one UPDATE; no '
  'deploy needed.';

-- Seeded OFF. ON CONFLICT DO NOTHING so a re-run never undoes a cutover.
INSERT INTO public.pricing_switches (key, enabled, note)
VALUES ('pro_inbox_cap', false,
        'Pro 10-inbox cap for workspaces without pro_unlimited_inboxes_exempt. '
        'Turned on by docs/sql/pro-cap-cutover.sql.')
ON CONFLICT (key) DO NOTHING;


-- ---------------------------------------------------------------------------
-- 3. effective_workspace_plan gains a fourth column.
--
-- Current definition is 20260819170500. Body, volatility, security and the RLS
-- gate (my_workspace_ids()) are unchanged; one column is added. CREATE OR
-- REPLACE cannot widen a RETURNS TABLE, hence the DROP inside this
-- transaction. Every caller reads named fields off the first row.
--
-- `pro_unlimited_inboxes` is true when the workspace holds the cutover
-- exemption, or when the pro_inbox_cap switch is off (or missing, so a
-- database without the row behaves as before the cap). It is returned for
-- every plan; only a `solo` plan acts on it.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.effective_workspace_plan(uuid);

CREATE FUNCTION public.effective_workspace_plan(p_workspace_id uuid)
RETURNS TABLE(plan text, comped_scale boolean, unlimited_inboxes boolean, pro_unlimited_inboxes boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    CASE WHEN e.kind = 'comped_scale'
      AND (e.expires_at IS NULL OR e.expires_at > now()) THEN 'pro'
      ELSE w.plan
    END AS plan,
    (e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now())) AS comped_scale,
    -- The inbox grandfather is deliberately NOT expiry-gated the way the comped
    -- grant is. It was promised permanently, and every backfilled row has a
    -- NULL expires_at; gating it would let a support-set expiry on some future
    -- unrelated grant quietly revoke the promise.
    COALESCE(e.unlimited_inboxes, false) AS unlimited_inboxes,
    (
      w.pro_unlimited_inboxes_exempt
      OR NOT COALESCE(
        (SELECT s.enabled FROM public.pricing_switches s WHERE s.key = 'pro_inbox_cap'),
        false
      )
    ) AS pro_unlimited_inboxes
  FROM public.workspaces w
  LEFT JOIN public.user_usage_entitlements e ON e.user_id = w.owner_id
  WHERE w.id = p_workspace_id
    AND w.id = ANY(public.my_workspace_ids());
$$;

REVOKE ALL ON FUNCTION public.effective_workspace_plan(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.effective_workspace_plan(uuid) TO authenticated;


-- ---------------------------------------------------------------------------
-- 4. usage_limit_events.limit_kind and record_inbox_cap_event()
--
-- Every existing row is an action-cap refusal, so the default is 'actions'
-- and the edge function's insert (record_usage_limit_event) needs no change.
-- An 'inboxes' row reuses the two count columns: used_actions holds the
-- connected inbox count at the refusal, cap holds the inbox cap.
-- ---------------------------------------------------------------------------
ALTER TABLE public.usage_limit_events
  ADD COLUMN IF NOT EXISTS limit_kind text NOT NULL DEFAULT 'actions';

ALTER TABLE public.usage_limit_events
  DROP CONSTRAINT IF EXISTS usage_limit_events_limit_kind_check;
ALTER TABLE public.usage_limit_events
  ADD CONSTRAINT usage_limit_events_limit_kind_check
  CHECK (limit_kind IN ('actions', 'inboxes'));

CREATE INDEX IF NOT EXISTS usage_limit_events_kind_occurred_idx
  ON public.usage_limit_events (limit_kind, occurred_at DESC);

COMMENT ON COLUMN public.usage_limit_events.limit_kind IS
  'actions: an MCP call refused by the action cap (used_actions = actions used). '
  'inboxes: a connect blocked by the Pro inbox cap (used_actions = connected '
  'inboxes, cap = the inbox cap). Readers that mean the action cap filter on '
  'actions.';

CREATE OR REPLACE FUNCTION public.record_inbox_cap_event(
  p_workspace_id uuid,
  p_plan         text,
  p_inbox_count  integer,
  p_cap          integer
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.usage_limit_events
    (workspace_id, effective_plan, used_actions, cap, limit_kind)
  VALUES
    (p_workspace_id, p_plan, GREATEST(p_inbox_count, 0), p_cap, 'inboxes');
$$;

REVOKE ALL ON FUNCTION public.record_inbox_cap_event(uuid, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_inbox_cap_event(uuid, text, integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.record_inbox_cap_event(uuid, text, integer, integer) IS
  'Appends one limit_kind=inboxes row to usage_limit_events: a connect blocked '
  'by the inbox cap. Called by the web app with the service role. Read by '
  'docs/sql/pro-cap-readout.sql.';


-- ---------------------------------------------------------------------------
-- 5. stage vocabulary: 'paywall_clicked'
--
-- Current definition is 20260929140000, reproduced verbatim with one addition.
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
    'multi_inbox_prompt',
    -- A buy button on the inbox-cap offer was clicked. The matching "shown" is
    -- the paywall_reached row with connection_type = 'first_connect'.
    'paywall_clicked'
  ));


-- ---------------------------------------------------------------------------
-- 6. growth_usage_cap_overview: action-cap refusals only
--
-- Current definition is 20260912210000, reproduced verbatim except that the
-- three reads of usage_limit_events now filter limit_kind = 'actions'. Without
-- it a Pro inbox-cap hit would count as an action-cap refusal on the board.
-- growth_usage_cap_workspaces is left alone: it lists Free workspaces only,
-- which never write an 'inboxes' row.
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
      AND l.limit_kind = 'actions'
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
      AND l.limit_kind = 'actions'
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
    WHERE l.limit_kind = 'actions'
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


-- ---------------------------------------------------------------------------
-- 7. growth_user_timeline: name the inbox cap
--
-- Current definition is 20261004100200, reproduced verbatim except the
-- usage_limit_events branch, which labels an 'inboxes' row as what it is.
-- CREATE OR REPLACE keeps the service-role-only grants.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_user_timeline(p_user_id uuid, p_limit int)
RETURNS TABLE (
  occurred_at timestamptz,
  kind text,
  title text,
  detail text,
  tone text
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH ws AS (
    SELECT w.id, coalesce(nullif(w.display_name, ''), w.slug) AS name, w.created_at, w.deleted_at
    FROM public.workspaces w WHERE w.owner_id = p_user_id
  ),
  events AS (
    SELECT u.created_at AS occurred_at, 'account'::text AS kind, 'Signed up'::text AS title,
           u.email AS detail, 'good'::text AS tone
    FROM public.users u WHERE u.id = p_user_id

    UNION ALL
    SELECT w.created_at, 'workspace', 'Workspace created', w.name, 'flat' FROM ws w

    UNION ALL
    SELECT w.deleted_at, 'workspace', 'Workspace deleted', w.name, 'bad'
    FROM ws w WHERE w.deleted_at IS NOT NULL

    UNION ALL
    SELECT i.created_at, 'inbox', 'Mailbox connected',
           i.email_address || ' · ' || public.growth_inbox_label(i.provider, i.service), 'good'
    FROM public.inboxes i JOIN ws w ON w.id = i.workspace_id

    UNION ALL
    SELECT i.deleted_at, 'inbox', 'Mailbox disconnected', i.email_address, 'bad'
    FROM public.inboxes i JOIN ws w ON w.id = i.workspace_id WHERE i.deleted_at IS NOT NULL

    UNION ALL
    SELECT k.created_at, 'key', 'API key created', k.name || ' · ' || k.key_prefix, 'good'
    FROM public.api_keys k JOIN ws w ON w.id = k.workspace_id WHERE k.kind IS NULL

    UNION ALL
    SELECT k.deleted_at, 'key', 'API key revoked', k.name, 'bad'
    FROM public.api_keys k JOIN ws w ON w.id = k.workspace_id
    WHERE k.deleted_at IS NOT NULL AND k.kind IS NULL

    -- The funnel rows are the only place a FAILED attempt is recorded at all:
    -- a connection that never worked leaves no inbox row behind it.
    UNION ALL
    SELECT e.occurred_at, 'funnel',
           CASE e.stage
             WHEN 'inbox_connection' THEN 'Connection attempt'
             WHEN 'credential_created' THEN 'Credential issued'
             WHEN 'first_tool_call' THEN 'First tool call'
             WHEN 'paywall_reached' THEN 'Paywall reached'
             ELSE e.stage END,
           e.category
             || CASE
                  WHEN e.outcome = 'failure' THEN ' · ' || coalesce(e.error_category, 'unknown')
                  -- THREE OUTCOMES, NOT TWO. `started` means the person pressed
                  -- the button, and reading it as a success is how a mailbox
                  -- that never connected shows up as two green connections.
                  WHEN e.outcome <> 'success' THEN ' · ' || e.outcome
                  ELSE ''
                END
             || coalesce(' · ' || e.auth_reason, ''),
           CASE e.outcome WHEN 'failure' THEN 'bad' WHEN 'success' THEN 'good' ELSE 'flat' END
    FROM public.product_funnel_events e JOIN ws w ON w.id = e.workspace_id

    UNION ALL
    SELECT e.occurred_at, 'paywall',
           CASE e.limit_kind WHEN 'inboxes' THEN 'Inbox cap blocked a connect'
                             ELSE 'Action cap rejected a call' END,
           e.effective_plan || ' · ' || e.used_actions || ' of ' || e.cap, 'bad'
    FROM public.usage_limit_events e JOIN ws w ON w.id = e.workspace_id

    UNION ALL
    SELECT s.sent_at, 'email', 'Lifecycle email', s.template || ' · ' || s.status,
           CASE WHEN s.status = 'sent' THEN 'flat' ELSE 'bad' END
    FROM public.lifecycle_email_sends s WHERE s.user_id = p_user_id

    UNION ALL
    SELECT s.sent_at, 'email', 'Billing email', s.template,  'flat'
    FROM public.billing_email_sends s WHERE s.user_id = p_user_id AND s.sent_at IS NOT NULL
  )
  SELECT e.occurred_at, e.kind, e.title, e.detail, e.tone
  FROM events e
  WHERE e.occurred_at IS NOT NULL
  ORDER BY e.occurred_at DESC
  LIMIT greatest(coalesce(p_limit, 200), 1);
$$;

