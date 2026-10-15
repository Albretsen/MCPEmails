-- ===========================================================================
-- The hidden web-client key is not a credential anyone issued: keep it out of
-- the growth board and out of the dormant-grant sweep.
-- 20261004100200_web_client_key_excluded_from_growth_and_sweeps
--
-- Depends on 20261004100100 (api_keys.kind). Apply after it.
--
-- WHY. `client-api` creates one `api_keys` row per workspace with
-- kind = 'web_client' (see 20261004100100). RLS already hides it from the
-- dashboard. Four SQL functions read `api_keys` as the service role, where RLS
-- does not apply, and each would misread that row:
--
--   growth_user_directory   first_key: "this account has a credential" is an
--                           activation signal; the hidden row would stamp it
--                           on every workspace that merely opened the web
--                           client. key_rollup: would count it as an API key.
--   growth_user_workspaces  api_keys count per workspace.
--   growth_user_timeline    would print "API key created __web_client__".
--   revoke_dormant_oauth_grants
--                           only selects keys that have a live refresh-token
--                           chain, which the hidden key never has. Filtered
--                           anyway, so "can the sweep revoke the web client"
--                           is answered by the query and not by an argument
--                           about what else is true.
--
-- HOW THIS FILE WAS MADE. Each function below is the body from the migration
-- that last defined it (20260909120000 for the three growth functions,
-- 20260909180000 for the sweep), copied byte for byte by a script, with ONLY
-- the `kind IS NULL` predicates added. No other line differs. Six predicates
-- in total; search this file for "k.kind IS NULL" to see every one.
--
-- BEFORE APPLYING TO PRODUCTION: compare `pg_get_functiondef` of each of the
-- four functions with the definition in the migration named above. If the
-- live body has drifted from the migration (a hotfix applied by hand), this
-- file would silently revert that fix. Not checked by the agent that wrote
-- it, which had no access to the production database.
--
-- CREATE OR REPLACE keeps each function's owner and ACL, so the REVOKE/GRANT
-- posture set by the original migrations is unchanged. It is re-stated at the
-- end regardless, so this file is correct on a database where it was not.
--
-- Forward-only and re-runnable: every statement is CREATE OR REPLACE or an
-- idempotent REVOKE/GRANT.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- growth_user_directory: first_key and key_rollup ignore the hidden key
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_user_directory(p_days int, p_limit int, p_user_id uuid)
RETURNS TABLE (
  user_id uuid,
  email text,
  display_name text,
  avatar_url text,
  signed_up_at timestamptz,
  is_internal boolean,
  unsubscribed_at timestamptz,
  unsubscribed_categories text[],

  workspaces int,
  memberships int,
  primary_workspace_id uuid,
  primary_workspace_name text,
  primary_workspace_slug text,
  plan text,
  is_comped boolean,
  unlimited_inboxes boolean,
  grandfathered boolean,

  acquisition_source text,
  acquisition_utm_source text,
  acquisition_utm_medium text,
  acquisition_utm_campaign text,
  acquisition_landing_path text,
  acquisition_referrer text,
  acquisition_locale text,

  onboarding_stage text,
  onboarding_client text,
  first_inbox_connected_at timestamptz,
  first_inbox_provider text,
  first_credential_created_at timestamptz,
  first_credential_method text,
  first_tool_used_at timestamptz,
  first_tool_name text,
  first_tool_client text,
  value_activated_at timestamptz,

  inboxes int,
  inboxes_broken int,
  providers text,
  api_keys int,
  key_last_used_at timestamptz,

  calls int,
  successes int,
  active_days int,
  last_active_at timestamptz,
  paywall_hits int,

  billing_plan text,
  subscription_status text,
  stripe_customer_id text,
  current_period_end timestamptz,

  total_rows int
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT
      ((((now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 90), 1) - 1))::timestamp)
        AT TIME ZONE 'utc') AS window_start
  ),
  -- The population. Filtering here rather than at the end keeps every rollup
  -- below scanning one person's rows when a detail page asks for one person.
  people AS (
    SELECT u.* FROM public.users u
    WHERE p_user_id IS NULL OR u.id = p_user_id
  ),
  -- Live workspaces only. A deleted workspace keeps its rows but stops being
  -- something the person has; the timeline is where a deletion shows up.
  owned AS (
    SELECT w.*
    FROM public.workspaces w
    JOIN people p ON p.id = w.owner_id
    WHERE w.deleted_at IS NULL
  ),
  -- The workspace created at signup, which is the one carrying the acquisition
  -- columns worth reading. Later workspaces are created from inside the product
  -- and their acquisition_* are all NULL by construction.
  primary_ws AS (
    SELECT DISTINCT ON (w.owner_id) w.*
    FROM owned w
    ORDER BY w.owner_id, w.created_at ASC
  ),
  -- Everything that is a max/min over ALL of a person's workspaces rather than
  -- over the first one: they can connect a mailbox in the second workspace.
  --
  -- THE ANALYTICS COLUMNS ARE NOT TRUSTED ON THEIR OWN, and the journey panel
  -- is what exposed it: for a customer who signed up in July they read 2 and 3
  -- September, six weeks after the mailbox and the key those dates are supposed
  -- to be about. They were only written from the day the funnel instrumentation
  -- shipped, so for everybody older they date the instrumentation and not the
  -- event, and a journey drawn from them reads as three steps taken out of
  -- order.
  --
  -- Each rung is therefore floored by something that PROVES the step happened,
  -- and by nothing else. Not by tidiness: every floor below is a definition.
  --   a mailbox row IS a connection      -> min(inboxes.created_at)
  --   an api key row IS a credential     -> min(api_keys.created_at)
  --   value activation IS a tool call, by its own definition, and so is
  --   technical activation               -> floors the first-call date
  -- Nothing is floored by a later rung in general, because that would invent an
  -- ordering rather than record one. What inconsistency survives is real, and
  -- the page prints it as out of order rather than hiding it.
  owned_rollup AS (
    SELECT
      w.owner_id,
      count(*)::int AS workspaces,
      bool_or(w.grandfathered) AS grandfathered,
      max(CASE w.plan
            WHEN 'enterprise' THEN 4 WHEN 'pro' THEN 3
            WHEN 'solo' THEN 2 WHEN 'personal' THEN 1 ELSE 0 END) AS plan_rank,
      least(
        min(w.analytics_first_inbox_connected_at),
        min(w.onboarding_inbox_connected_at),
        min(first_inbox.at)
      ) AS first_inbox_connected_at,
      least(
        min(w.analytics_first_credential_created_at),
        min(w.onboarding_credential_issued_at),
        min(first_key.at)
      ) AS first_credential_created_at,
      least(
        min(w.analytics_first_tool_used_at),
        min(w.onboarding_technical_activated_at),
        min(w.onboarding_value_activated_at)
      ) AS first_tool_used_at,
      min(w.onboarding_value_activated_at) AS value_activated_at
    FROM owned w
    LEFT JOIN LATERAL (
      SELECT min(i.created_at) AS at FROM public.inboxes i WHERE i.workspace_id = w.id
    ) first_inbox ON true
    LEFT JOIN LATERAL (
      SELECT min(k.created_at) AS at FROM public.api_keys k
      WHERE k.workspace_id = w.id AND k.kind IS NULL
    ) first_key ON true
    GROUP BY w.owner_id
  ),
  -- Seats on somebody else's workspace. Counted separately because none of the
  -- usage below can see them; see the header.
  memberships AS (
    SELECT m.user_id, count(*)::int AS memberships
    FROM public.workspace_members m
    JOIN public.workspaces w ON w.id = m.workspace_id
    JOIN people p ON p.id = m.user_id
    WHERE w.deleted_at IS NULL AND w.owner_id <> m.user_id
    GROUP BY m.user_id
  ),
  usage AS (
    SELECT
      w.owner_id AS user_id,
      count(*)::int AS calls,
      count(*) FILTER (WHERE a.status = 'success')::int AS successes,
      count(DISTINCT (a.created_at AT TIME ZONE 'utc')::date)
        FILTER (WHERE a.status = 'success')::int AS active_days,
      max(a.created_at) AS last_active_at
    FROM public.activity_log a
    JOIN owned w ON w.id = a.workspace_id
    CROSS JOIN bounds b
    WHERE a.created_at >= b.window_start
    GROUP BY w.owner_id
  ),
  inbox_rollup AS (
    SELECT
      w.owner_id AS user_id,
      count(*) FILTER (WHERE i.status = 'active')::int AS inboxes,
      count(*) FILTER (WHERE i.status <> 'active')::int AS inboxes_broken,
      string_agg(DISTINCT public.growth_inbox_label(i.provider, i.service), ', '
        ORDER BY public.growth_inbox_label(i.provider, i.service)) AS providers
    FROM public.inboxes i
    JOIN owned w ON w.id = i.workspace_id
    WHERE i.deleted_at IS NULL
    GROUP BY w.owner_id
  ),
  key_rollup AS (
    SELECT w.owner_id AS user_id, count(*)::int AS api_keys, max(k.last_used_at) AS key_last_used_at
    FROM public.api_keys k
    JOIN owned w ON w.id = k.workspace_id
    WHERE k.deleted_at IS NULL
      AND k.kind IS NULL
    GROUP BY w.owner_id
  ),
  -- All-time, not windowed: a cap rejection is the single most decision-shaped
  -- event in this schema and there are few enough of them to count forever.
  paywall AS (
    SELECT w.owner_id AS user_id, count(*)::int AS paywall_hits
    FROM public.usage_limit_events e
    JOIN owned w ON w.id = e.workspace_id
    GROUP BY w.owner_id
  ),
  entitlement AS (
    SELECT
      e.user_id,
      coalesce(e.kind = 'comped_scale' AND (e.expires_at IS NULL OR e.expires_at > now()), false) AS is_comped,
      coalesce(e.unlimited_inboxes, false) AS unlimited_inboxes
    FROM public.user_usage_entitlements e
    JOIN people p ON p.id = e.user_id
  )
  SELECT
    u.id,
    u.email,
    nullif(u.display_name, ''),
    u.avatar_url,
    u.created_at,
    public.growth_is_internal_email(u.email),
    u.unsubscribed_at,
    u.unsubscribed_categories,

    coalesce(o.workspaces, 0),
    coalesce(m.memberships, 0),
    pw.id,
    coalesce(nullif(pw.display_name, ''), pw.slug),
    pw.slug,
    CASE coalesce(o.plan_rank, 0)
      WHEN 4 THEN 'enterprise' WHEN 3 THEN 'pro'
      WHEN 2 THEN 'solo' WHEN 1 THEN 'personal' ELSE 'free' END,
    coalesce(ent.is_comped, false),
    coalesce(ent.unlimited_inboxes, false),
    coalesce(o.grandfathered, false),

    pw.acquisition_source,
    pw.acquisition_utm_source,
    pw.acquisition_utm_medium,
    pw.acquisition_utm_campaign,
    pw.acquisition_landing_path,
    pw.acquisition_referrer,
    pw.acquisition_locale,

    pw.onboarding_stage,
    coalesce(pw.onboarding_client, pw.analytics_first_tool_client),
    o.first_inbox_connected_at,
    pw.analytics_first_inbox_provider,
    o.first_credential_created_at,
    pw.analytics_first_credential_method,
    o.first_tool_used_at,
    pw.analytics_first_tool_name,
    pw.analytics_first_tool_client,
    o.value_activated_at,

    coalesce(ib.inboxes, 0),
    coalesce(ib.inboxes_broken, 0),
    ib.providers,
    coalesce(k.api_keys, 0),
    k.key_last_used_at,

    coalesce(us.calls, 0),
    coalesce(us.successes, 0),
    coalesce(us.active_days, 0),
    us.last_active_at,
    coalesce(pay.paywall_hits, 0),

    b.plan,
    b.subscription_status,
    b.stripe_customer_id,
    b.current_period_end,

    count(*) OVER ()::int
  FROM people u
  LEFT JOIN owned_rollup o ON o.owner_id = u.id
  LEFT JOIN memberships m ON m.user_id = u.id
  LEFT JOIN primary_ws pw ON pw.owner_id = u.id
  LEFT JOIN inbox_rollup ib ON ib.user_id = u.id
  LEFT JOIN key_rollup k ON k.user_id = u.id
  LEFT JOIN usage us ON us.user_id = u.id
  LEFT JOIN paywall pay ON pay.user_id = u.id
  LEFT JOIN entitlement ent ON ent.user_id = u.id
  LEFT JOIN public.user_billing b ON b.user_id = u.id
  ORDER BY u.created_at DESC
  LIMIT greatest(coalesce(p_limit, 2000), 1);
$$;


-- ---------------------------------------------------------------------------
-- growth_user_workspaces: the api_keys count ignores the hidden key
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.growth_user_workspaces(p_user_id uuid, p_days int)
RETURNS TABLE (
  workspace_id uuid,
  name text,
  slug text,
  role text,
  plan text,
  grandfathered boolean,
  created_at timestamptz,
  deleted_at timestamptz,
  onboarding_stage text,
  inbox_connected_at timestamptz,
  credential_created_at timestamptz,
  first_tool_used_at timestamptz,
  value_activated_at timestamptz,
  acquisition_source text,
  acquisition_utm_source text,
  acquisition_utm_medium text,
  acquisition_utm_campaign text,
  acquisition_landing_path text,
  acquisition_referrer text,
  members int,
  inboxes int,
  api_keys int,
  calls int,
  successes int,
  last_active_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT ((((now() AT TIME ZONE 'utc')::date - (greatest(coalesce(p_days, 90), 1) - 1))::timestamp)
      AT TIME ZONE 'utc') AS window_start
  ),
  scoped AS (
    SELECT w.*, 'owner'::text AS role FROM public.workspaces w WHERE w.owner_id = p_user_id
    UNION
    SELECT w.*, 'member'::text AS role
    FROM public.workspaces w
    JOIN public.workspace_members m ON m.workspace_id = w.id
    WHERE m.user_id = p_user_id AND w.owner_id <> p_user_id
  )
  SELECT
    s.id,
    coalesce(nullif(s.display_name, ''), s.slug),
    s.slug,
    s.role,
    coalesce(s.plan, 'free'),
    s.grandfathered,
    s.created_at,
    s.deleted_at,
    s.onboarding_stage,
    s.analytics_first_inbox_connected_at,
    s.analytics_first_credential_created_at,
    s.analytics_first_tool_used_at,
    s.onboarding_value_activated_at,
    s.acquisition_source,
    s.acquisition_utm_source,
    s.acquisition_utm_medium,
    s.acquisition_utm_campaign,
    s.acquisition_landing_path,
    s.acquisition_referrer,
    (SELECT count(*)::int FROM public.workspace_members mm WHERE mm.workspace_id = s.id),
    (SELECT count(*)::int FROM public.inboxes i WHERE i.workspace_id = s.id AND i.deleted_at IS NULL),
    (SELECT count(*)::int FROM public.api_keys k
      WHERE k.workspace_id = s.id AND k.deleted_at IS NULL AND k.kind IS NULL),
    (SELECT count(*)::int FROM public.activity_log a, bounds b
      WHERE a.workspace_id = s.id AND a.created_at >= b.window_start),
    (SELECT count(*)::int FROM public.activity_log a, bounds b
      WHERE a.workspace_id = s.id AND a.created_at >= b.window_start AND a.status = 'success'),
    (SELECT max(a.created_at) FROM public.activity_log a, bounds b
      WHERE a.workspace_id = s.id AND a.created_at >= b.window_start)
  FROM scoped s
  ORDER BY s.created_at ASC;
$$;


-- ---------------------------------------------------------------------------
-- growth_user_timeline: no "API key created/revoked" event for the hidden key
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
    SELECT e.occurred_at, 'paywall', 'Action cap rejected a call',
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


-- ---------------------------------------------------------------------------
-- revoke_dormant_oauth_grants: never selects the hidden key
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_dormant_oauth_grants(
  p_idle_days integer DEFAULT 90,
  p_dry_run   boolean DEFAULT false
)
RETURNS TABLE (
  grants_selected        integer,
  access_tokens_revoked  integer,
  refresh_tokens_revoked integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_now    timestamptz := now();
  v_cutoff timestamptz;
  v_rec    record;
  v_keys   integer := 0;
  v_chain  integer := 0;
  v_hit    integer;
BEGIN
  -- A caller-supplied threshold this short would revoke live connections, and
  -- there is no legitimate reason to ask for it. Refusing loudly beats
  -- discovering it in the audit log afterwards.
  IF p_idle_days IS NULL OR p_idle_days < 30 THEN
    RAISE EXCEPTION 'revoke_dormant_oauth_grants: refusing an idle threshold of % days (minimum 30)', p_idle_days;
  END IF;

  v_cutoff := v_now - make_interval(days => p_idle_days);

  grants_selected        := 0;
  access_tokens_revoked  := 0;
  refresh_tokens_revoked := 0;

  -- ── Grants that hang off an api_keys row (everything issued since June) ──
  --
  -- Grouped by the key, so one grant is one iteration however many live rows
  -- its chain has, and judged on max(activity) across the whole group.
  FOR v_rec IN
    SELECT
      rt.api_key_id,
      max(GREATEST(
        rt.created_at,
        COALESCE(k.last_used_at, k.created_at, rt.created_at)
      ))                            AS last_activity_at,
      min(rt.workspace_id::text)    AS workspace_id,
      min(rt.user_id::text)         AS user_id,
      min(rt.client_id)             AS client_id,
      min(rt.client_name)           AS client_name,
      min(k.key_prefix)             AS key_prefix,
      count(*)::integer             AS live_chain_rows
    FROM public.oauth_refresh_tokens rt
    JOIN public.api_keys k ON k.id = rt.api_key_id
    WHERE rt.revoked_at IS NULL
      AND k.kind IS NULL
    GROUP BY rt.api_key_id
    HAVING max(GREATEST(
             rt.created_at,
             COALESCE(k.last_used_at, k.created_at, rt.created_at)
           )) < v_cutoff
  LOOP
    grants_selected := grants_selected + 1;
    CONTINUE WHEN p_dry_run;

    -- Half one: the access token. Soft delete, never a hard delete: activity_log
    -- rows reference api_key_id and would lose their foreign key.
    UPDATE public.api_keys
       SET deleted_at = v_now
     WHERE id = v_rec.api_key_id
       AND deleted_at IS NULL;
    GET DIAGNOSTICS v_hit = ROW_COUNT;
    v_keys := v_keys + v_hit;

    -- Half two: every live row of the chain, not just the newest.
    UPDATE public.oauth_refresh_tokens
       SET revoked_at = v_now
     WHERE api_key_id = v_rec.api_key_id
       AND revoked_at IS NULL;
    GET DIAGNOSTICS v_hit = ROW_COUNT;
    v_chain := v_chain + v_hit;

    -- The line that answers "why did my connector stop working". Everything
    -- needed to reconstruct the decision is here: what we judged, against what
    -- threshold, and what it cost.
    INSERT INTO public.auth_logs (event_type, workspace_id, user_id, metadata)
    VALUES (
      'oauth_grant_auto_revoked',
      v_rec.workspace_id::uuid,
      v_rec.user_id::uuid,
      jsonb_build_object(
        'reason',                 'dormant_refresh_token',
        'api_key_id',             v_rec.api_key_id,
        'key_prefix',             v_rec.key_prefix,
        'client_id',              v_rec.client_id,
        'client_name',            v_rec.client_name,
        'last_activity_at',       v_rec.last_activity_at,
        'idle_days',              floor(extract(epoch FROM (v_now - v_rec.last_activity_at)) / 86400)::integer,
        'idle_threshold_days',    p_idle_days,
        'live_chain_rows',        v_rec.live_chain_rows,
        'revoked_by',             'revoke_dormant_oauth_grants'
      )
    );
  END LOOP;

  -- ── Legacy chains with no api_key_id ────────────────────────────────────
  --
  -- Issued before a connection was linked to a single api_keys row. There is no
  -- key to revoke, so the chain IS the whole grant, and its own created_at is
  -- the only activity signal that exists for it.
  FOR v_rec IN
    SELECT rt.id, rt.created_at AS last_activity_at, rt.workspace_id, rt.user_id,
           rt.client_id, rt.client_name
    FROM public.oauth_refresh_tokens rt
    WHERE rt.revoked_at IS NULL
      AND rt.api_key_id IS NULL
      AND rt.created_at < v_cutoff
  LOOP
    grants_selected := grants_selected + 1;
    CONTINUE WHEN p_dry_run;

    UPDATE public.oauth_refresh_tokens
       SET revoked_at = v_now
     WHERE id = v_rec.id
       AND revoked_at IS NULL;
    GET DIAGNOSTICS v_hit = ROW_COUNT;
    v_chain := v_chain + v_hit;

    INSERT INTO public.auth_logs (event_type, workspace_id, user_id, metadata)
    VALUES (
      'oauth_grant_auto_revoked',
      v_rec.workspace_id,
      v_rec.user_id,
      jsonb_build_object(
        'reason',              'dormant_refresh_token',
        'api_key_id',          NULL,
        'refresh_token_id',    v_rec.id,
        'client_id',           v_rec.client_id,
        'client_name',         v_rec.client_name,
        'last_activity_at',    v_rec.last_activity_at,
        'idle_days',           floor(extract(epoch FROM (v_now - v_rec.last_activity_at)) / 86400)::integer,
        'idle_threshold_days', p_idle_days,
        'revoked_by',          'revoke_dormant_oauth_grants'
      )
    );
  END LOOP;

  access_tokens_revoked  := v_keys;
  refresh_tokens_revoked := v_chain;

  IF grants_selected > 0 THEN
    RAISE LOG 'revoke_dormant_oauth_grants: % grants over % days (dry_run=%), % keys and % refresh rows revoked',
      grants_selected, p_idle_days, p_dry_run, v_keys, v_chain;
  END IF;

  RETURN NEXT;
END;
$fn$;


-- ---------------------------------------------------------------------------
-- Grants: unchanged posture, re-stated. Service role only.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.growth_user_directory(int, int, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_user_directory(int, int, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.growth_user_workspaces(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_user_workspaces(uuid, int) TO service_role;
REVOKE ALL ON FUNCTION public.growth_user_timeline(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.growth_user_timeline(uuid, int) TO service_role;
REVOKE EXECUTE ON FUNCTION public.revoke_dormant_oauth_grants(integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.revoke_dormant_oauth_grants(integer, boolean) TO service_role;
